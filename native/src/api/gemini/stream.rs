//! Gemini streaming response collection — HTTP request, retry loop, and
//! SSE event dispatch.
//!
//! The whole request+stream cycle lives in a single retry loop (matching
//! Anthropic/Chat). Non-SSE responses (HTTP 200 with a JSON error envelope
//! instead of a valid SSE stream) are retried in Rust so transient relay
//! failures can recover without bouncing back to the JS agent loop.

use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, CONTENT_TYPE};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::api::common::{emit_stream_chunk, emit_tool_args_probe, inject_custom_headers};
use crate::api::responses::{ResponsesApiStreamCallback, ResponsesApiStreamChunk};
use crate::api::retry::{
    decide_stream_recovery, is_retriable_stream_read_error, should_retry,
    stream_idle_timeout_error, visible_content_char_count, wait_before_retry, RetryOptions,
    StreamAttemptProgress, StreamEndCause, StreamInterruptionReason, StreamRecoveryDecision,
    StreamRecoveryOutcome,
};
use crate::api::sse::{read_sse_stream_until_terminal, SseStreamEnd};
use crate::storage::services::chat_conversations::ChatTokenUsage;

pub(super) struct GeminiStreamResult {
    pub id: String,
    pub content: String,
    pub thinking: String,
    pub model: String,
    pub status: String,
    pub interruption_reason: Option<StreamInterruptionReason>,
    pub recovery_outcome: Option<StreamRecoveryOutcome>,
    pub token_usage: ChatTokenUsage,
    pub tool_calls_json: String,
    pub total_duration_ms: i64,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_gemini_stream(
    client: &reqwest::Client,
    endpoint: &str,
    custom_headers: &HashMap<String, String>,
    payload: Value,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
    stream_idle_timeout_sec: u64,
) -> Result<GeminiStreamResult> {
    let mut attempt: u32 = 0;
    let mut stream_token_count: usize = 0;
    let stream_start = std::time::Instant::now();
    let mut ttft_ms: i64 = 0;
    let idle_timeout = Duration::from_secs(stream_idle_timeout_sec);

    'attempt_loop: loop {
        if cancel_token.is_cancelled() {
            return Ok(GeminiStreamResult {
                id: String::new(),
                content: String::new(),
                thinking: String::new(),
                model: String::new(),
                status: String::from("cancelled"),
                interruption_reason: None,
                recovery_outcome: None,
                token_usage: ChatTokenUsage::default(),
                tool_calls_json: "[]".to_string(),
                total_duration_ms: stream_start.elapsed().as_millis() as i64,
            });
        }

        let response = loop {
            if cancel_token.is_cancelled() {
                return Ok(GeminiStreamResult {
                    id: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    model: String::new(),
                    status: String::from("cancelled"),
                    interruption_reason: None,
                    recovery_outcome: None,
                    token_usage: ChatTokenUsage::default(),
                    tool_calls_json: "[]".to_string(),
                    total_duration_ms: stream_start.elapsed().as_millis() as i64,
                });
            }

            let send_future = client
                .post(endpoint)
                .headers(build_header_map(custom_headers)?)
                .json(&payload)
                .send();

            let result = tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    return Ok(GeminiStreamResult {
                        id: String::new(),
                        content: String::new(),
                        thinking: String::new(),
                        model: String::new(),
                        status: String::from("cancelled"),
                        interruption_reason: None,
                        recovery_outcome: None,
                        token_usage: ChatTokenUsage::default(),
                        tool_calls_json: "[]".to_string(),
                        total_duration_ms: stream_start.elapsed().as_millis() as i64,
                    });
                }
                result = send_future => {
                    result.map_err(|error| Error::from_reason(format!("Failed to create Gemini stream: {error}")))
                }
            };

            match result {
                Ok(response) => {
                    let status = response.status();
                    if !status.is_success() {
                        let error_body = response.text().await.unwrap_or_default();
                        let error = Error::from_reason(format!(
                            "Gemini streamGenerateContent request failed: {} {}",
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
        // All accumulators are local to this attempt, so retrying cannot mix
        // content, thinking, tools, usage, or terminal state.
        let mut raw_events = Vec::new();
        let mut content_chunks = Vec::new();
        let mut thinking_chunks = Vec::new();
        let mut tool_calls = Vec::new();
        let mut response_id = String::new();
        let mut response_model = String::new();
        let mut response_status = String::from("completed");
        let mut token_usage = ChatTokenUsage::default();
        let mut byte_buffer: Vec<u8> = Vec::new();
        let mut stream_finished = false;
        let mut interruption_reason = None;
        let mut recovery_outcome = None;
        let mut stream = response.bytes_stream();
        let mut end_cause: Option<(StreamEndCause, bool, String)> = None;

        macro_rules! process_event_block {
            ($event_block:expr) => {{
                let content_start_index = content_chunks.len();
                let thinking_start_index = thinking_chunks.len();
                let mut tool_args_delta = String::new();
                super::event::process_gemini_sse_event_block(
                    $event_block,
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
                let content_delta = content_chunks[content_start_index..].join("");
                let thinking_delta = thinking_chunks[thinking_start_index..].join("");
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
                emit_tool_args_probe(
                    on_chunk,
                    &mut stream_token_count,
                    &tool_args_delta,
                    stream_start.elapsed().as_millis() as i64,
                    ttft_ms,
                );
            }};
        }

        let stream_end = read_sse_stream_until_terminal(
            &mut stream,
            &mut byte_buffer,
            cancel_token,
            idle_timeout,
            |event_block| {
                process_event_block!(event_block);
                stream_finished
            },
        )
        .await;

        match stream_end {
            SseStreamEnd::ProviderTerminal => {}
            SseStreamEnd::ReadError(error) => {
                let stream_error = Error::from_reason(error.to_string());
                let retriable = is_retriable_stream_read_error(&stream_error);
                end_cause = Some((
                    StreamEndCause::ReadError,
                    retriable,
                    stream_error.reason.clone(),
                ));
            }
            SseStreamEnd::UnexpectedEof => {
                end_cause = Some((
                    StreamEndCause::UnexpectedEof,
                    true,
                    "Stream ended before a Gemini terminal event".to_string(),
                ));
            }
            SseStreamEnd::IdleTimeout => {
                end_cause = Some((
                    StreamEndCause::IdleTimeout,
                    true,
                    stream_idle_timeout_error().reason.clone(),
                ));
            }
            SseStreamEnd::Cancelled => {
                response_status = String::from("cancelled");
            }
        }

        if response_status == "cancelled" || cancel_token.is_cancelled() {
            response_status = String::from("cancelled");
            tool_calls.clear();
            interruption_reason = None;
            recovery_outcome = None;
        } else if stream_finished {
            // finishReason is an authoritative Provider terminal. In
            // particular, MAX_TOKENS is output-limit metadata, not a transport
            // retry trigger.
            if response_status == "max_tokens" {
                interruption_reason = Some(StreamInterruptionReason::OutputLimit);
            }
            recovery_outcome = None;
        } else {
            let (cause, read_error_retriable, retry_error) = end_cause.unwrap_or((
                StreamEndCause::UnexpectedEof,
                true,
                "Stream ended before a Gemini terminal event".to_string(),
            ));
            let progress = StreamAttemptProgress {
                visible_content_chars: visible_content_char_count(&content_chunks),
                has_tool_state: !tool_calls.is_empty(),
                has_pending_tool_fragments: false,
                provider_terminal: stream_finished,
                user_cancelled: cancel_token.is_cancelled(),
            };
            let decision = decide_stream_recovery(
                cause,
                attempt,
                retry_options,
                read_error_retriable,
                progress,
            );

            match decision {
                StreamRecoveryDecision::Cancelled => {
                    response_status = String::from("cancelled");
                    tool_calls.clear();
                    interruption_reason = None;
                    recovery_outcome = None;
                }
                StreamRecoveryDecision::FinishProviderResult => {}
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
                            response_status = String::from("cancelled");
                            tool_calls.clear();
                            interruption_reason = None;
                            recovery_outcome = None;
                        }
                        Err(wait_error) => return Err(wait_error),
                    }
                }
                StreamRecoveryDecision::KeepUsablePartial
                | StreamRecoveryDecision::SurfaceInterrupted => {
                    response_status = String::from("incomplete");
                    interruption_reason = Some(cause.interruption_reason());
                    recovery_outcome = decision.recovery_outcome(cause, read_error_retriable);
                    if matches!(decision, StreamRecoveryDecision::SurfaceInterrupted) {
                        tool_calls.clear();
                    }
                }
            }
        }

        let content = content_chunks.join("").trim().to_string();
        let thinking = thinking_chunks.join("").trim().to_string();
        let tool_calls_json =
            serde_json::to_string(&tool_calls).unwrap_or_else(|_| "[]".to_string());

        return Ok(GeminiStreamResult {
            id: response_id,
            content,
            thinking,
            model: response_model,
            status: response_status,
            interruption_reason,
            recovery_outcome,
            token_usage,
            tool_calls_json,
            total_duration_ms: stream_start.elapsed().as_millis() as i64,
        });
    }
}

/// Build the HTTP header map for a Gemini request.
///
/// Gemini authenticates via the API key in the URL query string, so no
/// `Authorization` header is needed. User-supplied custom headers are
/// injected afterwards, except `content-type` and `accept-encoding` which
/// are reserved.
pub(super) fn build_header_map(custom_headers: &HashMap<String, String>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));

    inject_custom_headers(
        &mut headers,
        custom_headers,
        &["content-type", "accept-encoding"],
    )?;

    Ok(headers)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures::{stream, Stream, StreamExt};
    use serde_json::Value;
    use tokio::runtime::Builder;
    use tokio_util::sync::CancellationToken;

    use super::super::event::process_gemini_sse_event_block;
    use crate::api::sse::{read_sse_stream_until_terminal, SseStreamEnd};
    use crate::storage::services::chat_conversations::ChatTokenUsage;

    struct ParsedAttempt {
        raw_events: Vec<Value>,
        content_chunks: Vec<String>,
        thinking_chunks: Vec<String>,
        tool_calls: Vec<Value>,
        response_id: String,
        response_model: String,
        response_status: String,
        token_usage: ChatTokenUsage,
        stream_finished: bool,
    }

    impl Default for ParsedAttempt {
        fn default() -> Self {
            Self {
                raw_events: Vec::new(),
                content_chunks: Vec::new(),
                thinking_chunks: Vec::new(),
                tool_calls: Vec::new(),
                response_id: String::new(),
                response_model: String::new(),
                response_status: String::from("completed"),
                token_usage: ChatTokenUsage::default(),
                stream_finished: false,
            }
        }
    }

    impl ParsedAttempt {
        fn process_event_block(&mut self, event_block: &str) -> bool {
            let mut tool_args_delta = String::new();
            process_gemini_sse_event_block(
                event_block,
                &mut self.raw_events,
                &mut self.content_chunks,
                &mut self.thinking_chunks,
                &mut self.tool_calls,
                &mut self.response_id,
                &mut self.response_model,
                &mut self.response_status,
                &mut self.token_usage,
                &mut tool_args_delta,
                &mut self.stream_finished,
            );
            self.stream_finished
        }

        fn content(&self) -> String {
            self.content_chunks.join("")
        }

        fn thinking(&self) -> String {
            self.thinking_chunks.join("")
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("build runtime")
    }

    fn event_bytes(event_json: &str, delimiter_terminated: bool) -> Vec<u8> {
        format!(
            "data: {}{}",
            event_json,
            if delimiter_terminated { "\n\n" } else { "" }
        )
        .into_bytes()
    }

    async fn read_attempt<S, E>(
        mut source: S,
        idle_timeout: Duration,
    ) -> (SseStreamEnd<E>, ParsedAttempt)
    where
        S: Stream<Item = std::result::Result<Vec<u8>, E>> + Unpin,
    {
        let cancel_token = CancellationToken::new();
        let mut byte_buffer = Vec::new();
        let mut attempt = ParsedAttempt::default();
        let end = read_sse_stream_until_terminal(
            &mut source,
            &mut byte_buffer,
            &cancel_token,
            idle_timeout,
            |event_block| attempt.process_event_block(event_block),
        )
        .await;
        (end, attempt)
    }

    #[test]
    fn terminal_event_returns_before_permanently_pending_transport() {
        runtime().block_on(async {
            let terminal_event = event_bytes(
                r#"{"responseId":"terminal","candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}"#,
                true,
            );
            let source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(terminal_event)])
                .chain(stream::pending());

            let (end, attempt) = read_attempt(source, Duration::ZERO).await;

            assert_eq!(end, SseStreamEnd::ProviderTerminal);
            assert!(attempt.stream_finished);
            assert_eq!(attempt.response_status, "completed");
            assert_eq!(attempt.content(), "done");
        });
    }

    #[test]
    fn trailing_terminal_without_delimiter_preserves_output_limit() {
        runtime().block_on(async {
            let source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(event_bytes(
                r#"{"candidates":[{"finishReason":"MAX_TOKENS"}]}"#,
                false,
            ))]);

            let (end, attempt) = read_attempt(source, Duration::from_secs(1)).await;

            assert_eq!(end, SseStreamEnd::ProviderTerminal);
            assert!(attempt.stream_finished);
            assert_eq!(attempt.response_status, "max_tokens");
        });
    }

    #[test]
    fn nonterminal_eof_and_read_error_remain_distinct() {
        runtime().block_on(async {
            let partial_event = event_bytes(
                r#"{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}"#,
                true,
            );
            let eof_source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(partial_event.clone())]);
            let (eof_end, eof_attempt) = read_attempt(eof_source, Duration::from_secs(1)).await;

            let read_error_source = stream::iter(vec![
                Ok::<Vec<u8>, &'static str>(partial_event),
                Err::<Vec<u8>, &'static str>("read failed"),
            ]);
            let (read_error_end, read_error_attempt) =
                read_attempt(read_error_source, Duration::from_secs(1)).await;

            assert_eq!(eof_end, SseStreamEnd::UnexpectedEof);
            assert_eq!(read_error_end, SseStreamEnd::ReadError("read failed"));
            assert_eq!(eof_attempt.content(), "partial");
            assert_eq!(read_error_attempt.content(), "partial");
        });
    }

    #[test]
    fn idle_timeout_remains_a_distinct_stream_end() {
        runtime().block_on(async {
            let source = stream::pending::<std::result::Result<Vec<u8>, &'static str>>();

            let (end, attempt) = read_attempt(source, Duration::ZERO).await;

            assert_eq!(end, SseStreamEnd::IdleTimeout);
            assert!(!attempt.stream_finished);
            assert!(attempt.raw_events.is_empty());
        });
    }

    #[test]
    fn retry_style_second_attempt_starts_with_fresh_accumulators() {
        runtime().block_on(async {
            let first_source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(event_bytes(
                r#"{"responseId":"attempt-1","modelVersion":"gemini-first","candidates":[{"content":{"parts":[{"text":"stale content"},{"text":"stale thinking","thought":true},{"functionCall":{"name":"stale_tool","args":{"value":1}}}]}}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":12}}"#,
                true,
            ))]);
            let (first_end, first_attempt) =
                read_attempt(first_source, Duration::from_secs(1)).await;
            assert_eq!(first_end, SseStreamEnd::UnexpectedEof);
            assert_eq!(first_attempt.content(), "stale content");
            assert_eq!(first_attempt.thinking(), "stale thinking");
            assert_eq!(first_attempt.tool_calls.len(), 1);

            let second_source = stream::iter(vec![Ok::<Vec<u8>, &'static str>(event_bytes(
                r#"{"responseId":"attempt-2","modelVersion":"gemini-second","candidates":[{"content":{"parts":[{"text":"fresh content"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":21,"candidatesTokenCount":22}}"#,
                true,
            ))]);
            let (second_end, second_attempt) =
                read_attempt(second_source, Duration::from_secs(1)).await;

            assert_eq!(second_end, SseStreamEnd::ProviderTerminal);
            assert_eq!(second_attempt.raw_events.len(), 1);
            assert_eq!(second_attempt.content(), "fresh content");
            assert!(second_attempt.thinking_chunks.is_empty());
            assert!(second_attempt.tool_calls.is_empty());
            assert_eq!(second_attempt.response_id, "attempt-2");
            assert_eq!(second_attempt.response_model, "gemini-second");
            assert_eq!(second_attempt.response_status, "completed");
            assert_eq!(second_attempt.token_usage.input_tokens, 21);
            assert_eq!(second_attempt.token_usage.output_tokens, 22);
        });
    }
}
