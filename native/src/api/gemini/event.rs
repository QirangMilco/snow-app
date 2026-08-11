//! Gemini SSE event block parsing and individual event processing.

use napi::bindgen_prelude::*;
use serde_json::Value;

use crate::api::common::{read_first_i64, read_string};
use crate::storage::services::chat_conversations::ChatTokenUsage;

/// Process a raw SSE event block (text between two separators) for the
/// Gemini streaming protocol. Each `data:` line is parsed independently.
#[allow(clippy::too_many_arguments)]
pub(super) fn process_gemini_sse_event_block(
    event_block: &str,
    raw_events: &mut Vec<Value>,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut Vec<Value>,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    tool_args_delta: &mut String,
    stream_finished: &mut bool,
) {
    // Process each `data:` line independently as a separate SSE event.
    // This matches the TypeScript reference implementation where each line
    // is parsed on its own. Joining multiple data lines into one string
    // (the old behavior) produces invalid JSON when a proxy or server
    // batches multiple events within a single block, causing tool-call
    // data to be silently dropped.
    let mut found_data_line = false;
    for line in event_block.lines() {
        let trimmed = line.trim_start();
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        found_data_line = true;
        let data = data.trim_start();

        if data.is_empty() {
            continue;
        }

        let event = match serde_json::from_str::<Value>(data) {
            Ok(event) => event,
            Err(error) => {
                eprintln!("Gemini stream event parse error (skipping line): {}", error);
                continue;
            }
        };

        if let Err(process_error) = process_gemini_event(
            &event,
            content_chunks,
            thinking_chunks,
            tool_calls,
            response_id,
            response_model,
            response_status,
            token_usage,
            tool_args_delta,
        ) {
            eprintln!(
                "Gemini stream event processing error (terminal provider error): {}",
                process_error.reason
            );
            *response_status = String::from("failed");
            *stream_finished = true;
            return;
        }

        // Detect finishReason to signal normal stream completion.
        if let Some(candidates) = event.get("candidates").and_then(Value::as_array) {
            for candidate in candidates {
                if candidate
                    .get("finishReason")
                    .and_then(Value::as_str)
                    .is_some_and(|r| !r.is_empty())
                {
                    *stream_finished = true;
                }
            }
        }

        raw_events.push(event);
        if *stream_finished {
            return;
        }
    }

    // Fallback: some providers return a complete JSON response without SSE
    // `data:` framing. If no `data:` lines were found, try parsing the
    // entire block as raw JSON.
    if !found_data_line {
        let trimmed_block = event_block.trim();
        if trimmed_block.is_empty() || trimmed_block.starts_with(':') {
            return;
        }
        if let Ok(event) = serde_json::from_str::<Value>(trimmed_block) {
            if let Err(process_error) = process_gemini_event(
                &event,
                content_chunks,
                thinking_chunks,
                tool_calls,
                response_id,
                response_model,
                response_status,
                token_usage,
                tool_args_delta,
            ) {
                eprintln!(
                    "Gemini stream event processing error (terminal provider error): {}",
                    process_error.reason
                );
                *response_status = String::from("failed");
                *stream_finished = true;
                return;
            }
            // Detect finishReason in raw JSON fallback.
            if let Some(candidates) = event.get("candidates").and_then(Value::as_array) {
                for candidate in candidates {
                    if candidate
                        .get("finishReason")
                        .and_then(Value::as_str)
                        .is_some_and(|r| !r.is_empty())
                    {
                        *stream_finished = true;
                    }
                }
            }
            raw_events.push(event);
        }
    }
}

/// Process a single parsed Gemini SSE event.
#[allow(clippy::too_many_arguments)]
fn process_gemini_event(
    event: &Value,
    content_chunks: &mut Vec<String>,
    thinking_chunks: &mut Vec<String>,
    tool_calls: &mut Vec<Value>,
    response_id: &mut String,
    response_model: &mut String,
    response_status: &mut String,
    token_usage: &mut ChatTokenUsage,
    tool_args_delta: &mut String,
) -> Result<()> {
    if let Some(error) = event.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Gemini stream failed");
        return Err(Error::from_reason(message.to_string()));
    }

    if let Some(id) = read_string(event, "responseId") {
        *response_id = id;
    }
    if let Some(model) = read_string(event, "modelVersion") {
        *response_model = model;
    }

    if let Some(usage) = event.get("usageMetadata").filter(|value| !value.is_null()) {
        token_usage.input_tokens = read_first_i64(usage, &[&["promptTokenCount"]]);
        token_usage.output_tokens =
            read_first_i64(usage, &[&["candidatesTokenCount"], &["totalTokenCount"]]);
        token_usage.cache_read_input_tokens =
            read_first_i64(usage, &[&["cachedContentTokenCount"]]);
    }

    if let Some(prompt_feedback) = event.get("promptFeedback") {
        if let Some(block_reason) = prompt_feedback
            .get("blockReason")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            *response_status = block_reason.to_lowercase();
            return Ok(());
        }
    }

    if let Some(candidates) = event.get("candidates").and_then(Value::as_array) {
        for candidate in candidates {
            if let Some(content) = candidate.get("content") {
                if let Some(parts) = content.get("parts").and_then(Value::as_array) {
                    for part in parts {
                        let is_thought = part
                            .get("thought")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);

                        if let Some(text) = part
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|text| !text.is_empty())
                        {
                            if is_thought {
                                thinking_chunks.push(text.to_string());
                            } else {
                                content_chunks.push(text.to_string());
                            }
                        }

                        if let Some(function_call) = part.get("functionCall") {
                            // Serialize the function call so the token
                            // probe can reflect tool arguments in real
                            // time. Gemini returns the complete object
                            // at once (no streaming argument deltas), so
                            // we count it immediately when it appears.
                            if let Ok(json) = serde_json::to_string(function_call) {
                                tool_args_delta.push_str(&json);
                            }
                            tool_calls.push(function_call.clone());
                        }
                    }
                }
            }

            if let Some(finish_reason) = candidate
                .get("finishReason")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                *response_status = match finish_reason {
                    "STOP" => "completed".to_string(),
                    "MAX_TOKENS" => "max_tokens".to_string(),
                    other => other.to_lowercase(),
                };
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::process_gemini_sse_event_block;
    use crate::storage::services::chat_conversations::ChatTokenUsage;

    fn parse_terminal(event_block: &str) -> (String, bool) {
        let mut raw_events = Vec::<Value>::new();
        let mut content_chunks = Vec::new();
        let mut thinking_chunks = Vec::new();
        let mut tool_calls = Vec::new();
        let mut response_id = String::new();
        let mut response_model = String::new();
        let mut response_status = String::from("completed");
        let mut token_usage = ChatTokenUsage::default();
        let mut tool_args_delta = String::new();
        let mut stream_finished = false;

        process_gemini_sse_event_block(
            event_block,
            &mut raw_events,
            &mut content_chunks,
            &mut thinking_chunks,
            &mut tool_calls,
            &mut response_id,
            &mut response_model,
            &mut response_status,
            &mut token_usage,
            &mut tool_args_delta,
            &mut stream_finished,
        );

        (response_status, stream_finished)
    }

    #[test]
    fn stop_and_max_tokens_are_terminal() {
        assert_eq!(
            parse_terminal(r#"data: {"candidates":[{"finishReason":"STOP"}]}"#),
            ("completed".to_string(), true)
        );
        assert_eq!(
            parse_terminal(r#"data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}"#),
            ("max_tokens".to_string(), true)
        );
    }

    #[test]
    fn provider_error_is_failed_terminal_and_stops_event_block() {
        assert_eq!(
            parse_terminal("data: {not-json}"),
            ("completed".to_string(), false)
        );
        assert_eq!(
            parse_terminal(concat!(
                r#"data: {"error":{"code":429,"message":"Resource exhausted","status":"RESOURCE_EXHAUSTED"}}"#,
                "\n",
                r#"data: {"candidates":[{"finishReason":"STOP"}]}"#,
            )),
            ("failed".to_string(), true)
        );
    }
}
