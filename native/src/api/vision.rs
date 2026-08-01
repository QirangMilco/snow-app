use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::api::config::{normalize_base_url, resolve_sdk_api_base_url};
use crate::api::conversation::images::{parse_chat_message_content, ChatImage};
use crate::storage::services::chat_conversations::ChatContextMessage;
use crate::storage::ApiConfigRecord;

/// 进程内缓存：避免同一张图片在多轮对话中重复调用视觉模型。
/// Key 为图片 base64 数据的 blake3 哈希，Value 为文本化结果。
type VisionCache = Arc<RwLock<HashMap<String, String>>>;

fn global_cache() -> &'static VisionCache {
    static CACHE: std::sync::OnceLock<VisionCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
}

/// 判断当前 API 配置是否需要视觉文本化。
///
/// 触发条件：主模型不支持视觉 (`supports_vision == false`) 且
/// 配置了有效的视觉 API（`vision_api_key` 非空、`vision_model` 非空、
/// `vision_request_method` 属于四种支持的类型）。
pub fn should_textify_images(api_config: &ApiConfigRecord) -> bool {
    if api_config.supports_vision {
        return false;
    }

    let api_key = api_config.vision_api_key.trim();
    let model = api_config.vision_model.trim();
    let request_method = api_config.vision_request_method.trim();

    if api_key.is_empty() || model.is_empty() {
        return false;
    }

    matches!(
        request_method,
        "chat" | "responses" | "anthropic" | "gemini"
    )
}

/// 对消息列表中的图片进行视觉文本化。
///
/// 当 `should_textify_images` 返回 false 或 `skip_context` 为 true 时直接返回原消息。
/// 否则遍历每条消息，解析其中的 `@@image:...@@` 标签，对每张图片调用视觉模型
/// 获取文本描述，然后将图片标签替换为文本描述。
///
/// 该函数是异步的，不会阻塞 Node.js 主线程。子代理和主对话共用此入口。
///
/// `custom_headers` 复用主 API 上下文已解析的自定义请求头，避免重复查询数据库。
pub async fn textify_images_in_messages(
    messages: &mut [ChatContextMessage],
    database_path: &Path,
    api_config: &ApiConfigRecord,
    custom_headers: &HashMap<String, String>,
    skip_context: bool,
) -> Result<()> {
    if skip_context || !should_textify_images(api_config) {
        return Ok(());
    }

    let vision_config = VisionApiConfig::from(api_config, custom_headers)?;

    // 提示词可被用户覆盖：在入口解析一次，沿调用链逐层传参，
    // 4 个 provider 分支共用同一自定义提示词。
    let prompt_template = crate::storage::services::feature_prompts::resolve_feature_prompt(
        database_path,
        crate::storage::services::feature_prompts::PROMPT_KEY_VISION,
    );

    let client = crate::api::http_client::build_proxied_client()
        .await
        .map_err(|error| {
            Error::from_reason(format!("Failed to create vision HTTP client: {error}"))
        })?;

    for message in messages.iter_mut() {
        let content = message.content.clone();
        if !content.contains("@@image:") {
            continue;
        }

        let parsed = parse_chat_message_content(&content, database_path)?;
        if parsed.images.is_empty() {
            continue;
        }

        let textified =
            textify_parsed_content(&parsed, &client, &vision_config, &prompt_template).await?;
        message.content = textified;
    }

    Ok(())
}

struct VisionApiConfig {
    request_method: String,
    base_url: String,
    base_url_mode: String,
    api_key: String,
    model: String,
    custom_headers: HashMap<String, String>,
}

impl VisionApiConfig {
    fn from(
        api_config: &ApiConfigRecord,
        custom_headers: &HashMap<String, String>,
    ) -> Result<Self> {
        let request_method = api_config.vision_request_method.trim().to_string();
        let base_url = api_config.vision_base_url.trim().to_string();
        let base_url_mode = api_config.vision_base_url_mode.trim().to_string();
        let api_key = api_config.vision_api_key.trim().to_string();
        let model = api_config.vision_model.trim().to_string();

        if base_url.is_empty() {
            return Err(Error::from_reason(
                "Vision base URL is not configured. Please configure the vision API settings first.",
            ));
        }

        Ok(Self {
            request_method,
            base_url,
            base_url_mode,
            api_key,
            model,
            custom_headers: custom_headers.clone(),
        })
    }
}

async fn textify_parsed_content(
    parsed: &crate::api::conversation::images::ParsedChatMessageContent,
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    prompt_template: &str,
) -> Result<String> {
    let mut result = String::with_capacity(parsed.text.len() + parsed.images.len() * 256);
    result.push_str(&parsed.text);

    for image in &parsed.images {
        let description =
            describe_image(client, vision_config, image, &parsed.text, prompt_template).await?;
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str("[Image description: ");
        result.push_str(&description);
        result.push(']');
    }

    Ok(result.trim().to_string())
}

async fn describe_image(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
    prompt_template: &str,
) -> Result<String> {
    let cache_key = blake3::hash(image.data.as_bytes()).to_hex().to_string();

    if let Some(cached) = global_cache().read().await.get(&cache_key) {
        return Ok(cached.clone());
    }

    let description = match vision_config.request_method.as_str() {
        "chat" => describe_image_via_chat(client, vision_config, image, user_prompt, prompt_template).await?,
        "responses" => describe_image_via_responses(client, vision_config, image, user_prompt, prompt_template).await?,
        "anthropic" => describe_image_via_anthropic(client, vision_config, image, user_prompt, prompt_template).await?,
        "gemini" => describe_image_via_gemini(client, vision_config, image, user_prompt, prompt_template).await?,
        method => {
            return Err(Error::from_reason(format!(
                "Unsupported vision request method: {method}. Supported: chat, responses, anthropic, gemini."
            )));
        }
    };

    let trimmed = description.trim().to_string();
    global_cache()
        .write()
        .await
        .insert(cache_key, trimmed.clone());
    Ok(trimmed)
}

fn build_vision_prompt(prompt_template: &str, user_prompt: &str) -> String {
    let user_prompt = user_prompt.trim();
    if user_prompt.is_empty() {
        return prompt_template.to_string();
    }
    format!(
        "{prompt_template}\n\nUser context (use as additional guidance for what to focus on):\n{user_prompt}"
    )
}

async fn describe_image_via_chat(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
    prompt_template: &str,
) -> Result<String> {
    let endpoint = resolve_chat_endpoint(vision_config);
    let prompt = build_vision_prompt(prompt_template, user_prompt);
    let payload = json!({
        "model": vision_config.model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": image.data_url } },
            ],
        }],
        "max_tokens": 1024,
        "stream": false,
    });

    let headers = build_bearer_headers(&vision_config.api_key, &vision_config.custom_headers)?;
    let response = send_vision_request(client, &endpoint, headers, &payload).await?;
    extract_chat_content(&response)
}

async fn describe_image_via_responses(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
    prompt_template: &str,
) -> Result<String> {
    let endpoint = resolve_responses_endpoint(vision_config);
    let prompt = build_vision_prompt(prompt_template, user_prompt);
    let payload = json!({
        "model": vision_config.model,
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                { "type": "input_text", "text": prompt },
                { "type": "input_image", "image_url": image.data_url },
            ],
        }],
        "max_output_tokens": 1024,
        "stream": false,
        "store": false,
    });

    let headers = build_bearer_headers(&vision_config.api_key, &vision_config.custom_headers)?;
    let response = send_vision_request(client, &endpoint, headers, &payload).await?;
    extract_responses_content(&response)
}

async fn describe_image_via_anthropic(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
    prompt_template: &str,
) -> Result<String> {
    let endpoint = resolve_anthropic_endpoint(vision_config);
    let prompt = build_vision_prompt(prompt_template, user_prompt);
    let payload = json!({
        "model": vision_config.model,
        "max_tokens": 1024,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image.media_type,
                        "data": image.data,
                    },
                },
            ],
        }],
        "stream": false,
    });

    let headers = build_anthropic_headers(&vision_config.api_key, &vision_config.custom_headers)?;
    let response = send_vision_request(client, &endpoint, headers, &payload).await?;
    extract_anthropic_content(&response)
}

async fn describe_image_via_gemini(
    client: &reqwest::Client,
    vision_config: &VisionApiConfig,
    image: &ChatImage,
    user_prompt: &str,
    prompt_template: &str,
) -> Result<String> {
    let endpoint = resolve_gemini_endpoint(vision_config, &vision_config.api_key);
    let prompt = build_vision_prompt(prompt_template, user_prompt);
    let payload = json!({
        "contents": [{
            "role": "user",
            "parts": [
                { "text": prompt },
                {
                    "inlineData": {
                        "mimeType": image.media_type,
                        "data": image.data,
                    },
                },
            ],
        }],
        "generationConfig": { "maxOutputTokens": 1024 },
    });

    let headers = build_gemini_headers(&vision_config.custom_headers)?;
    let response = send_vision_request(client, &endpoint, headers, &payload).await?;
    extract_gemini_content(&response)
}

fn resolve_chat_endpoint(vision_config: &VisionApiConfig) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    if vision_config.base_url_mode == "endpoint" {
        return normalized;
    }
    format!(
        "{}/chat/completions",
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    )
}

fn resolve_responses_endpoint(vision_config: &VisionApiConfig) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    if vision_config.base_url_mode == "endpoint" {
        return normalized;
    }
    format!(
        "{}/responses",
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    )
}

fn resolve_anthropic_endpoint(vision_config: &VisionApiConfig) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    if vision_config.base_url_mode == "endpoint" {
        return normalized;
    }
    format!(
        "{}/messages",
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    )
}

fn resolve_gemini_endpoint(vision_config: &VisionApiConfig, api_key: &str) -> String {
    let normalized = normalize_base_url(&vision_config.base_url);
    let resolved_base = if vision_config.base_url_mode == "endpoint" {
        normalized
    } else {
        resolve_sdk_api_base_url(&normalized, &vision_config.base_url_mode)
    };

    let clean_model = vision_config
        .model
        .strip_prefix("models/")
        .unwrap_or(&vision_config.model);

    let mut url = format!(
        "{}/models/{}:generateContent",
        resolved_base, clean_model
    );

    if !api_key.is_empty() {
        url.push_str(&format!("?key={}", api_key));
    }
    url
}

fn build_bearer_headers(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!("Invalid vision authorization header value: {error}"))
        })?,
    );
    merge_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding", "authorization"],
    );
    Ok(headers)
}

fn build_anthropic_headers(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).map_err(|error| {
            Error::from_reason(format!("Invalid vision API key header value: {error}"))
        })?,
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!("Invalid vision authorization header value: {error}"))
        })?,
    );
    merge_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding", "authorization", "x-api-key"],
    );
    Ok(headers)
}

fn build_gemini_headers(custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    merge_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding"],
    );
    Ok(headers)
}

fn merge_custom_headers(
    headers: &mut HeaderMap,
    custom_headers: &HashMap<String, String>,
    reserved: &[&str],
) {
    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }
        if reserved
            .iter()
            .any(|reserved| trimmed_key.eq_ignore_ascii_case(reserved))
        {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            trimmed_key.parse::<HeaderName>(),
            HeaderValue::from_str(trimmed_value),
        ) {
            headers.insert(name, val);
        }
    }
}

async fn send_vision_request(
    client: &reqwest::Client,
    endpoint: &str,
    headers: HeaderMap,
    payload: &Value,
) -> Result<Value> {
    let response = client
        .post(endpoint)
        .headers(headers)
        .json(payload)
        .send()
        .await
        .map_err(|error| {
            Error::from_reason(format!("Failed to call vision API: {error}"))
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(Error::from_reason(format!(
            "Vision API request failed: {} {}",
            status,
            body.chars().take(500).collect::<String>()
        )));
    }

    serde_json::from_str::<Value>(&body).map_err(|error| {
        Error::from_reason(format!(
            "Failed to parse vision API response: {error}. Body: {}",
            body.chars().take(500).collect::<String>()
        ))
    })
}

fn extract_chat_content(response: &Value) -> Result<String> {
    response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            Error::from_reason(format!(
                "Vision Chat API response missing choices[0].message.content: {}",
                serde_json::to_string(response)
                    .unwrap_or_default()
                    .chars()
                    .take(300)
                    .collect::<String>()
            ))
        })
}

fn extract_responses_content(response: &Value) -> Result<String> {
    if let Some(text) = response
        .get("output_text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        return Ok(text.to_string());
    }

    let mut chunks = Vec::new();
    collect_responses_output_text(response.get("output"), &mut chunks);
    let text = chunks.join("\n").trim().to_string();

    if text.is_empty() {
        return Err(Error::from_reason(format!(
            "Vision Responses API response missing output_text: {}",
            serde_json::to_string(response)
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect::<String>()
        )));
    }
    Ok(text)
}

fn collect_responses_output_text(value: Option<&Value>, chunks: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::Array(items) => {
            for item in items {
                collect_responses_output_text(Some(item), chunks);
            }
        }
        Value::Object(object) => {
            for key in ["text", "output_text", "value"] {
                if let Some(text) = object
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    chunks.push(text.to_string());
                    return;
                }
            }
            collect_responses_output_text(object.get("content"), chunks);
        }
        _ => {}
    }
}

fn extract_anthropic_content(response: &Value) -> Result<String> {
    let mut chunks = Vec::new();
    if let Some(content) = response.get("content").and_then(Value::as_array) {
        for block in content {
            if block
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| value == "text")
            {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    chunks.push(text.to_string());
                }
            }
        }
    }

    let text = chunks.join("\n").trim().to_string();
    if text.is_empty() {
        return Err(Error::from_reason(format!(
            "Vision Anthropic API response missing content text: {}",
            serde_json::to_string(response)
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect::<String>()
        )));
    }
    Ok(text)
}

fn extract_gemini_content(response: &Value) -> Result<String> {
    let mut chunks = Vec::new();
    if let Some(candidates) = response.get("candidates").and_then(Value::as_array) {
        for candidate in candidates {
            if let Some(parts) = candidate
                .get("content")
                .and_then(|content| content.get("parts"))
                .and_then(Value::as_array)
            {
                for part in parts {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        chunks.push(text.to_string());
                    }
                }
            }
        }
    }

    let text = chunks.join("\n").trim().to_string();
    if text.is_empty() {
        return Err(Error::from_reason(format!(
            "Vision Gemini API response missing candidates text: {}",
            serde_json::to_string(response)
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect::<String>()
        )));
    }
    Ok(text)
}
