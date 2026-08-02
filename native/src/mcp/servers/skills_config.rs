//! Built-in MCP service that lets the agent manage Snow App skills:
//! list the available skills (global + project scope), toggle their
//! enabled state (global = SKILL.md frontmatter, project = app DB
//! override), and install/uninstall skills from GitHub.
//!
//! Tools:
//! - `skills-config-list`          — list available skills + GitHub-installed records
//! - `skills-config-setEnabled`    — toggle a skill (global frontmatter or project DB override)
//! - `skills-config-installGithub` — install skill(s) from a GitHub repository
//! - `skills-config-uninstall`     — uninstall a GitHub-installed skill
//!
//! The implementation reuses the exact same native entry points as the UI
//! (SkillsService + skills_installer), so the agent and the UI always agree
//! on the effective state.

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::skills::SkillsService;
use super::skills_installer::{
    install_skill_from_github, list_github_skills, uninstall_github_skill,
};

pub const SERVER_ID: &str = "skills-config";

const TOOL_LIST: &str = "list";
const TOOL_SET_ENABLED: &str = "setEnabled";
const TOOL_INSTALL_GITHUB: &str = "installGithub";
const TOOL_UNINSTALL: &str = "uninstall";

pub struct SkillsConfigService;

impl SkillsConfigService {
    pub fn new() -> Self {
        Self
    }

    /// Async entry point used by `call_mcp_tool` in tools.rs.
    ///
    /// Every underlying operation (`SkillsService::*`, `skills_installer::*`)
    /// is itself async and already moves blocking work onto the blocking pool,
    /// so no extra `spawn_blocking` wrapper is needed here.
    pub async fn execute_async(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_LIST => self.execute_list(args).await,
            TOOL_SET_ENABLED => self.execute_set_enabled(args).await,
            TOOL_INSTALL_GITHUB => self.execute_install_github(args).await,
            TOOL_UNINSTALL => self.execute_uninstall(args).await,
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [skills-config-list, skills-config-setEnabled, skills-config-installGithub, skills-config-uninstall]"
                ),
            )),
        }
    }

    /// List available skills plus GitHub-installed records.
    ///
    /// - Without `projectId`: global view. `enabled` is the SKILL.md
    ///   frontmatter `enable` field (the file is the source of truth).
    /// - With `projectId`: project-scoped view. Skills are merged from the
    ///   four scan directories (~/.agents/skills → ~/.snow/skills →
    ///   <project>/.agents/skills → <project>/.snow/skills, higher priority
    ///   wins); `enabled` is the effective state (project DB override >
    ///   frontmatter) and `defaultEnabled` is the frontmatter value.
    async fn execute_list(&self, args: &Value) -> napi::Result<Value> {
        let project_id = optional_string(args, "projectId")?;

        let skills: Vec<Value> = if let Some(project_id) = &project_id {
            SkillsService::new()
                .list_project(project_id)
                .await?
                .into_iter()
                .map(|skill| {
                    json!({
                        "id": skill.id,
                        "name": skill.name,
                        "description": skill.description,
                        "location": skill.location,
                        "source": skill.source,
                        "path": skill.path,
                        "allowedTools": skill.allowed_tools,
                        "defaultEnabled": skill.default_enabled,
                        "enabled": skill.enabled,
                    })
                })
                .collect()
        } else {
            SkillsService::new()
                .list_available(None)
                .await?
                .into_iter()
                .map(|skill| {
                    json!({
                        "id": skill.id,
                        "name": skill.name,
                        "description": skill.description,
                        "location": skill.location,
                        "source": skill.source,
                        "path": skill.path,
                        "allowedTools": skill.allowed_tools,
                        "enabled": skill.enabled,
                    })
                })
                .collect()
        };

        let github_installed: Vec<Value> = list_github_skills()
            .await?
            .into_iter()
            .map(|record| {
                json!({
                    "id": record.id,
                    "name": record.name,
                    "description": record.description,
                    "location": record.location,
                    "sourceUrl": record.source_url,
                    "installedAt": record.installed_at,
                    "commitSha": record.commit_sha,
                })
            })
            .collect();

        Ok(json!({
            "projectId": project_id,
            "skills": skills,
            "githubInstalled": github_installed,
        }))
    }

    /// Enable or disable a skill.
    ///
    /// - Without `projectId`: global toggle. Writes the `enable` field in the
    ///   SKILL.md frontmatter (same file rewrite as the UI toggle). Note the
    ///   frontmatter field name is `enable`, not `enabled`.
    /// - With `projectId`: project-scope toggle. Writes a DB override in the
    ///   app database (`skill_overrides`), which takes effect immediately and
    ///   takes precedence over the frontmatter value.
    async fn execute_set_enabled(&self, args: &Value) -> napi::Result<Value> {
        let project_id = optional_string(args, "projectId")?;
        let skill_id = required_string(args, "skillId")?;
        let enabled = required_bool(args, "enabled")?;

        match &project_id {
            Some(project_id) => {
                SkillsService::new()
                    .set_project_enabled(project_id, &skill_id, enabled)
                    .await?;
                Ok(json!({
                    "skillId": skill_id,
                    "projectId": project_id,
                    "scope": "project",
                    "enabled": enabled,
                    "method": "db-override",
                }))
            }
            None => {
                SkillsService::new()
                    .set_enabled(None, &skill_id, enabled)
                    .await?;
                Ok(json!({
                    "skillId": skill_id,
                    "projectId": null,
                    "scope": "global",
                    "enabled": enabled,
                    "method": "frontmatter",
                }))
            }
        }
    }

    /// Install skill(s) from a GitHub repository.
    ///
    /// `url` accepts `https://github.com/owner/repo`, the `owner/repo`
    /// shorthand, optional `@branch` and `:sub/dir` suffixes. `location` must
    /// be `global` (~/.snow/skills) or `project` (<project>/.snow/skills,
    /// requires `projectId`). Metadata is recorded in
    /// `~/.snow/skills-registry.json` so `skills-config-uninstall` can remove
    /// the skill later.
    async fn execute_install_github(&self, args: &Value) -> napi::Result<Value> {
        let url = required_string(args, "url")?;
        let location = required_string(args, "location")?;
        if location != "global" && location != "project" {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "location must be \"global\" or \"project\", got \"{location}\""
                ),
            ));
        }
        let project_id = optional_string(args, "projectId")?;

        let result = install_skill_from_github(url, location, project_id.clone()).await?;
        let results: Vec<Value> = result
            .results
            .into_iter()
            .map(|entry| {
                json!({
                    "success": entry.success,
                    "skillId": entry.skill_id,
                    "path": entry.path,
                    "installedAt": entry.installed_at,
                    "commitSha": entry.commit_sha,
                    "error": entry.error,
                })
            })
            .collect();

        Ok(json!({
            "success": result.success,
            "results": results,
            "installedCount": result.installed_count,
            "totalCount": result.total_count,
            "commitSha": result.commit_sha,
            "error": result.error,
        }))
    }

    /// Uninstall a skill that was installed from GitHub.
    ///
    /// Only skills recorded in `~/.snow/skills-registry.json` can be removed
    /// this way; manually placed or app-bundled skills are rejected (delete
    /// their directory instead).
    async fn execute_uninstall(&self, args: &Value) -> napi::Result<Value> {
        let skill_id = required_string(args, "skillId")?;
        let project_id = optional_string(args, "projectId")?;

        let result = uninstall_github_skill(skill_id, project_id.clone()).await?;
        Ok(json!({
            "success": result.success,
            "skillId": result.skill_id,
            "message": result.message,
            "error": result.error,
        }))
    }
}

impl McpService for SkillsConfigService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_LIST.to_string(),
                description: "List available skills and GitHub-installed skill records. Without projectId: global view where `enabled` is the SKILL.md frontmatter `enable` field (the file is the source of truth). With projectId: project-scoped view where skills are merged from the four scan directories (~/.agents/skills, ~/.snow/skills, <project>/.agents/skills, <project>/.snow/skills; higher priority wins) and `enabled` is the effective state (project DB override > frontmatter), with `defaultEnabled` = frontmatter value. `githubInstalled` lists skills installed from GitHub (see skills-config-installGithub).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "projectId": {
                            "type": "string",
                            "description": "Optional project id; when omitted the global (frontmatter-based) view is returned."
                        }
                    },
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_SET_ENABLED.to_string(),
                description: "Enable or disable a skill. Without projectId: global toggle that rewrites the `enable` field in the SKILL.md frontmatter (same file write as the UI toggle; note the field name is `enable`, not `enabled`). With projectId: project-scope toggle that writes a DB override in the app database (takes effect immediately and takes precedence over the frontmatter). Returns the applied scope and method.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "projectId": {
                            "type": "string",
                            "description": "Optional project id; when provided the project-scope DB override is toggled instead of the global frontmatter."
                        },
                        "skillId": {
                            "type": "string",
                            "description": "Skill id (relative path of the skill directory, e.g. snow-app-docs or vendor/skill-name)."
                        },
                        "enabled": {
                            "type": "boolean",
                            "description": "New enabled state."
                        }
                    },
                    "required": ["skillId", "enabled"],
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_INSTALL_GITHUB.to_string(),
                description: "Install skill(s) from a GitHub repository. url accepts https://github.com/owner/repo, the owner/repo shorthand, optional @branch and :sub/dir suffixes. location must be 'global' (~/.snow/skills) or 'project' (<project>/.snow/skills, requires projectId). Metadata is recorded in ~/.snow/skills-registry.json so skills-config-uninstall can remove the skill later. Requires network access to github.com.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "GitHub repository URL or owner/repo shorthand, optionally with @branch and :sub/dir."
                        },
                        "location": {
                            "type": "string",
                            "enum": ["global", "project"],
                            "description": "Install target: global (~/.snow/skills) or project (<project>/.snow/skills)."
                        },
                        "projectId": {
                            "type": "string",
                            "description": "Required when location is 'project'."
                        }
                    },
                    "required": ["url", "location"],
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_UNINSTALL.to_string(),
                description: "Uninstall a skill that was installed from GitHub (recorded in ~/.snow/skills-registry.json). Skills placed manually or bundled with the app are rejected with a message; delete their directory instead.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "skillId": {
                            "type": "string",
                            "description": "Skill id as reported by skills-config-list (githubInstalled entries)."
                        },
                        "projectId": {
                            "type": "string",
                            "description": "Optional project id; required when the skill was installed with location 'project'."
                        }
                    },
                    "required": ["skillId"],
                    "additionalProperties": false
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        // All skills-config operations are async by nature (they delegate to
        // SkillsService / skills_installer, which run on the tokio blocking
        // pool). The sync fallback path in builtin.rs is never reached for
        // this server because call_mcp_tool dispatches skills-config-* tools
        // to execute_async before falling back.
        Err(Error::new(
            Status::GenericFailure,
            format!(
                "Tool \"{tool_name}\" of MCP server \"{SERVER_ID}\" must be executed through the async dispatch path (call_mcp_tool)"
            ),
        ))
    }
}

fn optional_string(args: &Value, key: &str) -> napi::Result<Option<String>> {
    Ok(args
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

fn required_string(args: &Value, key: &str) -> napi::Result<String> {
    optional_string(args, key)?
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("{key} is required")))
}

fn required_bool(args: &Value, key: &str) -> napi::Result<bool> {
    args.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("{key} is required")))
}
