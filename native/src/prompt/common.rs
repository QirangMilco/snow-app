//! Shared helpers for system prompt builders.
//!
//! Every prompt template (normal / plan mode / goal mode) reuses the same
//! ROLE.md resolution pipeline and the same dynamic-context sections
//! (current date, working directory, platform command guidance). Keeping them
//! here avoids duplicating the logic across prompt variants — future prompts
//! only need to provide their template and call `build_*` helpers.

use std::path::{Path, PathBuf};

use chrono::Local;
use serde_json::Value;

const SETTINGS_DIRECTORY: &str = ".snow";
const SETTINGS_FILE: &str = "settings.json";
const DEFAULT_ROLE_TEXT: &str = "You are Snow AI, an intelligent desktop assistant.";

// ---------------------------------------------------------------------------
// ROLE.md resolution helpers
// ---------------------------------------------------------------------------

/// Try to read a role file, returning trimmed content if it exists and is non-empty.
fn try_read_role_file(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
}

struct RoleSettings {
    active_role_id: Option<String>,
    override_role_ids: Vec<String>,
    include_global_rules: bool,
}

impl Default for RoleSettings {
    fn default() -> Self {
        Self {
            active_role_id: None,
            override_role_ids: Vec::new(),
            include_global_rules: true,
        }
    }
}

/// Read the `role` object from a settings.json file.
fn read_role_settings(settings_path: &Path) -> RoleSettings {
    let content = match std::fs::read_to_string(settings_path) {
        Ok(c) => c,
        Err(_) => return RoleSettings::default(),
    };
    let json: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return RoleSettings::default(),
    };

    let role = match json.get("role") {
        Some(r) => r,
        None => return RoleSettings::default(),
    };

    let active_role_id = role
        .get("activeRoleId")
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let override_role_ids = role
        .get("overrideRoleIds")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let include_global_rules = role
        .get("includeGlobalRules")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    RoleSettings {
        active_role_id,
        override_role_ids,
        include_global_rules,
    }
}

/// Resolve the ROLE file name based on `active_role_id`.
/// - `None` / `"active"` / empty => `ROLE.md`
/// - Otherwise => `ROLE-<id>.md`
fn resolve_role_file_name(active_role_id: &Option<String>) -> String {
    match active_role_id {
        Some(id) if !id.is_empty() && id != "active" => format!("ROLE-{id}.md"),
        _ => "ROLE.md".to_string(),
    }
}

/// Determine whether the resolved active role id is in the override list.
fn is_override_role(active_role_id: &Option<String>, override_role_ids: &[String]) -> bool {
    let resolved_id = match active_role_id {
        Some(id) if !id.is_empty() && id != "active" => id.as_str(),
        _ => "active",
    };
    override_role_ids.iter().any(|id| id == resolved_id)
}

/// Try to read the active ROLE.md content.
///
/// Priority: project scope > global scope.
/// Returns `(content, is_override)` when a non-empty role file is found.
///
/// For `ssh://` workspaces the project ROLE.md cannot be read directly — the
/// Electron main process resolves it over SSH (mirroring RoleEditorPanel's
/// access path) and injects it via `remote_role_content`. The remote
/// `.snow/settings.json` is not readable from here, so remote roles are
/// always treated as non-override ("active").
pub(crate) fn read_active_role(
    working_directory: &str,
    remote_role_content: Option<&str>,
    remote_include_global_rules: Option<bool>,
) -> Option<(String, bool)> {
    let mut project_role: Option<(String, bool)> = None;
    let mut include_global_rules = true;

    if !working_directory.trim().is_empty() {
        if working_directory.starts_with("ssh://") {
            include_global_rules = remote_include_global_rules.unwrap_or(true);
            let content = remote_role_content
                .map(str::trim)
                .filter(|content| !content.is_empty())
                .map(str::to_string);
            if let Some(content) = content {
                project_role = Some((content, false));
            }
        } else {
            let project_dir = Path::new(working_directory);
            let settings_path = project_dir.join(SETTINGS_DIRECTORY).join(SETTINGS_FILE);
            let settings = read_role_settings(&settings_path);
            include_global_rules = settings.include_global_rules;
            let role_file = project_dir.join(resolve_role_file_name(&settings.active_role_id));

            if let Some(content) = try_read_role_file(&role_file) {
                let is_override =
                    is_override_role(&settings.active_role_id, &settings.override_role_ids);
                project_role = Some((content, is_override));
            }
        }
    }

    let global_role = if include_global_rules {
        dirs_next::home_dir().and_then(|home_dir| {
            let global_dir: PathBuf = home_dir.join(SETTINGS_DIRECTORY);
            let settings_path = global_dir.join(SETTINGS_FILE);
            let settings = read_role_settings(&settings_path);
            let role_file = global_dir.join(resolve_role_file_name(&settings.active_role_id));

            try_read_role_file(&role_file).map(|content| {
                let is_override =
                    is_override_role(&settings.active_role_id, &settings.override_role_ids);
                (content, is_override)
            })
        })
    } else {
        None
    };

    combine_role_contents(global_role, project_role)
}

fn combine_role_contents(
    global_role: Option<(String, bool)>,
    project_role: Option<(String, bool)>,
) -> Option<(String, bool)> {
    match (global_role, project_role) {
        (Some((global, global_override)), Some((project, project_override))) => Some((
            format!("## Global rules\n\n{global}\n\n## Project rules\n\n{project}"),
            global_override || project_override,
        )),
        (Some(role), None) | (None, Some(role)) => Some(role),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::combine_role_contents;

    #[test]
    fn combines_global_before_project_rules() {
        let (content, is_override) = combine_role_contents(
            Some(("global rule".to_string(), false)),
            Some(("project rule".to_string(), false)),
        )
        .expect("combined rules");

        assert_eq!(
            content,
            "## Global rules\n\nglobal rule\n\n## Project rules\n\nproject rule"
        );
        assert!(!is_override);
    }

    #[test]
    fn keeps_a_single_enabled_scope_unchanged() {
        let role = ("project only".to_string(), false);
        assert_eq!(combine_role_contents(None, Some(role.clone())), Some(role));
    }
}

/// Replace the default role text in the prompt with the role override block.
pub(crate) fn apply_role_override(prompt: &str, role_content: &str) -> String {
    let override_block = format!(
        "These are the rules emphasized by the user, which must be adhered to 100%:\n{role_content}"
    );
    prompt.replacen(DEFAULT_ROLE_TEXT, &override_block, 1)
}

// ---------------------------------------------------------------------------
// Dynamic context helpers
// ---------------------------------------------------------------------------

pub(crate) fn get_current_time_info() -> String {
    // Keep the system prompt cacheable across turns. A timestamp changes every
    // request and breaks the cached prefix immediately before this section.
    format!("Current Date: {}", Local::now().format("%Y-%m-%d"))
}

pub(crate) fn get_working_directory_section(working_directory: &str) -> String {
    if working_directory.trim().is_empty() {
        return String::new();
    }

    format!(
        "## Working Directory\n\nThe user's current working directory is:\n`{working_directory}`\n\nAll file operations should be relative to this directory unless explicitly specified otherwise."
    )
}

/// Build the platform-specific command requirements section based on the
/// user's configured terminal shell type.
///
/// Bash commands always execute in the shell resolved from the terminal
/// settings' `shellPath`; when unconfigured, the local OS default terminal is
/// used instead (see `resolve_shell_and_args`). The guidance therefore follows
/// `shell_type` when known, and falls back to the local OS otherwise —
/// claiming POSIX on a Windows machine would mislead the AI into using Unix
/// commands that fail in PowerShell/CMD.
pub(crate) fn get_platform_section(shell_type: &str) -> String {
    let (env_label, shell_label, guidance) = match shell_type {
        "cmd" => (
            "Windows",
            "CMD (cmd.exe)",
            "- Use: Windows CMD built-in commands (`del`, `copy`, `move`, `type`, `dir`, etc.)\n\
             - Shell operators: `&`, `&&`, `||`\n\
             - Path separator: `\\`\n\
             - No PowerShell cmdlets — use CMD equivalents (e.g. `del` not `Remove-Item`)",
        ),
        "gitbash" => (
            "Windows (Git Bash)",
            "Git Bash (MSYS2/MinGW)",
            "- Use: Unix/POSIX commands (`rm`, `cp`, `mv`, `cat`, `ls`, `grep`, etc.)\n\
             - Shell operators: `;`, `&&`, `||`, `|`\n\
             - Path separator: `/` (forward slash)\n\
             - Supports bash scripting syntax",
        ),
        "wsl" => (
            "WSL (Linux)",
            "WSL (Windows Subsystem for Linux)",
            "- Use: Linux commands (`rm`, `cp`, `mv`, `cat`, `ls`, `grep`, etc.)\n\
             - Shell operators: `;`, `&&`, `||`, `|`\n\
             - Path separator: `/` (forward slash)\n\
             - Windows drives accessible via `/mnt/c/`, `/mnt/d/`, etc.\n\
             - Supports full bash/zsh scripting syntax",
        ),
        "powershell" => (
            "Windows",
            "PowerShell",
            "- Use: PowerShell cmdlets (`Remove-Item`, `Copy-Item`, `Move-Item`, `Get-Content`, etc.)\n\
             - Shell operators: `;`, `&&`, `||` (PowerShell 7+)\n\
             - Path separator: `\\` or `/` (both work)\n\
             - No Unix commands — use PowerShell cmdlet equivalents (e.g. `Get-ChildItem` not `ls`, `Get-Content` not `cat`, `Remove-Item` not `rm`)",
        ),
        // Unconfigured/unknown shell type: commands still execute in the local
        // OS default terminal (see resolve_shell_and_args), so fall back to the
        // local OS instead of claiming POSIX — on Windows that would mislead
        // the AI into using Unix commands that do not exist in PowerShell/CMD.
        _ if cfg!(target_os = "windows") => (
            "Windows",
            "Default Windows shell (PowerShell or CMD)",
            "- Use: PowerShell cmdlets (`Get-ChildItem`, `Get-Content`, `Remove-Item`, `Copy-Item`, etc.) or CMD built-ins (`dir`, `type`, `del`, `copy`)\n\
             - Shell operators: `;` (PowerShell) or `&`, `&&`, `||` (CMD)\n\
             - Path separator: `\\`\n\
             - No Unix commands — use the Windows equivalents",
        ),
        _ => (
            "POSIX",
            "POSIX Shell",
            "- Use: `rm`, `cp`, `mv`, `grep`, `cat`, `ls`, `mkdir`, `rmdir`, `find`, `sed`, `awk`\n\
             - Supports: `&&`, `||`, pipes `|`, redirection `>`, `<`, `>>`",
        ),
    };

    format!(
        "## Platform-Specific Command Requirements\n\n\
         **Current Environment: {env_label}**\n\
         **Active Shell: {shell_label}**\n\n\
         {guidance}"
    )
}
