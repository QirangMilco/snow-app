use std::path::PathBuf;

use napi::bindgen_prelude::*;

use crate::api::anthropic::create_anthropic_response_stream;
use crate::api::chat::create_chat_completion_response_stream;
use crate::api::config::{
    get_api_request_context_for_profile, get_api_request_context_with_fallback,
};
use crate::api::gemini::create_gemini_response_stream;
use crate::api::responses::{
    create_response_stream_with_context, ResponsesApiRequest, ResponsesApiResult,
    ResponsesApiStreamCallback,
};
use crate::storage::services::app_logs::{insert_app_log, AppLogInput};
use crate::storage::services::chat_conversations::{
    get_conversation_api_profile, store_failed_chat_exchange, ChatContextMessage,
};
use crate::storage::services::usage_records::{record_usage, UsageRecordInput};

pub async fn create_response_stream(
    mut request: ResponsesApiRequest,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
) -> Result<ResponsesApiResult> {
    let is_sub_agent = request
        .sub_agent_tools_json
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();
    if is_sub_agent {
        // Plan Mode and Goal Mode belong exclusively to the main conversation.
        // Keep the provider prompt and request-scoped tool injection in normal
        // mode for every sub-agent, even if a caller accidentally forwards
        // plan_mode or goal_mode.
        request.plan_mode = Some(false);
        request.goal_mode = Some(false);
    }
    let sub_agent_config_profile = request
        .sub_agent_config_profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let explicit_api_profile = request
        .api_profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let request_conversation_id = request
        .conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    let context = tokio::task::spawn_blocking(move || {
        // A sub-agent request (non-empty sub_agent_tools_json) always resolves
        // its configured profile. A context-compaction request carries no tools
        // but may still target a sub-agent profile, so honour an explicit
        // profile here too — otherwise the handoff would wrongly fall back to
        // the active config instead of the sub-agent's own API configuration.
        if is_sub_agent || sub_agent_config_profile.is_some() {
            get_api_request_context_for_profile(sub_agent_config_profile.as_deref())
        } else {
            // Conversation-scoped profile resolution with graceful fallback:
            //   1. explicit apiProfile on the request (first message of a
            //      brand-new conversation binds its provider this way)
            //   2. the conversation's persisted api_profile_name binding
            //   3. the global active profile (legacy behaviour)
            let database_path = crate::storage::initialize_app_storage()
                .map(|storage_info| PathBuf::from(storage_info.database_path))
                .ok();
            let resolved_profile = explicit_api_profile.or_else(|| {
                request_conversation_id.as_deref().and_then(|conversation_id| {
                    database_path.as_ref().and_then(|database_path| {
                        get_conversation_api_profile(database_path, conversation_id)
                            .ok()
                            .flatten()
                    })
                })
            });
            get_api_request_context_with_fallback(resolved_profile.as_deref())
        }
    })
    .await
    .map_err(|join_error| {
        Error::from_reason(format!(
            "Failed to resolve API configuration: {join_error}"
        ))
    })??;
    if is_sub_agent
        && request
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        request.model = Some(context.api_config.advanced_model.clone());
    }

    let failure_messages = request
        .messages
        .iter()
        .map(|message| ChatContextMessage {
            role: message.role.clone(),
            content: message.content.clone(),
            tool_calls_json: None,
            tool_results_json: message.tool_results_json.clone(),
            thinking: message.thinking.clone(),
            thinking_blocks_json: message.thinking_blocks_json.clone(),
        })
        .collect::<Vec<_>>();
    let failure_conversation_id = request.conversation_id.clone();
    let failure_previous_response_id = request.previous_response_id.clone();
    let failure_checkpoint_id = request.checkpoint_id.clone().unwrap_or_default();
    let failure_model = request
        .model
        .clone()
        .unwrap_or_else(|| context.api_config.advanced_model.clone());
    let failure_directory_id = request.directory_id.clone().unwrap_or_default();
    let failure_context_compaction = request.context_compaction.unwrap_or(false);
    let failure_database_path = context.database_path.clone();
    // The profile that actually served this request. Persisted on failed
    // exchanges too so a conversation created by a failed first message is
    // still bound to the provider the user picked.
    let failure_api_profile = context.api_config.profile_name.clone();

    // Capture API config metadata for usage accounting. These are cloned
    // before `context` is moved into the provider call so they remain
    // available after the response returns.
    let usage_api_profile_name = context.api_config.profile_name.clone();
    let usage_api_config_id = context.api_config.id.clone();
    let usage_request_method = context.api_config.request_method.clone();
    let usage_database_path = context.database_path.clone();

    let cancel_token = crate::api::cancel::create_and_register(&stream_id);

    let result = match context.api_config.request_method.as_str() {
        "chat" => {
            create_chat_completion_response_stream(
                request,
                context.database_path,
                context.api_config,
                context.custom_headers,
                on_chunk,
                cancel_token.clone(),
            )
            .await
        }
        "responses" => {
            create_response_stream_with_context(
                request,
                context.database_path,
                context.api_config,
                context.custom_headers,
                on_chunk,
                cancel_token.clone(),
            )
            .await
        }
        "anthropic" => {
            create_anthropic_response_stream(
                request,
                context.database_path,
                context.api_config,
                context.custom_headers,
                on_chunk,
                cancel_token.clone(),
            )
            .await
        }
        "gemini" => {
            create_gemini_response_stream(
                request,
                context.database_path,
                context.api_config,
                context.custom_headers,
                on_chunk,
                cancel_token.clone(),
            )
            .await
        }
        request_method => Err(Error::from_reason(format!(
            "Unsupported chat request method '{}'. Please switch the active API request method to Chat, Responses, Anthropic or Gemini.",
            request_method
        ))),
    };

    crate::api::cancel::unregister_stream(&stream_id);
    match result {
        Ok(response) => {
            // Record token usage for every successful API call. Context
            // compaction requests also consume tokens and must be accounted
            // for. Errors here are non-fatal: we log and continue so the
            // chat response still reaches the user.
            let usage_response_id = response.id.clone();
            let usage_conversation_id = response.conversation_id.clone();
            let usage_model = response.model.clone();
            let usage_status = response.status.clone();
            let usage_input_tokens = response.token_usage.input_tokens;
            let usage_output_tokens = response.token_usage.output_tokens;
            let usage_cache_creation = response.token_usage.cache_creation_input_tokens;
            let usage_cache_read = response.token_usage.cache_read_input_tokens;
            let usage_is_sub_agent = is_sub_agent;
            let usage_dir_id = failure_directory_id.clone();
            let usage_api_profile = usage_api_profile_name.clone();
            let usage_api_config_id = usage_api_config_id.clone();
            let usage_req_method = usage_request_method.clone();
            let usage_db_path = usage_database_path.clone();
            if let Err(record_error) = tokio::task::spawn_blocking(move || {
                record_usage(
                    &usage_db_path,
                    &UsageRecordInput {
                        conversation_id: &usage_conversation_id,
                        response_id: &usage_response_id,
                        model: &usage_model,
                        api_profile_name: &usage_api_profile,
                        api_config_id: &usage_api_config_id,
                        request_method: &usage_req_method,
                        input_tokens: usage_input_tokens,
                        output_tokens: usage_output_tokens,
                        cache_creation_input_tokens: usage_cache_creation,
                        cache_read_input_tokens: usage_cache_read,
                        status: &usage_status,
                        is_sub_agent: usage_is_sub_agent,
                        directory_id: &usage_dir_id,
                    },
                )
            })
            .await
            {
                eprintln!("Failed to record usage: {record_error}");
            }
            Ok(response)
        }
        Err(error) => {
            if failure_context_compaction {
                // Context compaction failures are surfaced to the renderer
                // as a raw Err (no persisted error exchange). Log the full
                // request metadata here so the app_logs table captures enough
                // detail to diagnose provider/model/config issues without
                // needing to reproduce the failure.
                let compaction_error = error.to_string();
                let compaction_db = failure_database_path.clone();
                let compaction_context = serde_json::json!({
                    "conversation_id": failure_conversation_id,
                    "model": failure_model,
                    "directory_id": failure_directory_id,
                    "request_method": usage_request_method,
                    "api_profile": usage_api_profile_name,
                })
                .to_string();
                tokio::task::spawn_blocking(move || {
                    let _ = insert_app_log(
                        &compaction_db,
                        &AppLogInput {
                            level: "ERROR".to_string(),
                            module: "api".to_string(),
                            func: "create_response_stream".to_string(),
                            line: None,
                            message: "Context compaction request failed".to_string(),
                            input: None,
                            output: None,
                            duration: None,
                            context: Some(compaction_context),
                            error: Some(compaction_error),
                            source: "main".to_string(),
                        },
                    );
                });
                return Err(error);
            }
            let error_message = error.to_string();
            let persisted_error_message = error_message.clone();
            let persisted_failure_model = failure_model.clone();
            let failure_dir_id = failure_directory_id.clone();
            let persisted_failure_api_profile = failure_api_profile.clone();
            let conversation_id = tokio::task::spawn_blocking(move || {
                store_failed_chat_exchange(
                    &failure_database_path,
                    failure_conversation_id.as_deref(),
                    failure_previous_response_id.as_deref(),
                    &failure_messages,
                    &failure_checkpoint_id,
                    &persisted_failure_model,
                    &persisted_failure_api_profile,
                    &failure_directory_id,
                    &persisted_error_message,
                )
            })
            .await
            .map_err(|join_error| {
                Error::from_reason(format!(
                    "Failed to persist chat request error: {}",
                    join_error
                ))
            })??;

            // Record the failed API call with zero token usage so the usage
            // history reflects every attempt, not just successful ones.
            let usage_conversation_id = conversation_id.clone();
            let usage_model = failure_model.clone();
            let usage_api_profile = usage_api_profile_name.clone();
            let usage_api_config_id = usage_api_config_id.clone();
            let usage_req_method = usage_request_method.clone();
            let usage_db_path = usage_database_path.clone();
            let usage_is_sub_agent = is_sub_agent;
            if let Err(record_error) = tokio::task::spawn_blocking(move || {
                record_usage(
                    &usage_db_path,
                    &UsageRecordInput {
                        conversation_id: &usage_conversation_id,
                        response_id: "",
                        model: &usage_model,
                        api_profile_name: &usage_api_profile,
                        api_config_id: &usage_api_config_id,
                        request_method: &usage_req_method,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                        status: "error",
                        is_sub_agent: usage_is_sub_agent,
                        directory_id: &failure_dir_id,
                    },
                )
            })
            .await
            {
                eprintln!("Failed to record failed usage: {record_error}");
            }

            Ok(ResponsesApiResult {
                id: String::new(),
                conversation_id,
                content: error_message,
                thinking: String::new(),
                model: failure_model,
                status: "error".to_string(),
                tool_calls_json: "[]".to_string(),
                token_usage: crate::api::responses::TokenUsage {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            })
        }
    }
}
