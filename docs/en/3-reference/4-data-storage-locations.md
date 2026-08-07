# Data Storage Locations

> This document is based on `native/src/storage/` and `src/main/` sources. It describes every location where Snow App writes data, for backup, migration, and troubleshooting purposes.

## Storage Architecture Overview

Snow App stores data in **3 layers**:

```
┌─────────────────────────────────────────────────────────┐
│ ① Rust native layer (SQLite database + app resources)   │
│    ~/.snowapp/                                           │
├─────────────────────────────────────────────────────────┤
│ ② Electron main-process layer (userData + global conf)  │
│    %APPDATA%/Snow App/          (Windows)               │
│    ~/.snow/                     (global CLI config)      │
├─────────────────────────────────────────────────────────┤
│ ③ Project workspace layer                                │
│    <workspace>/.snow/           (project config & logs) │
└─────────────────────────────────────────────────────────┘
```

---

## ① Rust Native Layer: `~/.snowapp/`

The storage directory is defined in `native/src/storage/paths.rs` as `<home>/.snowapp`, resolved via `dirs_next::home_dir()`. The database uses **SQLite (rusqlite) with WAL mode** (see `database.rs`: `journal_mode=WAL`, `synchronous=NORMAL`, 5s busy timeout).

### 1.1 Main Database: `~/.snowapp/snowapp.db`

All business data (conversations, messages, configs, usage, memos, plugins, etc.) lives in this single SQLite file with 21+ tables:

| Table | Contents |
|-------|----------|
| `system_settings` | Key-value global settings (theme, privacy, shortcuts, plan/goal/yolo modes, request-logging switch, image generation config `imagegen_settings`, ...) |
| `api_configs` | API key & model profiles |
| `system_prompts` | System prompt templates |
| `custom_header_schemes` | Custom request-header schemes |
| `workspace_directories` | Workspace directory list (incl. built-in default) |
| `mcp_server_configs` | Global MCP server configs |
| `import_resources` / `import_resource_sources` | Third-party config import resources & sources |
| `plugins` / `plugin_marketplaces` / `plugin_components` | Plugin, marketplace & component registry |
| `sub_agent_configs` | Sub-agent configs |
| `sensitive_command_configs` | Sensitive command rules |
| `chat_conversations` | Conversation list (incl. API profile, mode flags) |
| `sub_agent_sessions` | Sub-agent sessions |
| `chat_messages` | Chat messages (inline images referenced as `@@image:...@@`) |
| `todo_items` | TODO items |
| `usage_records` | Usage stats (token consumption, ...) |
| `app_logs` | App logs (shown in the Settings "System Logs" page) |
| `memos` | Memos |
| `image_library` | Image library index (relative path, file name, source & created-at; image files default to `~/.snowapp/image/`, customizable via `image_library_dir`) |
| `codebase_embed_sessions` | Codebase embedding session state |
| `codebase_embeddings_*` | Per-project vector index (dynamically created per project) |

> The database is initialized exactly once per process (`storage/mod.rs::ensure_database_file` with `DATABASE_PATH_CACHE`): create dir → create schema → seed defaults. Schema migrations run in pre/post phases, see `migrations.rs`.

### 1.2 App Resource Directories

| Path | Contents |
|------|----------|
| `~/.snowapp/checkpoints/` | Conversation file-change checkpoints (`checkpoint.rs`; snapshots user files, excludes `.snow`/`.snowapp`) |
| `~/.snowapp/backgrounds/` | User-selected theme background images (copied then referenced) |
| `~/.snowapp/stream-cursors/` | Custom streaming-cursor SVGs |
| `~/.snowapp/upload/<YYYY-MM-DD>/` | Inline chat images (base64 persisted as `<hash>.<ext>`; messages store relative paths `upload/<date>/<file>`, see `api/conversation/images.rs`) |
| `~/.snowapp/image/` | Default image-library root (AI-generated/imported images land here, `services/image_library.rs`; a custom save dir can be set in Settings) |
| `~/.snowapp/workspace/` | Built-in default workspace (`source=builtin`, used when no directories are added) |

---

## ② Electron Main-Process Layer

### 2.1 userData: `%APPDATA%/Snow App/` (Windows) / `~/Library/Application Support/Snow App/` (macOS)

The app name is set to `Snow App` in `bootstrap.ts` (appId `com.snow.app`).

| Path | Contents |
|------|----------|
| `<userData>/window-state.json` | Window position/size/maximized state (`app/windowState.ts`) |
| `<userData>/plugins/` | Per-plugin isolated storage (`pluginRuntimeManager.ts`; exposed via `SNOW_PLUGIN_STORAGE_PATH`) |
| `<userData>/ssh-credentials` | SSH credentials (`ssh/sshCredentials.ts`) |
| `<userData>/updates/` | App update download cache (`updater/macUpdater.ts`) |

### 2.2 Global Config: `~/.snow/`

Shared global directory with the Snow CLI (`SNOW_CLI_CONFIG_DIR` in `snowCli/paths.ts`).

| Path | Contents |
|------|----------|
| `~/.snow/settings.json` | Global settings (MCP, proxy, ...; overridden by project-level file) |
| `~/.snow/config.json` | AI config (`snowcfg` object: baseUrl, apiKey, models, maxTokens, chatThinking, ...) |
| `~/.snow/proxy-config.json` | Proxy & network settings (enabled, host/port, searchEngine, browserPath, browserDebugPort) |
| `~/.snow/active-profile.json` | Active API profile (activeProfile) |
| `~/.snow/custom-headers.json` | Custom request-header schemes (active, schemes; may contain sensitive headers) |
| `~/.snow/system-prompt.json` | System prompt templates (active, prompts) |
| `~/.snow/theme.json` | Theme settings (theme, simpleMode, diffOpacity, toolIcons, customColors, ...) |
| `~/.snow/language.json` | UI language (language) |
| `~/.snow/permissions.json` | Always-approved tool allowlist (alwaysApprovedTools) |
| `~/.snow/lsp-config.json` | LSP code-diagnostics config (schemaVersion, servers) |
| `~/.snow/buddy.json` | Buddy companion config (version, companion, muted) |
| `~/.snow/ROLE.md` | Global role definition (`personalizationHandlers.ts`; read/written by the config tool's `personalization` scope) |
| `~/.snow/skills/` | Global skills (built-in skills are synced here, `ensureBuiltinSkills.ts`) |
| `~/.snow/skills-registry.json` | Skills registry (installation sources/locations) |
| `~/.snow/docs/` | Synced copy of built-in docs (fully re-synced on version change) |
| `~/.snow/plugin-marketplaces/` | Plugin marketplace cache |
| `~/.snow/plugins/marketplaces/` | Plugin bodies installed from marketplaces |
| `~/.snow/codex-plugins.json` | Codex-compatible plugin manifest |
| `~/.snow/log/` | App file logs (read by the config tool's `logs` scope by date, e.g. `2026-08-03-error.log`) |
| `~/.snow/.config-backups/` | Pre-write auto backups from the config tool (temporary safety net, removed after a successful write, max 10 per file) |

### 2.3 Others

- `app.getPath("logs")/updater.log` — updater log (macOS update flow)
- Settings "System Logs" page — reads the `app_logs` table (`logs:list` / `logs:clear` IPC)
- The AI `config` tool's `logs` scope — reads file logs under `~/.snow/log/` (two log sources coexist with the database `app_logs` table)

---

## ③ Project Workspace Layer: `<workspace>/.snow/`

| Path | Contents |
|------|----------|
| `<workspace>/.snow/settings.json` | Project-level settings (override global, `mcpSettings.ts` / `remoteWorkspaceCommand.ts`) |
| `<workspace>/.snow/skills/` | Project-level skills |
| `<workspace>/.snow/logs/` | Bash tool `detach:true` background logs: `<name>-<timestamp>.log` (`mcp/servers/bash.rs`; `.snow` is gitignored) |

> `.snow` directories are uniformly excluded by .gitignore, checkpoint scanning, and SSH file traversal.

---

## Quick Path Reference per Platform

| Data | Windows | macOS | Linux |
|------|---------|-------|-------|
| Main database | `%USERPROFILE%\.snowapp\snowapp.db` | `~/.snowapp/snowapp.db` | `~/.snowapp/snowapp.db` |
| App resources | `%USERPROFILE%\.snowapp\` | `~/.snowapp/` | `~/.snowapp/` |
| userData | `%APPDATA%\Snow App\` | `~/Library/Application Support/Snow App/` | `~/.config/Snow App/` |
| Global config | `%USERPROFILE%\.snow\` | `~/.snow/` | `~/.snow/` |
| Project config | `<workspace>\.snow\` | `<workspace>/.snow/` | `<workspace>/.snow/` |

---

## Backup & Migration Tips

- **Full backup**: copy `~/.snowapp/` (incl. `snowapp.db`, `upload/`, `image/`, `backgrounds/`, `checkpoints/`) plus `~/.snow/` to cover most data.
- **Chat images**: backing up only the database loses inline images — include `~/.snowapp/upload/`.
- **Image library**: AI-generated images live in `~/.snowapp/image/` (or a custom dir); deleting a conversation with "don't keep images" cascades their deletion, so back up first.
- **Plugin data**: plugin-owned data lives in `<userData>/plugins/`; include it too.
- **Cross-platform**: paths are hardcoded relative to the home directory; simply copy the three directories. Note that Windows backslashes in inline-image references are normalized to forward slashes.
