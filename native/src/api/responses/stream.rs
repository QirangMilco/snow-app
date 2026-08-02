//! Responses API streaming response collection — retry loop, event
//! dispatch, and partial tool-call reconstruction.
//!
//! Unlike the other providers, Responses uses the `async_openai` SDK
//! streaming API instead of raw reqwest bytes. The SDK delivers parsed
//! JSON values, so the event processing here is inline rather than
//! delegated to a separate `process_*_event` function.
use std::collections::HashMap;


use async_openai::{config::OpenAIConfig, error::OpenAIError, Client};
use futures::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::api::common::emit_stream_chunk;
use crate::api::retry::{non_sse_response_error, should_retry, wait_before_retry, RetryOptions};
use crate::api::responses::payload::{is_stream_ended_error, ResponseValueStream};
use crate::api::responses::{
    ResponsesApiStreamCallback, ResponsesApiStreamChunk,
};
use crate::api::token_counter::count_tokens;
use crate::storage::services::chat_conversations::ChatTokenUsage;
use super::event::{
    collect_reasoning_items, collect_reasoning_text, collect_text_values, collect_tool_calls,
    extract_output_text, extract_response_thinking, extract_token_usage, read_response_string,
    read_stream_text_delta,
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
    pub token_usage: ChatTokenUsage,
    pub tool_calls_json: String,
    pub raw_events: Vec<Value>,
    pub tool_parse_errors: Vec<String>,
    pub total_duration_ms: i64,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn collect_streaming_response(
    client: &Client<OpenAIConfig>,
    payload: Value,
    on_chunk: &ResponsesApiStreamCallback,
    cancel_token: &CancellationToken,
    retry_options: &RetryOptions,
) -> Result<StreamingResponseResult> {
    let responses = client.responses();
    let mut attempt: u32 = 0;
    // Cumulative token counter for the current agent-loop iteration.
    // Declared here (before the retry loop) so retry chunks can report
    // the current cumulative value. The counter is mutated by
    // `emit_stream_chunk` and the tool-argument probe below.
    let mut stream_token_count: usize = 0;
    let stream_start = std::time::Instant::now();
    let mut ttft_ms: i64 = 0;

    loop {
        if cancel_token.is_cancelled() {
            return Ok(StreamingResponseResult {
                id: String::new(),
                content: String::new(),
                thinking: String::new(),
                reasoning_items_json: "[]".to_string(),
                model: String::new(),
                status: String::from("cancelled"),
                token_usage: ChatTokenUsage {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
                tool_calls_json: "[]".to_string(),
                raw_events: Vec::new(),
                tool_parse_errors: Vec::new(),
                total_duration_ms: stream_start.elapsed().as_millis() as i64,
            });
        }

        let mut stream: ResponseValueStream = loop {
            if cancel_token.is_cancelled() {
                return Ok(StreamingResponseResult {
                    id: String::new(),
                    content: String::new(),
                    thinking: String::new(),
                    reasoning_items_json: "[]".to_string(),
                    model: String::new(),
                    status: String::from("cancelled"),
                    token_usage: ChatTokenUsage {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                    tool_calls_json: "[]".to_string(),
                    raw_events: Vec::new(),
                    tool_parse_errors: Vec::new(),
                    total_duration_ms: stream_start.elapsed().as_millis() as i64,
                });
            }

            let create_stream_future = responses.create_stream_byot::<Value, Value>(payload.clone());

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
                        token_usage: ChatTokenUsage {
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                        tool_calls_json: "[]".to_string(),
                        raw_events: Vec::new(),
                        tool_parse_errors: Vec::new(),
                        total_duration_ms: stream_start.elapsed().as_millis() as i64,
                    });
                }
                result = create_stream_future => {
                    result.map_err(|error| Error::from_reason(format!("Failed to create response stream: {error}")))
                }
            };

            match result {
                Ok(stream) => break stream,
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
                        },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );

                    match wait_before_retry(retry_options, cancel_token, attempt).await {
                        Ok(()) => { attempt += 1; continue; }
                        Err(e) => return Err(e),
                    }
                }
            }
        };

        // ---- Phase 2: consume the stream ----
        // All accumulated state is declared per-attempt so a retry starts fresh.
        let mut raw_events = Vec::new();
        let mut content_chunks = Vec::new();
        let mut thinking_chunks = Vec::new();
        let mut tool_calls = Vec::new();
        // Capture reasoning output items (type=reasoning with encrypted_content)
        // from `response.output_item.done` events so they can be round-tripped
        // verbatim on the next request when store:false.
        let mut reasoning_items: Vec<Value> = Vec::new();
        let mut tool_parse_errors: Vec<String> = Vec::new();
        // Streaming tool-call accumulator: maps output_item index -> (item_json, accumulated_arguments).
        // When the stream ends abruptly (network error, server disconnect) before
        // `response.output_item.done` fires, we rebuild tool calls from these
        // partial entries so the agent loop can still execute the requested tools
        // instead of silently dropping them.
        let mut streaming_tool_items: HashMap<u64, (Value, String)> =
            HashMap::new();
        let mut completed_response: Option<Value> = None;
        let mut response_id = String::new();
        let mut response_model = String::new();
        let mut response_status = String::from("completed");
        let mut token_usage = ChatTokenUsage {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        };
        // Track whether the stream completed normally. If the loop exits because
        // of a read error or unexpected EOF (not via response.completed/incomplete/
        // failed event, and not via cancellation), we mark the response as
        // "incomplete" so the frontend can still process any collected content
        // and tool calls instead of treating it as a hard failure.
        let mut stream_completed_normally = false;
        // Whether any `response.reasoning_text.delta` (full reasoning text)
        // events were observed. Some models/relays stream the complete reasoning
        // text even when `reasoning.summary` is "auto", and also emit the summary
        // deltas afterwards. Appending both would duplicate the thinking block
        // (summary is a condensed re-statement of the full reasoning), so once
        // the full reasoning text is streaming we suppress the summary deltas.
        let mut reasoning_text_streamed = false;

        loop {
            tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    response_status = String::from("cancelled");
                    stream_completed_normally = true;
                    break;
                }
                event_result = stream.next() => {
                    let Some(event_result) = event_result else {
                        // Stream ended without an explicit terminal event. Treat
                        // this as an incomplete response rather than a hard error
                        // so partial content and tool calls remain usable.
                        break;
                    };

                    let event = match event_result {
                        Ok(event) => event,
                        Err(error) if is_stream_ended_error(&error) => break,
                        Err(error) => {
                            // Network/read error mid-stream: log and break instead
                            // of returning Err. We keep whatever content and tool
                            // calls have been collected so far so the agent loop
                            // can continue with partial results.
                            eprintln!("Responses stream read error (keeping partial result): {error}");
                            break;
                        }
                    };
                    let event_type = event.get("type").and_then(Value::as_str).unwrap_or_default();

                    match event_type {
                        "response.output_text.delta" => {
                            let content_delta = read_stream_text_delta(event.get("delta"));
                            if !content_delta.is_empty() {
                                content_chunks.push(content_delta.clone());
                                if ttft_ms == 0 {
                                    ttft_ms = stream_start.elapsed().as_millis() as i64;
                                }
                                emit_stream_chunk(
                                    on_chunk,
                                    content_delta,
                                    String::new(),
                                    &mut stream_token_count,
                                    stream_start.elapsed().as_millis() as i64,
                                    ttft_ms,
                                );
                            }
                        }
                        // Full reasoning text delta. This is the primary thinking
                        // stream for reasoning models: it arrives BEFORE any
                        // `response.output_text.delta` (reasoning happens first),
                        // so it must be pushed to the frontend in real time —
                        // otherwise the thinking block only appears after the
                        // entire response has finished rendering.
                        "response.reasoning_text.delta" => {
                            reasoning_text_streamed = true;
                            let thinking_delta = read_stream_text_delta(event.get("delta"));
                            if !thinking_delta.is_empty() {
                                thinking_chunks.push(thinking_delta.clone());
                                if ttft_ms == 0 {
                                    ttft_ms = stream_start.elapsed().as_millis() as i64;
                                }
                                emit_stream_chunk(
                                    on_chunk,
                                    String::new(),
                                    thinking_delta,
                                    &mut stream_token_count,
                                    stream_start.elapsed().as_millis() as i64,
                                    ttft_ms,
                                );
                            }
                        }
                        "response.reasoning_summary_text.delta" => {
                            // The summary is a condensed re-statement of the full
                            // reasoning text. If the full text was already
                            // streamed via `response.reasoning_text.delta`,
                            // appending the summary would duplicate the thinking
                            // block, so suppress it in that case.
                            if !reasoning_text_streamed {
                                let thinking_delta = read_stream_text_delta(event.get("delta"));
                                if !thinking_delta.is_empty() {
                                    thinking_chunks.push(thinking_delta.clone());
                                    if ttft_ms == 0 {
                                        ttft_ms = stream_start.elapsed().as_millis() as i64;
                                    }
                                    emit_stream_chunk(
                                        on_chunk,
                                        String::new(),
                                        thinking_delta,
                                        &mut stream_token_count,
                                        stream_start.elapsed().as_millis() as i64,
                                        ttft_ms,
                                    );
                                }
                            }
                        }
                        "response.reasoning_summary.delta" => {
                            // See reasoning_summary_text.delta above: skip the
                            // summary when the full reasoning text is streamed.
                            if !reasoning_text_streamed {
                                if let Some(delta) = event.get("delta") {
                                    let mut delta_chunks = Vec::new();
                                    collect_text_values(delta, &mut delta_chunks);
                                    let thinking_delta = delta_chunks.join("");
                                    if !thinking_delta.is_empty() {
                                        thinking_chunks.push(thinking_delta.clone());
                                        if ttft_ms == 0 {
                                            ttft_ms = stream_start.elapsed().as_millis() as i64;
                                        }
                                        emit_stream_chunk(
                                            on_chunk,
                                            String::new(),
                                            thinking_delta,
                                            &mut stream_token_count,
                                            stream_start.elapsed().as_millis() as i64,
                                            ttft_ms,
                                        );
                                    }
                                }
                            }
                        }
                        // Tool-call argument deltas. The Responses API streams
                        // function arguments as they are generated. We count
                        // these tokens immediately so the probe reflects long
                        // tool arguments in real time, rather than waiting for
                        // `response.output_item.done` to assemble the full call.
                        //
                        // The chunk is emitted as a probe-only update: both
                        // content_delta and thinking_delta are empty because the
                        // argument text should NOT be appended to the assistant
                        // message body — it is assembled separately by
                        // `collect_tool_calls` on `output_item.done`.
                        //
                        // We also accumulate the argument fragments per output
                        // item index so that, if the stream is interrupted before
                        // `output_item.done`, we can still reconstruct the tool
                        // call with its (possibly partial) arguments.
                        "response.function_call_arguments.delta" => {
                            let args_delta = read_stream_text_delta(event.get("delta"));
                            if !args_delta.is_empty() {
                                let delta_tokens =
                                    count_tokens(&args_delta);
                                stream_token_count += delta_tokens;
                                if ttft_ms == 0 {
                                    ttft_ms = stream_start.elapsed().as_millis() as i64;
                                }
                                on_chunk.call(
                                    ResponsesApiStreamChunk {
                                        content_delta: String::new(),
                                        thinking_delta: String::new(),
                                        content: String::new(),
                                        thinking: String::new(),
                                        retrying: false,
                                        retry_attempt: None,
                                        retry_error: None,
                                        stream_token_count: stream_token_count as i64,
                                        elapsed_ms: stream_start.elapsed().as_millis() as i64,
                                        ttft_ms,
                                    },
                                    ThreadsafeFunctionCallMode::NonBlocking,
                                );

                                // Accumulate argument fragments for partial-recovery.
                                if let Some(index) = event
                                    .get("output_index")
                                    .and_then(Value::as_u64)
                                    .or_else(|| event.get("index").and_then(Value::as_u64))
                                {
                                    streaming_tool_items
                                        .entry(index)
                                        .and_modify(|(_, args)| args.push_str(&args_delta))
                                        .or_insert_with(|| (Value::Null, args_delta));
                                }
                            }
                        }
                        // Track newly added function_call output items so we can
                        // reconstruct them (name + call_id) if the stream ends
                        "response.output_item.added" => {
                            if let Some(item) = event.get("item") {
                                let item_type = item
                                    .get("type")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default();

                                // Capture reasoning items (with encrypted_content)
                                // as early as possible. If the stream is
                                // interrupted after `added` but before
                                // `output_item.done`, we still retain the
                                // reasoning item for round-tripping.
                                if item_type == "reasoning" {
                                    reasoning_items.push(item.clone());
                                }

                                if matches!(
                                    item_type,
                                    "function_call" | "tool_call" | "custom_tool_call" | "mcp_call"
                                ) {
                                    if let Some(index) = event
                                        .get("output_index")
                                        .and_then(Value::as_u64)
                                        .or_else(|| event.get("index").and_then(Value::as_u64))
                                    {
                                        streaming_tool_items
                                            .entry(index)
                                            .and_modify(|(stored, _)| *stored = item.clone())
                                            .or_insert_with(|| (item.clone(), String::new()));
                                    }
                                }
                            }
                        }
                        "response.output_item.done" => {
                            // Capture reasoning items (with encrypted_content)
                            // for round-tripping when store:false. Also handles
                            // the case where `added` already captured it — we
                            // replace with the final/done version which may
                            // contain the complete summary.
                            if let Some(item) = event.get("item") {
                                let item_type = item
                                    .get("type")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default();
                                if item_type == "reasoning" {
                                    // Replace any prior entry from `added` with
                                    // the finalised `done` version, or push if
                                    // not already tracked.
                                    if let Some(pos) = reasoning_items
                                        .iter()
                                        .position(|existing| {
                                            existing.get("id").and_then(Value::as_str)
                                                == item.get("id").and_then(Value::as_str)
                                        })
                                    {
                                        reasoning_items[pos] = item.clone();
                                    } else {
                                        reasoning_items.push(item.clone());
                                    }
                                }
                            }
                            collect_tool_calls(event.get("item"), &mut tool_calls);
                            // Remove from the streaming map once finalized.
                            if let Some(index) = event
                                .get("output_index")
                                .and_then(Value::as_u64)
                                .or_else(|| event.get("index").and_then(Value::as_u64))
                            {
                                streaming_tool_items.remove(&index);
                            }
                        }
                        "response.completed" | "response.incomplete" | "response.failed" => {
                            stream_completed_normally = true;
                            if let Some(response) = event.get("response") {
                                response_id = read_response_string(response, "id").unwrap_or(response_id);
                                response_model = read_response_string(response, "model").unwrap_or(response_model);
                                response_status = read_response_string(response, "status").unwrap_or_else(|| {
                                    if event_type == "response.failed" {
                                        "failed".to_string()
                                    } else if event_type == "response.incomplete" {
                                        "incomplete".to_string()
                                    } else {
                                        response_status.clone()
                                    }
                                });
                                token_usage = extract_token_usage(response);
                                completed_response = Some(response.clone());
                            }
                        }
                        "error" => {
                            let message = event
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Responses stream failed");
                            return Err(Error::from_reason(message.to_string()));
                        }
                        _ => {}
                    }

                    raw_events.push(event);
                }
            }
        }

        // If the stream ended abnormally (no terminal event and no cancellation),
        // mark the response as incomplete so the frontend knows the result is
        // partial but still usable.
        if !stream_completed_normally && response_status == "completed" {
            response_status = String::from("incomplete");
        }

        // Reconstruct tool calls from streaming fragments when the normal
        // `output_item.done` path did not fire for every item. This handles the
        // case where the stream was interrupted mid-tool-call: we take the item
        // metadata (name, call_id) captured in `output_item.added` and attach the
        // accumulated argument fragments. Even if the arguments are partial JSON,
        // we pass them through as a string so the frontend/tool layer can decide
        // how to handle them.
        if tool_calls.is_empty() && !streaming_tool_items.is_empty() {
            let mut indices: Vec<u64> = streaming_tool_items.keys().copied().collect();
            indices.sort_unstable();
            for index in indices {
                let (item, args) = streaming_tool_items.remove(&index).unwrap();
                if item.is_null() {
                    // We have arguments but no item metadata — cannot reconstruct
                    // a meaningful tool call without name/call_id. Skip it.
                    continue;
                }
                let mut reconstructed = item;
                if !args.is_empty() {
                    // Try to parse the accumulated arguments as JSON; if that
                    // fails, embed the raw string so the tool layer can surface a
                    // clear error rather than silently dropping the call.
                    if let Ok(parsed) = serde_json::from_str::<Value>(&args) {
                        reconstructed
                            .as_object_mut()
                            .map(|obj| obj.insert("arguments".to_string(), parsed));
                    } else {
                        tool_parse_errors.push(format!(
                            "tool=reconstructed, error=invalid JSON, raw={}",
                            &args[..args.len().min(200)]
                        ));
                        reconstructed
                            .as_object_mut()
                            .map(|obj| obj.insert("arguments".to_string(), Value::String(args)));
                    }
                }
                tool_calls.push(reconstructed);
            }
        }

        if let Some(response) = completed_response.as_ref() {
            if content_chunks.is_empty() {
                let content = extract_output_text(response);
                if !content.is_empty() {
                    content_chunks.push(content);
                }
            }

            if thinking_chunks.is_empty() {
                let thinking = extract_response_thinking(response);
                if !thinking.is_empty() {
                    thinking_chunks.push(thinking);
                }
            }

            if tool_calls.is_empty() {
                collect_tool_calls(response.get("output"), &mut tool_calls);
            }

            // Fallback: extract reasoning items from the completed response's
            // output tree. Some providers (e.g. DeepSeek's Responses API) stream
            // reasoning via `response.reasoning_text.delta` events but do NOT
            // emit `output_item.added`/`done` with type=reasoning, so the
            // streaming capture above leaves reasoning_items empty. Without
            // these items the next request cannot round-trip reasoning, and
            // DeepSeek rejects it with HTTP 400 "The reasoning_text in the
            // thinking mode must be passed back to the API."
            if reasoning_items.is_empty() {
                collect_reasoning_items(response.get("output"), &mut reasoning_items);
            }
        }

        // Last-resort synthesis: if we still have no structured reasoning
        // items but did receive reasoning text (via reasoning_text.delta or
        // reasoning_summary_text.delta), build a minimal reasoning item so
        // the next request can round-trip it. The item carries the full
        // text in a `reasoning_text` field — the same field DeepSeek
        // expects to receive back.
        if reasoning_items.is_empty() {
            let thinking = thinking_chunks.join("").trim().to_string();
            if !thinking.is_empty() {
                reasoning_items.push(json!({
                    "type": "reasoning",
                    "reasoning_text": thinking,
                }));
            }
        }

        // Non-SSE response detection: the stream produced zero events. This
        // happens when a relay returns HTTP 200 with a JSON error body (e.g.
        // quota exhausted) instead of a proper SSE stream. The async_openai
        // library may surface this as an empty stream rather than an error.
        //
        // The ONLY reliable signal is raw_events being empty — if we received
        // any SSE event at all (even a bare `response.output_item.added` with
        // a reasoning item and no text content), the stream is valid and must
        // NOT be treated as an error. Checking content/thinking/tool_calls for
        // emptiness causes false positives on reasoning-only responses.
        //
        // Treat it as a retriable error so the request is re-issued with the
        // original parameters, matching the Anthropic/Chat recovery pattern.
        if !stream_completed_normally
            && response_status != "cancelled"
            && raw_events.is_empty()
        {
            let error = non_sse_response_error("stream ended with zero events");

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

        let content = content_chunks.join("").trim().to_string();
        let thinking = thinking_chunks.join("").trim().to_string();
        let tool_calls_json = serde_json::to_string(&tool_calls).unwrap_or_else(|_| "[]".to_string());
        let reasoning_items_json =
            serde_json::to_string(&reasoning_items).unwrap_or_else(|_| "[]".to_string());

        // Silence unused-import warning — collect_reasoning_text is re-exported
        // for downstream modules that may reference it via the responses module.
        let _ = collect_reasoning_text as fn(Option<&Value>, &mut Vec<String>);

        return Ok(StreamingResponseResult {
            id: response_id,
            content,
            thinking,
            reasoning_items_json,
            model: response_model,
            status: response_status,
            token_usage,
            tool_calls_json,
            raw_events,
            tool_parse_errors,
            total_duration_ms: stream_start.elapsed().as_millis() as i64,
        });
    }
}

// Silence unused import warnings for type aliases re-exported from payload.
const _: fn() = || {
    let _: fn(&OpenAIError) -> bool = is_stream_ended_error;
};

