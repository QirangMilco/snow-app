# 2-builtin-tools-reference

Snow App ships with a set of built-in MCP tools that let the AI agent perform file operations, terminal commands, web search, browser automation, and more. This article lists all built-in servers and tools.

## 1. Tool Naming Convention

Built-in tool full names follow the pattern `{server-id}-{tool-name}`, e.g. `filesystem-read`. Some server IDs contain `-` (e.g. `user-interaction`); when resolving the tool name, the built-in server list is used for **longest-prefix matching** to disambiguate.

## 2. Server Overview

Listed in registration order:

| Server ID | Description |
| --- | --- |
| `filesystem` | Local file read/write (read / replace_edit / create) |
| `bash` | Terminal command execution |
| `todo` | Session task list management |
| `grep` | File content search (ripgrep) |
| `websearch` | Web search and page fetching |
| `browser` | Built-in browser automation (embedded Electron browser) |
| `user-interaction` | Ask the user questions (blocking interaction) |
| `sub-agents` | Activate sub-agents to run tasks independently |
| `codebase` | Codebase semantic search (embedding index) |
| `codelens` | Code diagnostics and symbol location |
| `app-control` | App control (memos / modes / settings pages / scheduled tasks / projects) |
| `config` | Read/write global config files (settings/snowcfg/proxy/app) |
| `skills` | Skill loading and execution |
| `skills-config` | Skill management (list / toggle / GitHub install & uninstall) |

## 3. Tool Details

### filesystem

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `filesystem-read` | Read file content (supports text, images, Office documents) | `filePath`, `startLine`, `endLine` |
| `filesystem-replace_edit` | Fuzzy search-and-replace editing | `filePath`, `searchContent`, `replaceContent`, `occurrence` |
| `filesystem-create` | Create a new file (auto-creates parent directories) | `filePath`, `content`, `overwrite` |

### bash

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `bash-terminal-execute` | Execute terminal commands (build, test, package management, etc.) | `command`, `description`, `workingDirectory`, `timeout` |

### todo

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `todo-todo-manage` | Session task list management (CRUD) | `action`, `content`, `sessionId`, `status`, `todoId`, `parentId` |

### grep

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `grep-search` | Search file contents with ripgrep | `pattern`, `path`, `fileGlob`, `caseSensitive`, `isRegex`, `maxResults` |

### websearch

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `websearch-websearch-search` | Web search, returns a list of results | `query`, `maxResults` |
| `websearch-websearch-fetch` | Fetch and read the full content of a web page or an image | `url`, `maxLength`, `isUserProvided`, `userQuery` |

### browser

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `browser-create` | Create an embedded browser instance | `url` |
| `browser-navigate` | Navigate to the specified URL | `url`, `timeoutMs`, `instanceId` |
| `browser-click` | Click page elements with real mouse events | `selector`, `text`, `exact`, `instanceId` |
| `browser-screenshot` | Capture the page as PNG | `fullPage`, `instanceId` |
| `browser-devtools` | Inspect page metadata and console information | `action`, `instanceId` |
| `browser-close` | Close a browser tab | `instanceId` |
| `browser-focus` | Switch to the specified tab | `instanceId` |
| `browser-list` | List all open tabs | — |

### user-interaction

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `user-interaction-askUserQuestion` | Ask the user a question (blocking interaction; must be called alone) | `question`, `options` |

### sub-agents

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `sub-agents-activate` | Activate a sub-agent to run a task independently | `agentId`, `prompt` |

### codebase

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `codebase-search` | Codebase semantic search (embedding index based) | `pattern`, `path`, `fileGlob`, `maxResults` |

### codelens

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `codelens-diagnose` | Run code diagnostics, returns syntax/semantic errors | `filePath` |
| `codelens-find_definition` | Find a symbol's definition location | `filePath`, `line`, `column` |
| `codelens-find_references` | Find a symbol's reference locations | `filePath`, `line`, `column` |
| `codelens-file_outline` | Get a file's symbol outline | `filePath` |

### app-control

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `app-control-createMemo` | Create a memo (note) | `content` |
| `app-control-setMode` | Enable/disable Plan Mode or Goal Mode | `mode`, `enabled` |
| `app-control-openSettings` | Open the specified settings page | `page` |
| `app-control-createScheduledTask` | Create a scheduled task | `name`, `prompt`, `schedule` |
| `app-control-createProject` | Create a project (workspace directory) | `name`, `parentPath` |
| `app-control-requestApproval` | Request user approval of the plan summary (only exposed in Plan Mode) | `planSummary` |

### config

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `config-list` | List manageable scopes (settings/snowcfg/proxy/app) and their keys; pass `scope` to inspect a single scope with current values (sensitive keys masked) | `scope` |
| `config-get` | Read a key's value; sensitive keys (`apiKey`, `visionApiKey`) are always masked | `scope`, `key` |
| `config-set` | Write a key (whitelist + type check + auto backup + atomic write); `settings.mcpServers` auto-syncs to the app database and takes effect immediately | `scope`, `key`, `value` |
| `config-delete` | Delete a key | `scope`, `key` |

Supported scopes:

| Scope | File | Main keys |
| --- | --- | --- |
| `settings` | `~/.snow/settings.json` | `mcpServers`, `codebase`, `sensitiveCommands`, `yoloMode`, `planMode`, ... |
| `snowcfg` | `~/.snow/config.json` (`snowcfg` object) | `baseUrl`, `apiKey` (sensitive), `advancedModel`, `maxTokens`, ... |
| `proxy` | `~/.snow/proxy-config.json` | `enabled`, `host`, `port`, `searchEngine`, `browserPath`, `browserDebugPort` |
| `app` | `~/.snow/active-profile.json` | `activeProfile` |

### skills

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `skills-skill-execute` | Load and execute the specified skill | `skill` |

### skills-config

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `skills-config-list` | List available skills and GitHub-installed records. Without `projectId`: global view where `enabled` is the SKILL.md frontmatter `enable` field. With `projectId`: project-scoped view (four-directory merge, `enabled` = project DB override taking precedence over frontmatter, plus `defaultEnabled` = frontmatter value) | `projectId` |
| `skills-config-setEnabled` | Toggle a skill. Without `projectId`: rewrites the `enable` field in the SKILL.md frontmatter (same file write as the UI toggle). With `projectId`: writes a project-scope DB override (takes effect immediately and wins over frontmatter) | `projectId`, `skillId`, `enabled` |
| `skills-config-installGithub` | Install skill(s) from a GitHub repository (`url` accepts full URLs and `owner/repo` shorthand, optional `@branch` and `:sub/dir`; `location` is `global`/`project`, project installs need `projectId`); metadata is recorded in `~/.snow/skills-registry.json` | `url`, `location`, `projectId` |
| `skills-config-uninstall` | Uninstall a GitHub-installed skill (registry-only; manually placed or app-bundled skills must be removed by deleting their directory) | `skillId`, `projectId` |

> Note: the frontmatter field that controls the toggle is `enable` (not `enabled`).

## 4. Special Notes

**Valid values for the `page` parameter of `app-control-openSettings`:**

| page value | Corresponding settings page |
| --- | --- |
| `api-settings` | API Settings |
| `proxy-browser-settings` | Proxy & Browser |
| `codebase-settings` | Codebase Settings |
| `system-prompt-settings` | System Prompts |
| `custom-headers-settings` | Custom Headers |
| `mcp-settings` | MCP Settings |
| `skills-settings` | Skills Settings |
| `sub-agent-settings` | Sub-Agent Settings |
| `sensitive-command-settings` | Sensitive Commands |
| `hooks-settings` | Hooks Settings |
| `theme-settings` | Theme Settings |
| `terminal-settings` | Terminal Settings |
| `keyboard-shortcuts-settings` | Keyboard Shortcuts |
| `privacy-settings` | Privacy Settings |
| `usage-settings` | Usage Settings |
| `system-logs` | System Logs |

**Other notes:**

- `app-control-requestApproval` is only exposed when Plan Mode is enabled;
- `skills-skill-execute` dynamically loads enabled skills from `~/.snow/skills` and the project's `.snow/skills`.

## 5. Difference from External MCP Tools

External MCP server tools are added by the user in **MCP Settings** (see [2-guides/1-configure-mcp](../2-guides/1-configure-mcp.md)); their tool names are prefixed with the server name (e.g. `dbx-search_context`), distinguishing them from built-in tools via prefix matching against the built-in server list.
