use napi::bindgen_prelude::*;

use crate::prompt::goal_mode_system_prompt::build_goal_mode_system_prompt;
use crate::prompt::plan_mode_system_prompt::build_plan_mode_system_prompt;
use crate::prompt::system_prompt::build_system_prompt;
use crate::storage::services::chat_conversations::{
    get_conversation_modes, load_context_messages, resolve_conversation_id, ChatContextMessage,
};
use crate::storage::services::system_prompts::resolve_active_system_prompt_contents;
use crate::storage::services::system_settings::get_system_setting_value;
use crate::storage::services::workspace_directories::get_workspace_directory_path;

use super::tool_messages::ensure_tool_pairing;
use super::{images::persist_inline_images_to_disk, ConversationContextRequest};

/// 旁路问答（BTW）的防幻觉约束：无工具、不落库的临时问答只能基于
/// 已加载的会话上下文回答，禁止编造上下文中不存在的信息。
///
/// 约束放在 user 消息前缀而非 system prompt：保持 system 部分与主请求
/// 完全一致，从而复用主请求的 prompt cache 前缀（system + history），
/// 把 btw 的边际成本降到最低（cache 命中折扣而非全价重算）。
const BTW_ANSWER_CONSTRAINT: &str = "\
Answer the question using ONLY the conversation context above. Never invent \
file paths, line numbers, function signatures, or facts that are not present \
in the context. If the information is not available in the context, say so \
explicitly.";

/// 上下文预算中预留给模型输出的比例：输入（system + 历史 + 当前消息）
/// 最多占用上下文窗口的 80%，确保模型压缩/回答仍有足够的输出空间。
const OUTPUT_RESERVE_RATIO: f64 = 0.2;

/// 每条消息的固定 token 开销（角色标记、消息分隔符等）。
const MESSAGE_OVERHEAD_TOKENS: usize = 8;

pub struct PreparedConversationRequest {
    pub conversation_id: String,
    pub messages: Vec<ChatContextMessage>,
    pub current_messages: Vec<ChatContextMessage>,
    /// User-configured system prompt contents resolved from
    /// `system_prompt_ids_json`. Providers use this to decide whether to
    /// keep the built-in system prompt as a `system` message or demote it
    /// to a `user` message (matching Snow CLI PR #127): when non-empty, the
    /// user prompts occupy the `system` slot exclusively and the built-in
    /// prompt is prepended as a leading `user` message.
    pub user_system_prompts: Vec<String>,
}

pub fn prepare_context_request(
    request: ConversationContextRequest<'_>,
) -> Result<PreparedConversationRequest> {
    let mut current_messages = if request.context_compaction {
        let handoff_prompt = if request.goal_mode {
            "Create a durable context handoff for the next assistant. You are in Goal Mode and the context window was exceeded, so this handoff MUST preserve the goal so work continues seamlessly.\n\nOutput ONLY the handoff document in Markdown. It MUST include ALL of the following sections:\n\n## Original Goal\nReproduce the user's original goal verbatim. This is the single most important piece of information — do not paraphrase or abbreviate it.\n\n## Success Criteria\nList every success criterion that defines goal completion. Mark each as [MET], [UNMET], or [UNCERTAIN] with brief evidence.\n\n## Completed Work\nBullet list of changes made so far, with exact file paths and function/symbol names.\n\n## Current State\nWhat the codebase looks like right now after your changes. What builds, what does not, what tests pass or fail.\n\n## Pending Tasks\nWhat remains to be done to achieve the goal, ordered by priority.\n\n## Key Decisions & Constraints\nArchitecture choices, constraints discovered, non-regression boundaries that must be respected.\n\n## Token Budget Status\nHow much of the token budget has been consumed (estimate), and how much remains.\n\n## Next Steps\nThe concrete next 1-3 actions the next assistant should take to continue toward the goal.\n\nRules:\n- Do NOT call tools.\n- Do NOT address the user conversationally.\n- Do NOT declare the goal complete — only the next assistant can do that after verifying.\n- Be concise but never omit information required to continue the work correctly."
        } else {
            "Create a durable context handoff for the next assistant. Output only the handoff document in Markdown. Preserve concrete objectives, user requirements, decisions, architecture constraints, relevant files and symbols, completed changes, current state, pending tasks, exact commands or errors, edge cases, and the next recommended steps. Be concise but do not omit information required to continue the work correctly. Do not call tools and do not address the user conversationally."
        };
        vec![ChatContextMessage {
            role: "user".to_string(),
            content: handoff_prompt.to_string(),
            tool_calls_json: None,
            tool_results_json: None,
            thinking: None,
            thinking_blocks_json: None,
        }]
    } else {
        normalize_messages(request.messages)
    };
    for message in &mut current_messages {
        message.content = persist_inline_images_to_disk(&message.content, request.database_path)?;
    }
    if current_messages.is_empty() {
        return Err(Error::from_reason("Chat message content is required"));
    }

    // --- Lightweight mode: skip history loading and system-prompt injection ---
    if request.skip_context {
        ensure_tool_pairing(&mut current_messages);
        // BTW 旁路问答的无会话模式同样需要防幻觉约束（此时无历史可引用，
        // 模型更应明确"不知道"而非编造）。
        if request.skip_persist {
            if let Some(last_user) = current_messages
                .iter_mut()
                .rev()
                .find(|msg| msg.role.trim() == "user")
            {
                last_user.content =
                    format!("{BTW_ANSWER_CONSTRAINT}\n\n{}", last_user.content);
            }
        }
        return Ok(PreparedConversationRequest {
            conversation_id: String::new(),
            messages: current_messages.clone(),
            current_messages,
            user_system_prompts: Vec::new(),
        });
    }

    let conversation_id = resolve_conversation_id(
        request.database_path,
        request.conversation_id,
        request.previous_response_id,
    )?;
    let mut messages = load_context_messages(request.database_path, &conversation_id)?;

    // Resolve user-configured system prompts (mirrors Snow CLI's
    // `getCustomSystemPromptForConfig`). They are NOT injected into
    // `messages` here; instead they are returned via
    // `PreparedConversationRequest.user_system_prompts` so each provider
    // can decide how to combine them with the built-in system prompt
    // (e.g. Anthropic demotes the built-in prompt to a user message when
    // user prompts are present, matching Snow CLI PR #127).
    let user_system_prompts =
        resolve_active_system_prompt_contents(
            request.database_path,
            request.system_prompt_ids_json,
            request.directory_id,
        );

    // Inject the built-in system prompt as the first message.
    let working_directory = request
        .directory_id
        .and_then(|id| {
            get_workspace_directory_path(request.database_path, id).ok().flatten()
        })
        .unwrap_or_default();

    // Plan Mode: replace the built-in system prompt with the Plan Mode prompt
    // that instructs the AI to analyze, plan, and get user approval before
    // executing any changes.
    let shell_type = resolve_default_shell(request.database_path);
    let system_prompt = if request.plan_mode {
        build_plan_mode_system_prompt(
            request.database_path,
            &working_directory,
            &shell_type,
            request.remote_role_content,
            request.remote_include_global_rules,
        )
    } else if request.goal_mode {
        // Per-conversation budget isolation: the conversation's own override
        // wins, then the global default budget, then the built-in default.
        let goal_token_budget = if !conversation_id.is_empty() {
            get_conversation_modes(request.database_path, &conversation_id)
                .ok()
                .and_then(|modes| modes.goal_mode_token_budget)
                .or_else(|| {
                    crate::storage::services::system_settings::get_goal_mode_token_budget(
                        request.database_path,
                    )
                    .ok()
                })
                .unwrap_or(2000000)
        } else {
            crate::storage::services::system_settings::get_goal_mode_token_budget(
                request.database_path,
            )
            .unwrap_or(2000000)
        };
        build_goal_mode_system_prompt(
            request.database_path,
            &working_directory,
            &shell_type,
            goal_token_budget,
            request.remote_role_content,
            request.remote_include_global_rules,
        )
    } else {
        build_system_prompt(
            &working_directory,
            &shell_type,
            request.remote_role_content,
            request.remote_include_global_rules,
        )
    };

    let has_existing_system = messages
        .iter()
        .any(|msg| msg.role.trim() == "system" || msg.role.trim() == "developer");

    if !has_existing_system {
        messages.insert(
            0,
            ChatContextMessage {
                role: "system".to_string(),
                content: system_prompt,
                tool_calls_json: None,
                tool_results_json: None,
                thinking: None,
                thinking_blocks_json: None,
            },
        );
    }

    // 按 max_context_tokens 预算截断历史：system prompt 与当前请求消息
    // 必须完整保留，只从最旧的历史消息开始丢弃，并预留 20% 输出空间，
    // 防止输入超出模型上下文窗口导致请求被拒。
    apply_context_budget(&mut messages, &current_messages, request.max_context_tokens);

    messages.extend(current_messages.iter().cloned());

    // BTW 旁路问答（skip_persist = true）：临时问答不落库、不带工具。
    // 1) 剥离历史中的工具消息：btw 不携带工具定义，历史残留的
    //    tool_use/tool_result 消息会导致 Anthropic/Gemini 等 provider
    //    拒绝请求（tool_use 块无对应工具定义）。
    // 2) 防幻觉约束放在当前 user 消息（问题）前缀，保持 system 与
    //    主请求完全一致以复用 prompt cache 前缀。
    if request.skip_persist {
        messages = strip_tool_messages(messages);
        if let Some(last_user) = messages
            .iter_mut()
            .rev()
            .find(|msg| msg.role.trim() == "user")
        {
            last_user.content =
                format!("{BTW_ANSWER_CONSTRAINT}\n\n{}", last_user.content);
        }
    }

    // --- Tool-pairing guard: ensure no orphan tool calls or results reach the
    //     AI API, which would reject the request outright. ---
    ensure_tool_pairing(&mut messages);

    Ok(PreparedConversationRequest {
        conversation_id,
        messages,
        current_messages,
        user_system_prompts,
    })
}

/// 剥离历史中的工具消息：BTW 请求不带任何工具定义，历史中残留的
/// tool_use/tool_result 消息会导致 Anthropic/Gemini 等 provider 拒绝
/// 请求（tool_use 块无对应工具定义）。纯工具调用（无文本内容）的
/// assistant 消息仅在无 thinking 时删除——带 thinking 块的消息必须
/// 保留（或保留其 thinking），否则会断裂 Anthropic extended thinking /
/// Responses reasoning 的签名链，与 ensure_tool_pairing 的保护逻辑对齐。
fn strip_tool_messages(messages: Vec<ChatContextMessage>) -> Vec<ChatContextMessage> {
    messages
        .into_iter()
        .filter_map(|mut message| {
            if message.role.trim() == "tool" {
                return None;
            }
            message.tool_calls_json = None;
            message.tool_results_json = None;
            let has_thinking = message
                .thinking
                .as_deref()
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false)
                || message
                    .thinking_blocks_json
                    .as_deref()
                    .map(|t| t.trim() != "[]")
                    .unwrap_or(false);
            if message.content.trim().is_empty() && !has_thinking {
                return None;
            }
            Some(message)
        })
        .collect()
}

fn normalize_messages(messages: &[ChatContextMessage]) -> Vec<ChatContextMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }

            Some(ChatContextMessage {
                role: message.role.trim().to_string(),
                content: content.to_string(),
                tool_calls_json: message.tool_calls_json.clone(),
                tool_results_json: message.tool_results_json.clone(),
                thinking: message.thinking.clone(),
                thinking_blocks_json: message.thinking_blocks_json.clone(),
            })
        })
        .collect()
}

/// 按 max_context_tokens 预算截断历史消息：保留第一条（system prompt 或
/// 最早的消息）与最新消息，从最旧的历史开始丢弃，并预留 20% 输出空间。
/// 当前请求消息（`current_messages`）不参与截断，必须完整保留。
fn apply_context_budget(
    messages: &mut Vec<ChatContextMessage>,
    current_messages: &[ChatContextMessage],
    max_context_tokens: Option<i32>,
) {
    let Some(limit) = max_context_tokens.filter(|limit| *limit > 0) else {
        return;
    };

    // 输入预算 = 上下文窗口 - 输出预留。当前请求消息优先占满预算，
    // 剩余部分才分配给历史。
    let input_budget = ((limit as f64) * (1.0 - OUTPUT_RESERVE_RATIO)) as usize;
    let current_cost: usize = current_messages.iter().map(estimate_message_tokens).sum();
    let history_budget = input_budget.saturating_sub(current_cost);

    // 第一条消息（注入的 system prompt 或最早的消息）始终保留；
    // 没有历史可裁剪时直接返回。
    if messages.len() <= 1 {
        return;
    }

    // 从最新的历史消息向前累计 token 占用，确定可保留的起始下标：
    // 预算越小，保留的越是靠近当前的消息（滑动窗口语义）。
    let mut keep_start = messages.len();
    let mut cost = 0usize;
    for index in (1..messages.len()).rev() {
        cost += estimate_message_tokens(&messages[index]);
        if cost > history_budget {
            break;
        }
        keep_start = index;
    }

    if keep_start == messages.len() {
        // 预算连一条历史消息都放不下：仅保留第一条（system）与最新一条
        // 历史消息（messages 按旧→新排列，最后一条即最新；孤立的工具
        // 消息由 ensure_tool_pairing 兜底修复）。
        let last = messages.pop();
        messages.truncate(1);
        if let Some(last) = last {
            messages.push(last);
        }
    } else if keep_start > 1 {
        // 丢弃 [1..keep_start) 之间的最旧历史。
        messages.drain(1..keep_start);
    }
}

/// 粗略估算一条消息的 token 数：content / thinking / thinking_blocks /
/// 工具调用与结果各按文本估算，另加固定的消息开销。
fn estimate_message_tokens(message: &ChatContextMessage) -> usize {
    estimate_text_tokens(&message.content)
        + message
            .thinking
            .as_deref()
            .map(estimate_text_tokens)
            .unwrap_or(0)
        + message
            .thinking_blocks_json
            .as_deref()
            .map(estimate_text_tokens)
            .unwrap_or(0)
        + message
            .tool_calls_json
            .as_deref()
            .map(estimate_text_tokens)
            .unwrap_or(0)
        + message
            .tool_results_json
            .as_deref()
            .map(estimate_text_tokens)
            .unwrap_or(0)
        + MESSAGE_OVERHEAD_TOKENS
}

/// 粗略估算文本 token 数：CJK 字符按 1 token、其余按 4 字符/token
/// （中英混排的常用近似），下限 1。
fn estimate_text_tokens(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        if is_cjk_char(ch) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + other / 4 + 1
}

/// 是否为 CJK 字符（含全角符号、假名、部首），用于 token 估算。
fn is_cjk_char(ch: char) -> bool {
    matches!(ch as u32,
        0x2E80..=0x2EFF   // 部首补充
        | 0x3000..=0x303F // CJK 标点
        | 0x3040..=0x30FF // 日文假名
        | 0x3400..=0x4DBF // 扩展 A
        | 0x4E00..=0x9FFF // 统一表意
        | 0xF900..=0xFAFF // 兼容表意
        | 0xFF00..=0xFFEF // 全角形式
    )
}

/// Read the user's configured default shell type from the terminal settings
/// stored in the database. The shell type is derived from the configured
/// `shellPath` (e.g. "powershell", "cmd", "gitbash", "wsl", "posix") or an
/// empty string when unavailable.
///
/// The environment described in the system prompt must follow the terminal
/// settings rather than the local OS: the working directory can be a remote
/// SSH location, where commands actually execute in the configured (remote)
/// shell instead of the machine running Snow App.
fn resolve_default_shell(database_path: &std::path::Path) -> String {
    let raw = match get_system_setting_value(database_path, "terminal_settings") {
        Ok(Some(value)) => value,
        _ => return String::new(),
    };
    let shell_path = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|json| json.get("shellPath").and_then(|v| v.as_str().map(String::from)))
        .unwrap_or_default();

    if shell_path.trim().is_empty() {
        return String::new();
    }

    crate::exports::terminal::detect_shell_family(&shell_path)
}
