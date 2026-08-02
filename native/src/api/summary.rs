use std::collections::HashMap;

use napi::bindgen_prelude::*;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use crate::api::config::{
    get_active_api_request_context, normalize_base_url, resolve_sdk_api_base_url,
    DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_GEMINI_BASE_URL, DEFAULT_OPENAI_BASE_URL,
};
use crate::api::retry::{RetryOptions, should_retry};
use crate::storage::services::chat_conversations::{load_context_messages, update_conversation_summary};

/// Generate a conversation summary (title) via the configured basic model.
///
/// `cancel_token` allows the caller to abort the in-flight non-streaming
/// HTTP request. When cancelled, the function returns immediately WITHOUT
/// executing `update_conversation_summary`, so the SQLite write transaction
/// never runs and the database lock is released for a subsequent
/// delete/truncate. This is critical for the cancel-then-rollback flow:
/// without cancellation, the summary HTTP request (which may be retrying)
/// holds the promise and forces rollback to wait — and if it finally
/// commits the UPDATE after the delete starts, the database locks.
pub async fn generate_conversation_summary(
    conversation_id: String,
    cancel_token: CancellationToken,
) -> Result<String> {
    let context = get_active_api_request_context()?;
    let database_path = context.database_path;
    let api_config = context.api_config;
    let custom_headers = context.custom_headers;

    // 提示词可被用户覆盖：有覆盖用覆盖，无覆盖用内置默认值。
    let system_prompt =
        crate::storage::services::feature_prompts::resolve_feature_prompt(
            &database_path,
            crate::storage::services::feature_prompts::PROMPT_KEY_SUMMARY,
        );

    let messages = load_context_messages(&database_path, &conversation_id)?;
    if messages.is_empty() {
        return Ok(String::new());
    }

    let model = api_config.basic_model.trim();
    if model.is_empty() {
        return Err(Error::from_reason(
            "Basic model not configured. Please configure a basic model in API settings.",
        ));
    }

    let api_key = api_config.api_key.trim();
    if api_key.is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let retry_options = RetryOptions::from_config(api_config.max_retries, api_config.retry_base_delay_ms);

    // Race the HTTP request against the cancellation token. When the token
    // fires, we drop the in-flight request future and return an empty string
    // WITHOUT touching the database, so no write transaction is opened.
    //
    // The HTTP future is wrapped in an async block so all match arms share a
    // single concrete future type (each generate_summary_via_* returns a
    // distinct opaque `impl Future`, which cannot be mixed in a match placed
    // directly inside `tokio::select!`).
    let summary_text = tokio::select! {
        _ = cancel_token.cancelled() => return Ok(String::new()),
        result = async {
            match api_config.request_method.as_str() {
                "responses" => generate_summary_via_responses(
                    &api_config,
                    &api_key,
                    &custom_headers,
                    model,
                    &system_prompt,
                    &messages,
                    &retry_options,
                ).await,
                "anthropic" => generate_summary_via_anthropic(
                    &api_config,
                    &api_key,
                    &custom_headers,
                    model,
                    &system_prompt,
                    &messages,
                    &retry_options,
                ).await,
                "gemini" => generate_summary_via_gemini(
                    &api_config,
                    &api_key,
                    &custom_headers,
                    model,
                    &system_prompt,
                    &messages,
                    &retry_options,
                ).await,
                _ => generate_summary_via_chat(
                    &api_config,
                    &api_key,
                    &custom_headers,
                    model,
                    &system_prompt,
                    &messages,
                    &retry_options,
                ).await,
            }
        } => result?,
    };

    let trimmed = summary_text.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    // Double-check cancellation right before the write transaction. Even
    // though the select! above already short-circuits, a token that was
    // cancelled while the HTTP future was resolving will be caught here.
    if cancel_token.is_cancelled() {
        return Ok(String::new());
    }

    // Best-effort write. If the conversation was concurrently deleted/truncated
    // (e.g. user rolled back), this UPDATE would race and could lock the
    // database. Swallow the error so a late summary does not propagate a
    // failure that surfaces as "database is locked" in unrelated flows.
    let _ = update_conversation_summary(&database_path, &conversation_id, trimmed);

    Ok(trimmed.to_string())
}

async fn generate_summary_via_chat(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    messages: &[crate::storage::services::chat_conversations::ChatContextMessage],
    retry_options: &RetryOptions,
) -> Result<String> {
    let endpoint = resolve_chat_endpoint(api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let chat_messages = build_summary_chat_messages(messages, system_prompt);
    let payload = json!({
        "model": model,
        "messages": chat_messages,
        "stream": false,
        "max_tokens": 4096,
        "reasoning_effort": "none",
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_api_request_with_retry(
        &client,
        &endpoint,
        build_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    let content = body
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("");

    Ok(content.to_string())
}

async fn generate_summary_via_responses(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    messages: &[crate::storage::services::chat_conversations::ChatContextMessage],
    retry_options: &RetryOptions,
) -> Result<String> {
    let base_url = normalize_base_url(&api_config.base_url);
    if base_url.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let resolved_base = resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode);
    let endpoint = format!("{}/responses", resolved_base);

    let input = build_summary_responses_input(messages, system_prompt);
    let payload = json!({
        "model": model,
        "input": input,
        "stream": false,
        "reasoning": {"effort": "none"},
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_api_request_with_retry(
        &client,
        &endpoint,
        build_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    let content = extract_responses_content(&body);

    Ok(content)
}

async fn generate_summary_via_anthropic(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    messages: &[crate::storage::services::chat_conversations::ChatContextMessage],
    retry_options: &RetryOptions,
) -> Result<String> {
    let endpoint = resolve_anthropic_endpoint(api_config);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let conversation_text = build_conversation_text(messages);
    let payload = json!({
        "model": model,
        "max_tokens": 4096,
        "stream": false,
        "system": system_prompt,
        "messages": [{"role": "user", "content": conversation_text}],
        "thinking": {"type": "disabled"},
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_api_request_with_retry(
        &client,
        &endpoint,
        build_anthropic_header_map(api_key, custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    let content = extract_anthropic_content(&body);

    Ok(content)
}

async fn generate_summary_via_gemini(
    api_config: &crate::storage::ApiConfigRecord,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    model: &str,
    system_prompt: &str,
    messages: &[crate::storage::services::chat_conversations::ChatContextMessage],
    retry_options: &RetryOptions,
) -> Result<String> {
    let endpoint = resolve_gemini_endpoint(api_config, model, api_key);
    if endpoint.is_empty() {
        return Err(Error::from_reason(
            "Base URL not configured. Please configure API settings first.",
        ));
    }

    let conversation_text = build_conversation_text(messages);
    let payload = json!({
        "systemInstruction": {
            "parts": [{"text": system_prompt}]
        },
        "contents": [{
            "role": "user",
            "parts": [{"text": conversation_text}]
        }],
        "generationConfig": {
            "maxOutputTokens": 4096,
            "thinkingConfig": {"thinkingBudget": 0}
        }
    });

    let client = crate::api::http_client::build_proxied_client().await?;

    let body: Value = send_api_request_with_retry(
        &client,
        &endpoint,
        build_gemini_header_map(custom_headers)?,
        &payload,
        retry_options,
    )
    .await?;

    let content = extract_gemini_content(&body);

    Ok(content)
}

/// Send a non-streaming API request with retry logic.
/// Wraps the HTTP send + status check + JSON parse in a retry loop.
/// Shared by summary generation and other internal API helpers.
pub(crate) async fn send_api_request_with_retry(
    client: &reqwest::Client,
    endpoint: &str,
    headers: reqwest::header::HeaderMap,
    payload: &Value,
    retry_options: &RetryOptions,
) -> Result<Value> {
    let mut attempt: u32 = 0;
    loop {
        let response = client
            .post(endpoint)
            .headers(headers.clone())
            .json(payload)
            .send()
            .await
            .map_err(|error| {
                Error::from_reason(format!("API request failed: {}", error))
            });

        match response {
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    let error_body = response.text().await.unwrap_or_default();
                    let error = Error::from_reason(format!(
                        "API request failed: {} {}",
                        status, error_body
                    ));

                    if !should_retry(&error, attempt, retry_options) {
                        return Err(error);
                    }

                    attempt += 1;
                    let delay = std::time::Duration::from_millis(retry_options.base_delay_ms);
                    tokio::time::sleep(delay).await;
                    continue;
                }

                let body: Value = response
                    .json()
                    .await
                    .map_err(|error| {
                        Error::from_reason(format!(
                            "Failed to parse API response: {}",
                            error
                        ))
                    })?;

                return Ok(body);
            }
            Err(error) => {
                if !should_retry(&error, attempt, retry_options) {
                    return Err(error);
                }

                attempt += 1;
                let delay = std::time::Duration::from_millis(retry_options.base_delay_ms);
                tokio::time::sleep(delay).await;
                continue;
            }
        }
    }
}

fn build_conversation_text(
    messages: &[crate::storage::services::chat_conversations::ChatContextMessage],
) -> String {
    messages
        .iter()
        .filter_map(|message| {
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }
            let role = normalize_role(&message.role);
            Some(format!("{}: {}", role, content))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_anthropic_content(body: &Value) -> String {
    let Some(content_array) = body.get("content").and_then(Value::as_array) else {
        return String::new();
    };

    // Only `text` blocks carry the final answer. `thinking` /
    // `redacted_thinking` blocks are the model's internal reasoning and must
    // never be adopted as the summary.
    for block in content_array {
        let block_type = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if block_type == "text" {
            if let Some(text) = block
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                return text.to_string();
            }
        }
    }

    // Fallback for gateways that omit the `type` field: accept a block with a
    // non-empty `text` only when it is clearly not a thinking block.
    for block in content_array {
        let block_type = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if block_type == "thinking" || block_type == "redacted_thinking" {
            continue;
        }
        if let Some(text) = block
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            return text.to_string();
        }
    }

    String::new()
}

fn extract_gemini_content(body: &Value) -> String {
    let Some(candidates) = body.get("candidates").and_then(Value::as_array) else {
        return String::new();
    };
    let Some(candidate) = candidates.first() else {
        return String::new();
    };
    let Some(parts) = candidate
        .get("content")
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };

    // Gemini thinking models emit internal reasoning as text parts flagged
    // with `"thought": true`, usually placed BEFORE the final answer. Only the
    // main text (正文) is adopted as the summary; thought parts are skipped.
    for part in parts {
        if part.get("thought").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        if let Some(text) = part
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            return text.to_string();
        }
    }

    String::new()
}

pub(crate) fn resolve_anthropic_endpoint(api_config: &crate::storage::ApiConfigRecord) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    let base_url = if normalized_base_url == DEFAULT_OPENAI_BASE_URL {
        DEFAULT_ANTHROPIC_BASE_URL.to_string()
    } else {
        normalized_base_url
    };

    if api_config.base_url_mode == "endpoint" {
        return base_url;
    }

    let resolved_base = resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode);
    format!("{}/messages", resolved_base)
}

pub(crate) fn resolve_gemini_endpoint(
    api_config: &crate::storage::ApiConfigRecord,
    model: &str,
    api_key: &str,
) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    let base_url = if normalized_base_url == DEFAULT_OPENAI_BASE_URL {
        DEFAULT_GEMINI_BASE_URL.to_string()
    } else {
        normalized_base_url
    };

    let resolved_base = if api_config.base_url_mode == "endpoint" {
        base_url
    } else {
        resolve_sdk_api_base_url(&base_url, &api_config.base_url_mode)
    };

    let clean_model = model.strip_prefix("models/").unwrap_or(model);

    let mut url = format!(
        "{}/models/{}:generateContent",
        resolved_base, clean_model
    );

    if !api_key.is_empty() {
        url.push_str(&format!("?key={}", api_key));
    }

    url
}

pub(crate) fn build_anthropic_header_map(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).map_err(|error| {
            Error::from_reason(format!("Invalid API key header value: {}", error))
        })?,
    );

    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        if trimmed_key.eq_ignore_ascii_case("content-type")
            || trimmed_key.eq_ignore_ascii_case("accept-encoding")
            || trimmed_key.eq_ignore_ascii_case("x-api-key")
        {
            continue;
        }

        let header_name = trimmed_key.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!("Invalid custom header '{}': {}", trimmed_key, error))
        })?;
        let header_value = HeaderValue::from_str(trimmed_value).map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header value for '{}': {}",
                trimmed_key, error
            ))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(headers)
}

pub(crate) fn build_gemini_header_map(
    custom_headers: &HashMap<String, String>,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));

    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        if trimmed_key.eq_ignore_ascii_case("content-type")
            || trimmed_key.eq_ignore_ascii_case("accept-encoding")
        {
            continue;
        }

        let header_name = trimmed_key.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!("Invalid custom header '{}': {}", trimmed_key, error))
        })?;
        let header_value = HeaderValue::from_str(trimmed_value).map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header value for '{}': {}",
                trimmed_key, error
            ))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(headers)
}

pub(crate) fn resolve_chat_endpoint(api_config: &crate::storage::ApiConfigRecord) -> String {
    let normalized_base_url = normalize_base_url(&api_config.base_url);
    if normalized_base_url.is_empty() {
        return String::new();
    }

    if api_config.base_url_mode == "endpoint" {
        normalized_base_url
    } else {
        format!(
            "{}/chat/completions",
            resolve_sdk_api_base_url(&normalized_base_url, &api_config.base_url_mode)
        )
    }
}

fn build_summary_chat_messages(
    messages: &[crate::storage::services::chat_conversations::ChatContextMessage],
    system_prompt: &str,
) -> Vec<Value> {
    let conversation_text = messages
        .iter()
        .filter_map(|message| {
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }
            let role = normalize_role(&message.role);
            Some(format!("{}: {}", role, content))
        })
        .collect::<Vec<_>>()
        .join("\n");

    vec![
        json!({
            "role": "system",
            "content": system_prompt,
        }),
        json!({
            "role": "user",
            "content": conversation_text,
        }),
    ]
}

fn build_summary_responses_input(
    messages: &[crate::storage::services::chat_conversations::ChatContextMessage],
    system_prompt: &str,
) -> Vec<Value> {
    let conversation_text = messages
        .iter()
        .filter_map(|message| {
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }
            let role = normalize_role(&message.role);
            Some(format!("{}: {}", role, content))
        })
        .collect::<Vec<_>>()
        .join("\n");

    vec![
        json!({
            "type": "message",
            "role": "system",
            "content": system_prompt,
        }),
        json!({
            "type": "message",
            "role": "user",
            "content": conversation_text,
        }),
    ]
}

fn extract_responses_content(body: &Value) -> String {
    // The top-level `output_text` field is the concatenation of the final
    // assistant text only; it never contains reasoning/thinking content, so it
    // is the preferred source for the summary (正文).
    if let Some(text) = body
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return text.to_string();
    }

    if let Some(output) = body.get("output").and_then(Value::as_array) {
        for item in output {
            // Reasoning output items carry the model's internal thinking and
            // must never be adopted as the summary.
            let item_type = item
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if item_type == "reasoning" {
                continue;
            }

            if let Some(content) = item.get("content").and_then(Value::as_array) {
                for part in content {
                    // Skip reasoning/thinking parts; only the main text (正文)
                    // is adopted.
                    let part_type = part
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if part_type == "reasoning_text" || part_type == "summary_text" {
                        continue;
                    }

                    if let Some(text) = part
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                    {
                        return text.to_string();
                    }
                    if let Some(text) = part
                        .get("output_text")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                    {
                        return text.to_string();
                    }
                }
            }
        }
    }

    String::new()
}

fn normalize_role(role: &str) -> &str {
    match role.trim() {
        "assistant" => "Assistant",
        "system" => "System",
        "developer" => "Developer",
        _ => "User",
    }
}

pub(crate) fn build_header_map(api_key: &str, custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|error| {
            Error::from_reason(format!("Invalid authorization header value: {}", error))
        })?,
    );

    for (key, value) in custom_headers {
        let trimmed_key = key.trim();
        let trimmed_value = value.trim();
        if trimmed_key.is_empty() || trimmed_value.is_empty() {
            continue;
        }

        if trimmed_key.eq_ignore_ascii_case("content-type")
            || trimmed_key.eq_ignore_ascii_case("accept-encoding")
            || trimmed_key.eq_ignore_ascii_case("authorization")
        {
            continue;
        }

        let header_name = trimmed_key.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!("Invalid custom header '{}': {}", trimmed_key, error))
        })?;
        let header_value = HeaderValue::from_str(trimmed_value).map_err(|error| {
            Error::from_reason(format!(
                "Invalid custom header value for '{}': {}",
                trimmed_key, error
            ))
        })?;
        headers.insert(header_name, header_value);
    }

    Ok(headers)
}
