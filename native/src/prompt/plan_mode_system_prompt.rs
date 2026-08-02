use super::common::{
    apply_role_override, get_current_time_info, get_platform_section,
    get_working_directory_section, read_active_role,
};
use std::path::Path;

/// Generate the Plan Mode system prompt with dynamic context.
///
/// When `plan_mode` is true, this replaces the built-in system prompt with a
/// planning-focused prompt that instructs the AI to analyze, plan, and get
/// user approval before executing any changes.
///
/// `database_path` locates the app database used to resolve a user-overridden
/// Plan Mode template (see `storage/services/feature_prompts.rs`); the user
/// edits only the template body, while dynamic sections (working directory,
/// platform, date) are appended here automatically so the override cannot
/// break variable injection.
///
/// `working_directory` is the resolved filesystem path of the active workspace
/// directory. When empty, the working-directory section is omitted entirely.
///
/// `remote_role_content` carries the project ROLE.md of an `ssh://` workspace,
/// resolved by the Electron main process over SSH (mirroring RoleEditorPanel's
/// access path). `None` for local workspaces, where the project file is read
/// directly.
pub fn build_plan_mode_system_prompt(
    database_path: &Path,
    working_directory: &str,
    shell_type: &str,
    remote_role_content: Option<&str>,
    remote_include_global_rules: Option<bool>,
) -> String {
    let time_info = get_current_time_info();
    let working_dir_section = get_working_directory_section(working_directory);
    let platform_section = get_platform_section(shell_type);

    // 有用户覆盖用覆盖，无覆盖用内置默认模板（解析永不失败）。
    let template = crate::storage::services::feature_prompts::resolve_feature_prompt(
        database_path,
        crate::storage::services::feature_prompts::PROMPT_KEY_PLAN_MODE,
    );

    match read_active_role(working_directory, remote_role_content, remote_include_global_rules) {
        // Override mode: role content replaces the entire template.
        Some((role_content, true)) => format!(
            "{role_content}\n\n{platform_section}\n\n{working_dir_section}\n\n{time_info}"
        ),

        // Normal mode: role content replaces the default role text.
        Some((role_content, false)) => {
            let prompt = apply_role_override(&template, &role_content);
            format!(
                "{prompt}\n\n{platform_section}\n\n{working_dir_section}\n\n{time_info}"
            )
        }

        // No ROLE.md found — use the plan mode template as-is.
        None => format!(
            "{template}\n\n{platform_section}\n\n{working_dir_section}\n\n{time_info}"
        ),
    }
}

