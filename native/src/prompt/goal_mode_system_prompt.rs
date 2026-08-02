use super::common::{
    apply_role_override, get_current_time_info, get_platform_section,
    get_working_directory_section, read_active_role,
};
use std::path::Path;

/// Generate the Goal Mode system prompt with dynamic context.
///
/// When `goal_mode` is true, this replaces the built-in system prompt with a
/// goal-driven prompt that instructs the AI to work autonomously toward a
/// defined objective across multiple turns until verifiable completion.
///
/// `database_path` locates the app database used to resolve a user-overridden
/// Goal Mode template (see `storage/services/feature_prompts.rs`); the user
/// edits only the template body, while dynamic sections (working directory,
/// platform, token budget) are appended here automatically so the override
/// cannot break variable injection.
///
/// `working_directory` is the resolved filesystem path of the active workspace
/// directory. When empty, the working-directory section is omitted entirely.
///
/// `remote_role_content` carries the project ROLE.md of an `ssh://` workspace,
/// resolved by the Electron main process over SSH (mirroring RoleEditorPanel's
/// access path). `None` for local workspaces, where the project file is read
/// directly.
pub fn build_goal_mode_system_prompt(
    database_path: &Path,
    working_directory: &str,
    shell_type: &str,
    token_budget: i64,
    remote_role_content: Option<&str>,
    remote_include_global_rules: Option<bool>,
) -> String {
    let time_info = get_current_time_info();
    let working_dir_section = get_working_directory_section(working_directory);
    let platform_section = get_platform_section(shell_type);
    let budget_section = get_budget_section(token_budget);

    // 有用户覆盖用覆盖，无覆盖用内置默认模板（解析永不失败）。
    let template = crate::storage::services::feature_prompts::resolve_feature_prompt(
        database_path,
        crate::storage::services::feature_prompts::PROMPT_KEY_GOAL_MODE,
    );

    match read_active_role(working_directory, remote_role_content, remote_include_global_rules) {
        // Override mode: role content replaces the entire template.
        Some((role_content, true)) => format!(
            "{role_content}\n\n{platform_section}\n\n{working_dir_section}\n\n{time_info}{budget_section}"
        ),

        // Normal mode: role content replaces the default role text.
        Some((role_content, false)) => {
            let prompt = apply_role_override(&template, &role_content);
            format!(
                "{prompt}\n\n{platform_section}\n\n{working_dir_section}\n\n{time_info}{budget_section}"
            )
        }

        // No ROLE.md found — use the goal mode template as-is.
        None => format!(
            "{template}\n\n{platform_section}\n\n{working_dir_section}\n\n{time_info}{budget_section}"
        ),
    }
}

fn get_budget_section(token_budget: i64) -> String {
    if token_budget <= 0 {
        return String::new();
    }
    format!(
        "\n\n## Token Budget\n\n\
         You have a total token budget of **{}** tokens for this goal.\n\
         Track your cumulative token usage across all turns. When you estimate you have consumed \
         approximately 80% of the budget, begin wrapping up: finish the current iteration, \
         summarize progress, list remaining work, and provide clear next steps.\n\
         When the budget is exhausted, stop all substantive work immediately and report:\n\
         - What was accomplished\n\
         - What remains incomplete\n\
         - Recommended next steps to continue\n\n\
         Do NOT mark the goal as complete when stopped by budget — only mark complete when \
         all success criteria are verified with evidence.",
        token_budget
    )
}

