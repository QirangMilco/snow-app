//! Responses API streaming response collection — HTTP request, retry loop,
//! idle-timeout reconnection, and SSE event dispatch.
//!
//! Uses raw reqwest `bytes_stream()` instead of the `async_openai` SDK so that
//! the streaming behaviour (idle timeout, non-SSE detection, partial tool-call
//! reconstruction) is identical to the Chat Completions and Anthropic
//! providers.

use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::api::common::emit_stream_chunk;
use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
use crate::api::retry::{
    decide_stream_recovery, is_retriable_stream_read_error, should_retry,
    stream_idle_timeout_error, visible_content_char_count, wait_before_retry, RetryOptions,
    StreamAttemptProgress, StreamEndCause, StreamInterruptionReason, StreamRecoveryDecision,
    StreamRecoveryOutcome,
};
use crate::api::sse::{read_sse_stream_until_terminal, SseStreamEnd};
use crate::storage::services::chat_conversations::ChatTokenUsage;

use super::event::{
    collect_reasoning_items, collect_tool_calls, extract_output_text, extract_response_error,
    extract_response_thinking, process_responses_sse_event_block,
};

pub(super) struct StreamingResponseResult {
    pub id: String,
    pub content: String,
    pub thinking: String,
    /// JSON array of reasoning output items captured from
    /// `response.output_item.done` events (each containing type=reasoning,
    /// summary, and encrypted_content). Persisted so the next request can
    /// round-trip reasoning verbatim when store:false.
    pub reasoning_items_json: String,
    pub model: String,
    pub status: String,
    pub interruption_reason: Option<StreamInterruptionReason>,
    pub recovery_outcome: Option<StreamRecoveryOutcome>,
    pub token_usage: ChatTokenUsage,
    pub tool_calls_json: String,
    pub tool_parse_errors: Vec<String>,
    pub total_duration_ms: i64,
}

struct ResponsesAttemptState {
    raw_events: Vec<Value>,
    content_chunks: Vec<String>,
    thinking_chunks: Vec<String>,
    tool_calls: Vec<Value>,
    reasoning_items: Vec<Value>,
    tool_parse_errors: Vec<String>,
    streaming_tool_items: HashMap<u64, (Value, String)>,
    response_id: String,
    response_model: String,
    response_status: String,
    token_usage: ChatTokenUsage,
    completed_response: Option<Value>,
    stream_completed_normally: bool,
    reasoning_text_streamed: bool,
}

impl Default for ResponsesAttemptState {
    fn default() -> Self {
        Self {
            raw_events: Vec::new(),
            content_chunks: Vec::new(),
            thinking_chunks: Vec::new(),
            tool_calls: Vec::new(),
            reasoning_items: Vec::new(),
            tool_parse_errors: Vec::new(),
            streaming_tool_items: HashMap::new(),
            response_id: String::new(),
            response_model: String::new(),
            response_status: String::from("completed"),
            token_usage: ChatTokenUsage::default(),
            completed_response: None,
            stream_completed_normally: false,
            reasoning_text_streamed: false,
        }
    }
}

impl ResponsesAttemptState {
    fn process_event_block(&mut self, event_block: &str) -> (String, String) {
        process_responses_sse_event_block(
            event_block,
            &mut self.raw_events,
            &mut self.content_chunks,
            &mut self.thinking_chunks,
            &mut self.tool_calls,
            &mut self.reasoning_items,
            &mut self.streaming_tool_items,
            &mut self.response_id,
            &mut self.response_model,
            &mut self.response_status,
            &mut self.token_usage,
            &mut self.completed_response,
            &mut self.stream_completed_normally,
            &mut self.reasoning_text_streamed,
        )
    }

    fn progress(&self, user_cancelled: bool) -> StreamAttemptProgress {
        StreamAttemptProgress {
            visible_content_chars: visible_content_char_count(&self.content_chunks),
            has_tool_state: !self.tool_calls.is_empty(),
            has_pending_tool_fragments: !self.streaming_tool_items.is_empty(),
            provider_terminal: self.stream_completed_normally,
            user_cancelled,
        }
    }

    fn finish_cancelled(&mut self) {
        self.response_status = String::from("cancelled");
        self.tool_calls.clear();
        self.streaming_tool_items.clear();
        self.tool_parse_errors.clear();
    }

    fn finalize_provider_terminal(
        &mut self,
    ) -> (
        Option<StreamInterruptionReason>,
        Option<StreamRecoveryOutcome>,
    ) {
        self.streaming_tool_items.clear();

        if let Some(response) = self.completed_response.as_ref() {
            if self.content_chunks.is_empty() {
                let content = extract_output_text(response);
                if !content.is_empty() {
                    self.content_chunks.push(content);
                }
            }

            if self.thinking_chunks.is_empty() {
                let thinking = extract_response_thinking(response);
                if !thinking.is_empty() {
                    self.thinking_chunks.push(thinking);
                }
            }

            // Only a trusted `response.completed` payload may act as a
            // fallback source of executable tool calls. Incomplete or failed
            // payloads never promote their output tree.
            if self.response_status == "completed" && self.tool_calls.is_empty() {
                collect_tool_calls(response.get("output"), &mut self.tool_calls);
            }

            if self.reasoning_items.is_empty() {
                collect_reasoning_items(response.get("output"), &mut self.reasoning_items);
            }
        }

        if self.response_status == "incomplete" {
            self.tool_parse_errors.clear();
            (Some(StreamInterruptionReason::ExplicitIncomplete), None)
        } else {
            (None, None)
        }
    }
}

fn finalize_transport_interruption(
    state: &mut ResponsesAttemptState,
    decision: StreamRecoveryDecision,
    cause: StreamEndCause,
    read_error_retriable: bool,
) -> (
    Option<StreamInterruptionReason>,
    Option<StreamRecoveryOutcome>,
) {
    state.response_status = String::from("incomplete");
    state.streaming_tool_items.clear();
    if matches!(decision, StreamRecoveryDecision::SurfaceInterrupted) {
        // Display text/reasoning may survive a final interruption, but neither
        // finalized nor pending tool state is trusted.
        state.tool_calls.clear();
        state.tool_parse_errors.clear();
    }

    (
        Some(cause.interruption_reason()),
        decision.recovery_outcome(cause, read_error_retriable),
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_streaming_response(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    payload: Value,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
    stream_idle_timeout_sec: u64,
) -> Result<StreamingResponseResult> {
    let mut attempt: u32 = 0;
    let mut stream_token_count: usize = 0;
    let stream_start = std::time::Instant::now();
    let mut ttft_ms: i64 = 0;

    let idle_timeout = Duration::from_secs(stream_idle_timeout_sec);

    let (mut attempt_state, interruption_reason, recovery_outcome) = 'attempt_loop: loop {
        // Every HTTP response gets fresh Provider-local state. Retrying drops
        // the entire prior attempt, including pending tool fragments and parser
        // flags, before the original request is issued again.
        // ---- Phase 1: send the request (with retry on connect errors) ----
        let header_map = super::payload::build_header_map(api_key, custom_headers)?;
        let response = loop {
            if cancel_token.is_cancelled() {
                return Ok(StreamingResponseResult {
                    id: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    reasoning_items_json: "[]".to_string(),
                    model: String::new(),
                    status: String::from("cancelled"),
                    interruption_reason: None,
                    recovery_outcome: None,
                    token_usage: ChatTokenUsage {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                    tool_calls_json: "[]".to_string(),
                    tool_parse_errors: Vec::new(),
                    total_duration_ms: stream_start.elapsed().as_millis() as i64,
                });
            }

            let send_future = client
                .post(endpoint)
                .headers(header_map.clone())
                .json(&payload)
                .send();

            let result = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    return Ok(StreamingResponseResult {
                        id: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        reasoning_items_json: "[]".to_string(),
                        model: String::new(),
                        status: String::from("cancelled"),
                        interruption_reason: None,
                        recovery_outcome: None,
                        token_usage: ChatTokenUsage {
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                        tool_calls_json: "[]".to_string(),
                        tool_parse_errors: Vec::new(),
                        total_duration_ms: stream_start.elapsed().as_millis() as i64,
                    });
                }
                result = send_future => {
                    result.map_err(|error| Error::from_reason(format!("Failed to create response stream: {error}")))
                }
            };

            match result {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let error_body = response.text().await.unwrap_or_default();
                        let error = Error::from_reason(format!(
                            "Responses API request failed: {} {}",
                            status, error_body
                        ));

                        if !should_retry(&error, attempt, retry_options) {
                            return Err(error);
                        }

                        // Emit retry status to frontend
                        on_chunk.call(
                            ResponsesApiStreamChunk {
                                content_delta: String::new(),
                                thinking_delta: String::new(),
                                content: String::new(),
                                thinking: String::new(),
                                retrying: true,
                                retry_attempt: Some((attempt + 1) as i32),
                                retry_error: Some(error.reason.clone()),
                                stream_token_count: stream_token_count as i64,
                                elapsed_ms: stream_start.elapsed().as_millis() as i64,
                                ttft_ms,
                                vision_status: None,
                            },
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );

                        match wait_before_retry(retry_options, cancel_token, attempt).await {
                            Ok(()) => {
                                attempt += 1;
                                continue;
                            }
                            Err(e) => return Err(e),
                        }
                    }
                    break response;
                }
                Err(error) => {
                    if !should_retry(&error, attempt, retry_options) {
                        return Err(error);
                    }

                    // Emit retry status to frontend
                    on_chunk.call(
                        ResponsesApiStreamChunk {
                            content_delta: String::new(),
                            thinking_delta: String::new(),
                            content: String::new(),
                            thinking: String::new(),
                            retrying: true,
                            retry_attempt: Some((attempt + 1) as i32),
                            retry_error: Some(error.reason.clone()),
                            stream_token_count: stream_token_count as i64,
                            elapsed_ms: stream_start.elapsed().as_millis() as i64,
                            ttft_ms,
                            vision_status: None,
                        },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );

                    match wait_before_retry(retry_options, cancel_token, attempt).await {
                        Ok(()) => {
                            attempt += 1;
                            continue;
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
        };

        // ---- Phase 2: read one complete Provider attempt ----
        let mut attempt_state = ResponsesAttemptState::default();
        let mut byte_buffer = Vec::new();
        let mut stream = response.bytes_stream();

        let stream_end = read_sse_stream_until_terminal(
            &mut stream,
            &mut byte_buffer,
            cancel_token,
            idle_timeout,
            |event_block| {
                let (content_delta, thinking_delta) =
                    attempt_state.process_event_block(event_block);
                if ttft_ms == 0 {
                    ttft_ms = stream_start.elapsed().as_millis() as i64;
                }
                emit_stream_chunk(
                    on_chunk,
                    content_delta,
                    thinking_delta,
                    &mut stream_token_count,
                    stream_start.elapsed().as_millis() as i64,
                    ttft_ms,
                );
                attempt_state.stream_completed_normally
            },
        )
        .await;

        if let SseStreamEnd::Cancelled = &stream_end {
            attempt_state.response_status = String::from("cancelled");
        }

        // Cancellation is checked first after the reader returns. It must beat
        // a simultaneously observed Provider terminal and must not leave any
        // interruption metadata or executable tool state behind.
        if attempt_state.response_status == "cancelled" || cancel_token.is_cancelled() {
            attempt_state.finish_cancelled();
            break 'attempt_loop (attempt_state, None, None);
        }

        // Provider terminal wins over transport recovery. Completed payloads
        // may supply trusted fallback output, while pending streaming tool
        // fragments are always discarded.
        if let SseStreamEnd::ProviderTerminal = &stream_end {
            let (terminal_interruption_reason, terminal_recovery_outcome) =
                attempt_state.finalize_provider_terminal();

            // Preserve the existing Provider-level retry for terminal transient
            // failures. It is separate from transport recovery and never leaves
            // interruption metadata on a later successful response.
            if attempt_state.response_status == "failed"
                && attempt_state.content_chunks.is_empty()
                && attempt_state.thinking_chunks.is_empty()
                && attempt_state.tool_calls.is_empty()
                && attempt_state.reasoning_items.is_empty()
            {
                let error_message = attempt_state
                    .completed_response
                    .as_ref()
                    .and_then(extract_response_error)
                    .unwrap_or_else(|| {
                        "Responses API returned failed status without error details".to_string()
                    });
                let error = Error::from_reason(error_message);

                if !should_retry(&error, attempt, retry_options) {
                    return Err(error);
                }

                on_chunk.call(
                    ResponsesApiStreamChunk {
                        content_delta: String::new(),
                        thinking_delta: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        retrying: true,
                        retry_attempt: Some((attempt + 1) as i32),
                        retry_error: Some(error.reason.clone()),
                        stream_token_count: stream_token_count as i64,
                        elapsed_ms: stream_start.elapsed().as_millis() as i64,
                        ttft_ms,
                        vision_status: None,
                    },
                    ThreadsafeFunctionCallMode::NonBlocking,
                );

                match wait_before_retry(retry_options, cancel_token, attempt).await {
                    Ok(()) => {
                        attempt += 1;
                        continue 'attempt_loop;
                    }
                    Err(_wait_error) if cancel_token.is_cancelled() => {
                        attempt_state.finish_cancelled();
                        break 'attempt_loop (attempt_state, None, None);
                    }
                    Err(wait_error) => return Err(wait_error),
                }
            }

            break 'attempt_loop (
                attempt_state,
                terminal_interruption_reason,
                terminal_recovery_outcome,
            );
        }

        let (cause, read_error_retriable, retry_error) = match stream_end {
            SseStreamEnd::ReadError(error) => {
                let stream_error = Error::from_reason(error.to_string());
                let retriable = is_retriable_stream_read_error(&stream_error);
                (
                    StreamEndCause::ReadError,
                    retriable,
                    stream_error.reason.clone(),
                )
            }
            SseStreamEnd::UnexpectedEof => (
                StreamEndCause::UnexpectedEof,
                true,
                "Stream ended before a Responses terminal event".to_string(),
            ),
            SseStreamEnd::IdleTimeout => (
                StreamEndCause::IdleTimeout,
                true,
                stream_idle_timeout_error().reason.clone(),
            ),
            SseStreamEnd::ProviderTerminal | SseStreamEnd::Cancelled => {
                unreachable!("terminal and cancellation are handled before transport recovery")
            }
        };
        let progress = attempt_state.progress(cancel_token.is_cancelled());
        let decision = decide_stream_recovery(
            cause,
            attempt,
            retry_options,
            read_error_retriable,
            progress,
        );

        match decision {
            StreamRecoveryDecision::Cancelled => {
                attempt_state.finish_cancelled();
                break 'attempt_loop (attempt_state, None, None);
            }
            StreamRecoveryDecision::FinishProviderResult => {
                let (provider_reason, provider_outcome) =
                    attempt_state.finalize_provider_terminal();
                break 'attempt_loop (attempt_state, provider_reason, provider_outcome);
            }
            StreamRecoveryDecision::Retry => {
                on_chunk.call(
                    ResponsesApiStreamChunk {
                        content_delta: String::new(),
                        thinking_delta: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        retrying: true,
                        retry_attempt: Some((attempt + 1) as i32),
                        retry_error: Some(retry_error),
                        stream_token_count: stream_token_count as i64,
                        elapsed_ms: stream_start.elapsed().as_millis() as i64,
                        ttft_ms,
                        vision_status: None,
                    },
                    ThreadsafeFunctionCallMode::NonBlocking,
                );

                match wait_before_retry(retry_options, cancel_token, attempt).await {
                    Ok(()) => {
                        attempt += 1;
                        continue 'attempt_loop;
                    }
                    Err(_wait_error) if cancel_token.is_cancelled() => {
                        attempt_state.finish_cancelled();
                        break 'attempt_loop (attempt_state, None, None);
                    }
                    Err(wait_error) => return Err(wait_error),
                }
            }
            StreamRecoveryDecision::KeepUsablePartial
            | StreamRecoveryDecision::SurfaceInterrupted => {
                let (transport_reason, transport_outcome) = finalize_transport_interruption(
                    &mut attempt_state,
                    decision,
                    cause,
                    read_error_retriable,
                );
                break 'attempt_loop (attempt_state, transport_reason, transport_outcome);
            }
        }
    };

    // If no structured reasoning item arrived, preserve streamed reasoning text
    // in the existing minimal round-trip shape.
    if attempt_state.reasoning_items.is_empty() {
        let thinking = attempt_state.thinking_chunks.join("").trim().to_string();
        if !thinking.is_empty() {
            attempt_state.reasoning_items.push(json!({
                "type": "reasoning",
                "reasoning_text": thinking,
            }));
        }
    }

    let content = attempt_state.content_chunks.join("").trim().to_string();
    let thinking = attempt_state.thinking_chunks.join("").trim().to_string();
    let tool_calls_json =
        serde_json::to_string(&attempt_state.tool_calls).unwrap_or_else(|_| "[]".to_string());
    let reasoning_items_json =
        serde_json::to_string(&attempt_state.reasoning_items).unwrap_or_else(|_| "[]".to_string());

    Ok(StreamingResponseResult {
        id: attempt_state.response_id,
        content,
        thinking,
        reasoning_items_json,
        model: attempt_state.response_model,
        status: attempt_state.response_status,
        interruption_reason,
        recovery_outcome,
        token_usage: attempt_state.token_usage,
        tool_calls_json,
        tool_parse_errors: attempt_state.tool_parse_errors,
        total_duration_ms: stream_start.elapsed().as_millis() as i64,
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures::{stream, Stream, StreamExt};
    use serde_json::{json, Value};
    use tokio::runtime::Builder;
    use tokio_util::sync::CancellationToken;

    use super::{finalize_transport_interruption, ResponsesAttemptState};
    use crate::api::retry::{
        decide_stream_recovery, RetryOptions, StreamEndCause, StreamInterruptionReason,
        StreamRecoveryDecision, StreamRecoveryOutcome,
    };
    use crate::api::sse::{read_sse_stream_until_terminal, SseStreamEnd};

    fn runtime() -> tokio::runtime::Runtime {
        Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("build runtime")
    }

    fn encode_events(events: &[Value], trailing_delimiter: bool) -> Vec<u8> {
        let mut body = String::new();
        for event in events {
            body.push_str("data: ");
            body.push_str(&event.to_string());
            body.push_str("\n\n");
        }
        if !trailing_delimiter && body.ends_with("\n\n") {
            body.truncate(body.len() - 2);
        }
        body.into_bytes()
    }

    async fn read_attempt<S, E>(
        source: &mut S,
        state: &mut ResponsesAttemptState,
        cancel_token: &CancellationToken,
        idle_timeout: Duration,
    ) -> SseStreamEnd<E>
    where
        S: Stream<Item = Result<Vec<u8>, E>> + Unpin,
    {
        let mut byte_buffer = Vec::new();
        read_sse_stream_until_terminal(
            source,
            &mut byte_buffer,
            cancel_token,
            idle_timeout,
            |event_block| {
                let _ = state.process_event_block(event_block);
                state.stream_completed_normally
            },
        )
        .await
    }

    fn retry_options(max_retries: u32) -> RetryOptions {
        RetryOptions {
            max_retries,
            base_delay_ms: 0,
            partial_retry_max_chars: 1,
        }
    }

    #[test]
    fn terminal_followed_by_permanently_pending_transport_exits_immediately() {
        runtime().block_on(async {
            let cancel_token = CancellationToken::new();
            let body = encode_events(
                &[json!({
                    "type": "response.completed",
                    "response": {"id": "resp-terminal", "status": "completed"}
                })],
                true,
            );
            let mut source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(body)])
                .chain(stream::pending::<Result<Vec<u8>, &'static str>>());
            let mut state = ResponsesAttemptState::default();

            let end = read_attempt(&mut source, &mut state, &cancel_token, Duration::ZERO).await;

            assert_eq!(end, SseStreamEnd::ProviderTerminal);
            assert!(state.stream_completed_normally);
            assert_eq!(state.response_status, "completed");
            assert_eq!(state.response_id, "resp-terminal");
        });
    }

    #[test]
    fn trailing_terminal_without_delimiter_is_parsed_before_eof_recovery() {
        runtime().block_on(async {
            let cancel_token = CancellationToken::new();
            let body = encode_events(
                &[json!({
                    "type": "response.completed",
                    "response": {
                        "id": "resp-trailing",
                        "model": "gpt-test",
                        "status": "completed"
                    }
                })],
                false,
            );
            let mut source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(body)]);
            let mut state = ResponsesAttemptState::default();

            let end = read_attempt(
                &mut source,
                &mut state,
                &cancel_token,
                Duration::from_secs(1),
            )
            .await;

            assert_eq!(end, SseStreamEnd::ProviderTerminal);
            assert_eq!(state.response_id, "resp-trailing");
            assert_eq!(state.response_model, "gpt-test");
        });
    }

    #[test]
    fn nonterminal_eof_and_read_error_remain_distinct() {
        runtime().block_on(async {
            let cancel_token = CancellationToken::new();
            let content_event = json!({
                "type": "response.output_text.delta",
                "delta": "partial"
            });

            let mut eof_source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(encode_events(
                &[content_event.clone()],
                false,
            ))]);
            let mut eof_state = ResponsesAttemptState::default();
            let eof_end = read_attempt(
                &mut eof_source,
                &mut eof_state,
                &cancel_token,
                Duration::from_secs(1),
            )
            .await;

            assert_eq!(eof_end, SseStreamEnd::UnexpectedEof);
            assert_eq!(eof_state.content_chunks, vec!["partial".to_string()]);

            let mut error_source = stream::iter(vec![
                Ok::<Vec<u8>, &'static str>(encode_events(&[content_event], true)),
                Err("read failed"),
            ]);
            let mut error_state = ResponsesAttemptState::default();
            let error_end = read_attempt(
                &mut error_source,
                &mut error_state,
                &cancel_token,
                Duration::from_secs(1),
            )
            .await;

            assert_eq!(error_end, SseStreamEnd::ReadError("read failed"));
            assert_eq!(error_state.content_chunks, vec!["partial".to_string()]);
        });
    }

    #[test]
    fn a_new_attempt_has_no_state_from_the_previous_attempt() {
        runtime().block_on(async {
            let cancel_token = CancellationToken::new();
            let body = encode_events(
                &[
                    json!({"type": "response.output_text.delta", "delta": "old content"}),
                    json!({"type": "response.reasoning_text.delta", "delta": "old thinking"}),
                    json!({
                        "type": "response.output_item.done",
                        "output_index": 0,
                        "item": {
                            "type": "function_call",
                            "call_id": "call-finalized",
                            "name": "run",
                            "arguments": "{}"
                        }
                    }),
                    json!({
                        "type": "response.output_item.added",
                        "output_index": 1,
                        "item": {
                            "type": "function_call",
                            "call_id": "call-pending",
                            "name": "wait"
                        }
                    }),
                ],
                true,
            );
            let mut source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(body)]);
            let mut previous = ResponsesAttemptState::default();

            assert_eq!(
                read_attempt(
                    &mut source,
                    &mut previous,
                    &cancel_token,
                    Duration::from_secs(1),
                )
                .await,
                SseStreamEnd::UnexpectedEof
            );
            assert!(!previous.content_chunks.is_empty());
            assert!(!previous.thinking_chunks.is_empty());
            assert!(!previous.tool_calls.is_empty());
            assert!(!previous.streaming_tool_items.is_empty());
            assert!(previous.reasoning_text_streamed);

            // Production constructs this same fresh state at the start of each
            // HTTP attempt; the previous value is dropped on `Retry`.
            let next = ResponsesAttemptState::default();
            assert!(next.raw_events.is_empty());
            assert!(next.content_chunks.is_empty());
            assert!(next.thinking_chunks.is_empty());
            assert!(next.tool_calls.is_empty());
            assert!(next.reasoning_items.is_empty());
            assert!(next.tool_parse_errors.is_empty());
            assert!(next.streaming_tool_items.is_empty());
            assert!(next.response_id.is_empty());
            assert!(next.response_model.is_empty());
            assert_eq!(next.response_status, "completed");
            assert!(next.completed_response.is_none());
            assert!(!next.stream_completed_normally);
            assert!(!next.reasoning_text_streamed);
        });
    }

    #[test]
    fn pending_tool_interruption_requires_retry_while_budget_remains() {
        runtime().block_on(async {
            let cancel_token = CancellationToken::new();
            let body = encode_events(
                &[
                    json!({"type": "response.output_text.delta", "delta": "visible content"}),
                    json!({
                        "type": "response.output_item.added",
                        "output_index": 0,
                        "item": {
                            "type": "function_call",
                            "call_id": "call-pending",
                            "name": "run"
                        }
                    }),
                    json!({
                        "type": "response.function_call_arguments.delta",
                        "output_index": 0,
                        "delta": "{"
                    }),
                ],
                true,
            );
            let mut source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(body)]);
            let mut state = ResponsesAttemptState::default();

            assert_eq!(
                read_attempt(
                    &mut source,
                    &mut state,
                    &cancel_token,
                    Duration::from_secs(1),
                )
                .await,
                SseStreamEnd::UnexpectedEof
            );
            assert!(state.tool_calls.is_empty());
            assert_eq!(state.streaming_tool_items.len(), 1);

            let decision = decide_stream_recovery(
                StreamEndCause::UnexpectedEof,
                0,
                &retry_options(1),
                true,
                state.progress(false),
            );
            assert_eq!(decision, StreamRecoveryDecision::Retry);
        });
    }

    #[test]
    fn exhausted_pending_fragments_and_finalized_tools_are_discarded() {
        runtime().block_on(async {
            let cancel_token = CancellationToken::new();
            let body = encode_events(
                &[
                    json!({
                        "type": "response.output_item.done",
                        "output_index": 0,
                        "item": {
                            "type": "function_call",
                            "call_id": "call-finalized",
                            "name": "run",
                            "arguments": "{}"
                        }
                    }),
                    json!({
                        "type": "response.output_item.added",
                        "output_index": 1,
                        "item": {
                            "type": "function_call",
                            "call_id": "call-pending",
                            "name": "wait"
                        }
                    }),
                    json!({
                        "type": "response.function_call_arguments.delta",
                        "output_index": 1,
                        "delta": "{"
                    }),
                ],
                true,
            );
            let mut source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(body)]);
            let mut state = ResponsesAttemptState::default();

            assert_eq!(
                read_attempt(
                    &mut source,
                    &mut state,
                    &cancel_token,
                    Duration::from_secs(1),
                )
                .await,
                SseStreamEnd::UnexpectedEof
            );
            assert_eq!(state.tool_calls.len(), 1);
            assert_eq!(state.streaming_tool_items.len(), 1);
            state
                .tool_parse_errors
                .push("stale parse error".to_string());

            let decision = decide_stream_recovery(
                StreamEndCause::UnexpectedEof,
                0,
                &retry_options(0),
                true,
                state.progress(false),
            );
            assert_eq!(decision, StreamRecoveryDecision::SurfaceInterrupted);

            let (reason, outcome) = finalize_transport_interruption(
                &mut state,
                decision,
                StreamEndCause::UnexpectedEof,
                true,
            );
            assert_eq!(state.response_status, "incomplete");
            assert!(state.tool_calls.is_empty());
            assert!(state.streaming_tool_items.is_empty());
            assert!(state.tool_parse_errors.is_empty());
            assert_eq!(serde_json::to_string(&state.tool_calls).unwrap(), "[]");
            assert_eq!(reason, Some(StreamInterruptionReason::UnexpectedEof));
            assert_eq!(outcome, Some(StreamRecoveryOutcome::RetryExhausted));
        });
    }

    #[test]
    fn trusted_completed_payload_may_supply_fallback_tools() {
        runtime().block_on(async {
            let cancel_token = CancellationToken::new();
            let body = encode_events(
                &[
                    json!({
                        "type": "response.output_item.added",
                        "output_index": 0,
                        "item": {
                            "type": "function_call",
                            "call_id": "call-fragment",
                            "name": "fragment"
                        }
                    }),
                    json!({
                        "type": "response.completed",
                        "response": {
                            "id": "resp-completed",
                            "status": "completed",
                            "output": [{
                                "type": "function_call",
                                "call_id": "call-trusted",
                                "name": "run",
                                "arguments": "{}"
                            }]
                        }
                    }),
                ],
                true,
            );
            let mut source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(body)]);
            let mut state = ResponsesAttemptState::default();

            assert_eq!(
                read_attempt(
                    &mut source,
                    &mut state,
                    &cancel_token,
                    Duration::from_secs(1),
                )
                .await,
                SseStreamEnd::ProviderTerminal
            );
            assert!(state.tool_calls.is_empty());
            assert_eq!(state.streaming_tool_items.len(), 1);

            let metadata = state.finalize_provider_terminal();
            assert_eq!(metadata, (None, None));
            assert!(state.streaming_tool_items.is_empty());
            assert_eq!(state.tool_calls.len(), 1);
            assert_eq!(
                state.tool_calls[0].get("call_id").and_then(Value::as_str),
                Some("call-trusted")
            );
        });
    }

    #[test]
    fn explicit_incomplete_discards_pending_and_never_promotes_payload_tools() {
        runtime().block_on(async {
            let cancel_token = CancellationToken::new();
            let body = encode_events(
                &[
                    json!({
                        "type": "response.output_item.added",
                        "output_index": 0,
                        "item": {
                            "type": "function_call",
                            "call_id": "call-fragment",
                            "name": "fragment"
                        }
                    }),
                    json!({
                        "type": "response.incomplete",
                        "response": {
                            "status": "incomplete",
                            "output": [{
                                "type": "function_call",
                                "call_id": "call-untrusted-payload",
                                "name": "run",
                                "arguments": "{}"
                            }]
                        }
                    }),
                ],
                true,
            );
            let mut source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(body)]);
            let mut state = ResponsesAttemptState::default();

            assert_eq!(
                read_attempt(
                    &mut source,
                    &mut state,
                    &cancel_token,
                    Duration::from_secs(1),
                )
                .await,
                SseStreamEnd::ProviderTerminal
            );
            let (reason, outcome) = state.finalize_provider_terminal();

            assert_eq!(state.response_status, "incomplete");
            assert!(state.streaming_tool_items.is_empty());
            assert!(state.tool_calls.is_empty());
            assert_eq!(reason, Some(StreamInterruptionReason::ExplicitIncomplete));
            assert_eq!(outcome, None);
        });
    }

    #[test]
    fn failed_terminal_keeps_provider_status_without_transport_metadata() {
        runtime().block_on(async {
            let cancel_token = CancellationToken::new();
            let body = encode_events(
                &[json!({
                    "type": "response.failed",
                    "response": {
                        "status": "failed",
                        "error": {"message": "provider failed"}
                    }
                })],
                true,
            );
            let mut source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(body)]);
            let mut state = ResponsesAttemptState::default();

            assert_eq!(
                read_attempt(
                    &mut source,
                    &mut state,
                    &cancel_token,
                    Duration::from_secs(1),
                )
                .await,
                SseStreamEnd::ProviderTerminal
            );
            let metadata = state.finalize_provider_terminal();

            assert_eq!(state.response_status, "failed");
            assert_eq!(metadata, (None, None));
        });
    }

    #[test]
    fn cancellation_after_terminal_read_wins_and_clears_all_tool_state() {
        runtime().block_on(async {
            let cancel_token = CancellationToken::new();
            let body = encode_events(
                &[
                    json!({
                        "type": "response.output_item.done",
                        "output_index": 0,
                        "item": {
                            "type": "function_call",
                            "call_id": "call-finalized",
                            "name": "run",
                            "arguments": "{}"
                        }
                    }),
                    json!({
                        "type": "response.output_item.added",
                        "output_index": 1,
                        "item": {
                            "type": "function_call",
                            "call_id": "call-pending",
                            "name": "wait"
                        }
                    }),
                    json!({
                        "type": "response.completed",
                        "response": {"status": "completed"}
                    }),
                ],
                true,
            );
            let mut source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(body)]);
            let mut state = ResponsesAttemptState::default();

            assert_eq!(
                read_attempt(
                    &mut source,
                    &mut state,
                    &cancel_token,
                    Duration::from_secs(1),
                )
                .await,
                SseStreamEnd::ProviderTerminal
            );
            assert_eq!(state.tool_calls.len(), 1);
            assert_eq!(state.streaming_tool_items.len(), 1);
            state
                .tool_parse_errors
                .push("stale parse error".to_string());

            // This is the production post-reader ordering: cancellation is
            // evaluated before Provider-terminal finalization or fallback.
            cancel_token.cancel();
            let metadata = if state.response_status == "cancelled" || cancel_token.is_cancelled() {
                state.finish_cancelled();
                (None, None)
            } else {
                state.finalize_provider_terminal()
            };

            assert_eq!(state.response_status, "cancelled");
            assert!(state.tool_calls.is_empty());
            assert!(state.streaming_tool_items.is_empty());
            assert!(state.tool_parse_errors.is_empty());
            assert_eq!(metadata, (None, None));
        });
    }
}
