//! AI-powered commit message generation.
//!
//! Reuses the existing four provider stream functions (chat / responses /
//! anthropic / gemini) so that whichever `request_method` the active API
//! config uses, the request is dispatched correctly.
//!
//! Unlike the normal chat flow this module:
//! - Uses the **basic model** instead of the advanced model.
//! - Does **not** persist anything to the conversation database.
//! - Does **not** inject the built-in system prompt or load context history.

use napi::bindgen_prelude::*;
use tokio_util::sync::CancellationToken;

use crate::api::anthropic::create_anthropic_response_stream;
use crate::api::chat::create_chat_completion_response_stream;
use crate::api::config::get_active_api_request_context;
use crate::api::gemini::create_gemini_response_stream;
use crate::api::responses::{
    create_response_stream_with_context, ResponsesApiRequest, ResponsesApiResult,
    ResponsesApiStreamCallback,
};

/// Build a `ResponsesApiRequest` for commit-message generation, forcing the
/// basic model.
fn build_request(staged_diff: &str, system_prompt: &str) -> ResponsesApiRequest {
    let diff_content = staged_diff;

    ResponsesApiRequest {
        messages: vec![
            crate::api::responses::ResponsesApiMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            },
            crate::api::responses::ResponsesApiMessage {
                role: "user".to_string(),
                content: format!(
                    "Here is the staged diff:\n\n```\n{}\n```",
                    diff_content
                ),
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            },
        ],
        // Force the basic model for this lightweight task.
        model: None, // will be set after resolving context
        conversation_id: None,
        previous_response_id: None,
        directory_id: None,
        checkpoint_id: None,
        context_compaction: None,
        sub_agent_tools_json: None,
        sub_agent_config_profile: None,
        skip_context: Some(true),
        plan_mode: None,
        goal_mode: None,
    }
}

/// Generate a commit message by streaming from the active API config's basic
/// model via whichever provider the config specifies.
///
/// Returns the `ResponsesApiResult` (we only care about `.content`).
pub async fn generate_commit_message_stream(
    staged_diff: String,
    on_chunk: ResponsesApiStreamCallback,
    cancel_token: CancellationToken,
) -> Result<ResponsesApiResult> {
    // --- 1. Resolve active API config ---
    let context = tokio::task::spawn_blocking(get_active_api_request_context)
        .await
        .map_err(|join_error| {
            Error::from_reason(format!(
                "Failed to resolve API configuration: {join_error}"
            ))
        })??;

    let api_config = &context.api_config;

    // --- 2. Validate config ---
    let api_key = api_config.api_key.trim();
    if api_key.is_empty() {
        return Err(Error::from_reason(
            "API key not configured. Please configure API settings first.",
        ));
    }

    let basic_model = api_config.basic_model.trim();
    if basic_model.is_empty() {
        return Err(Error::from_reason(
            "Basic model not configured. Please configure API settings first.",
        ));
    }

    // --- 3. Build request with basic model ---
    // 提示词可被用户覆盖：有覆盖用覆盖，无覆盖用内置默认值。
    let database_path = context.database_path;
    let commit_prompt =
        crate::storage::services::feature_prompts::resolve_feature_prompt(
            &database_path,
            crate::storage::services::feature_prompts::PROMPT_KEY_COMMIT_MESSAGE,
        );
    let mut request = build_request(&staged_diff, &commit_prompt);
    request.model = Some(basic_model.to_string());

    // --- 4. Dispatch to the correct provider ---
    // We reuse the four provider stream functions directly.  Each one calls
    // prepare_context_request internally, which will create a throwaway
    // conversation id (no history loaded).  The store_chat_exchange call at
    // the end of each provider will persist a conversation, but that is
    // acceptable — it is a lightweight single exchange.
    let request_method = context.api_config.request_method.clone();
    let api_config = context.api_config;
    let custom_headers = context.custom_headers;

    let result = match request_method.as_str() {
        "chat" => {
            create_chat_completion_response_stream(
                request,
                database_path,
                api_config,
                custom_headers,
                on_chunk,
                cancel_token,
            )
            .await
        }
        "responses" => {
            create_response_stream_with_context(
                request,
                database_path,
                api_config,
                custom_headers,
                on_chunk,
                cancel_token,
            )
            .await
        }
        "anthropic" => {
            create_anthropic_response_stream(
                request,
                database_path,
                api_config,
                custom_headers,
                on_chunk,
                cancel_token,
            )
            .await
        }
        "gemini" => {
            create_gemini_response_stream(
                request,
                database_path,
                api_config,
                custom_headers,
                on_chunk,
                cancel_token,
            )
            .await
        }
        request_method => Err(Error::from_reason(format!(
            "Unsupported request method '{}'. Please switch the active API request method to Chat, Responses, Anthropic or Gemini.",
            request_method
        ))),
    };

    result
}
