# 8-Third-party Configuration Import

Snow App can scan and import configuration from other AI coding tools
(Codex, Claude Code, OpenCode) and install or manage declarative Plugins.
This guide covers the **Settings → Third-party configuration** page
(settings page id: `import-settings`).

The page has two tabs:

| Tab | Description |
| --- | --- |
| Import configuration | Scan and import MCP, Skills, Prompts, Commands, Agents and Plugins from Codex / Claude Code / OpenCode |
| Manage Plugins | Manage imported Plugins (enable / disable / update / uninstall / run) and install Plugins from marketplaces |

## 1. Import Configuration

### 1.1 Supported Sources

Switch the source at the top of the tab (Codex / Claude Code / OpenCode).
Snow App automatically scans the locations below and lists importable candidates:

| Source | Config home | Scanned config files | Importable content |
| --- | --- | --- | --- |
| Codex | `CODEX_HOME` env var or `~/.codex` | Global `config.toml`; project `<project>/.codex/config.toml` | MCP servers, `AGENTS.md` / `AGENTS.override.md`, profile prompts, Skills, Plugins |
| Claude Code | `CLAUDE_CONFIG_DIR` env var or `~/.claude` | `~/.claude.json`, `~/.claude/settings.json`; project `.mcp.json` | MCP servers, `CLAUDE.md`, rules, commands, Skills |
| OpenCode | `OPENCODE_CONFIG_DIR`, `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` (legacy `~/.opencode` also supported) | Global `config.json` / `opencode.json` / `opencode.jsonc`; project `opencode.json` / `opencode.jsonc` / `.opencode/opencode.json` / `.opencode/opencode.jsonc` | MCP (`mcp` field), `instructions`, commands, agents, Skills |

Each source tab shows:

- **Summary cards**: MCP servers (global / project counts), Skills, Prompts, Plugins or project config count;
- **Candidate list**: checkbox list of importable items;
- **Source files**: the scanned config directory and file paths with found/missing state;
- **Warnings**: non-blocking notes found during scanning (e.g. unsupported MCP transports).

### 1.2 Candidate Status

| Status | Meaning |
| --- | --- |
| New | Fresh candidate, ready to import |
| Already effective | Already in effect (e.g. the Skill is inside a path Snow already scans), no import needed |
| Update available | Imported before, but the source content changed |
| Conflict | Multiple sources use the same logical ID with different content; pick only one |
| Unsupported | Cannot be imported (see "Unsupported items" below) |
| Managed | Already managed by Snow with identical content |

### 1.3 Committing an Import

1. Switch to the target source tab;
2. Click **Refresh discovery** to rescan (optional; the page scans on open);
3. Check the candidates to import (Conflict candidates are mutually exclusive — only one can be checked);
4. Click **Import selected (n)** at the bottom.

After committing, a summary shows the counts of imported, unchanged, skipped and
unsupported items.

### 1.4 Import Targets

| Candidate type | Import target |
| --- | --- |
| MCP server | Snow's MCP settings (global / project scope preserved) |
| Skill | Copied to `~/.snow/skills` (global) or `<project>/.snow/skills` (project), managed by Snow |
| Prompt / Command / Agent | System Prompt |
| Plugin | Plugin management (its components are managed by Snow) |

### 1.5 Deduplication and Conflict Rules

- Sources with identical content are merged into one candidate with all sources listed (shared);
- Same logical ID with different content produces a **Conflict**; only one content variant can be selected;
- Before committing, the app rescans; if a candidate changed, refresh first and then commit again.

### 1.6 Unsupported Items

- Claude Code WebSocket (`ws`) and SSE (`sse`) MCP servers;
- Claude Code MCP servers using `headersHelper`;
- Plugin MCP declarations with neither `command` nor `url`.

## 2. Managing Plugins

The **Manage Plugins** tab manages declarative Plugins owned by Snow. Plugins are
declared in `marketplace.json` (or `marketplace.json` under `.agents/plugins/`,
`.claude-plugin/`, `.codex-plugin/`). Snow only reads their declarative components
(MCP, Skill, Prompt, Command, Agent, Hook) and **never runs install scripts**.

### 2.1 Installed Plugins

| Action | Description |
| --- | --- |
| Enable / disable | Toggle the plugin switch; disabled components stop taking effect |
| Update | Re-fetch the latest version when an update is available |
| Uninstall | Remove the plugin and its Snow-managed components |
| Runtime | A plugin may declare a runtime (isolated utility process). Starting it asks for confirmation of requested permissions (Plugin storage, Network, Child process); only run code you trust |

Expanding a plugin shows its component list, source path and runtime information.

### 2.2 Plugin Marketplaces

Click **Add marketplace** to add a marketplace. Supported source formats:

| Source format | Example |
| --- | --- |
| Local path | `./my-marketplace` (must contain `marketplace.json`) |
| GitHub repository | `owner/repo` or `owner/repo@ref` |
| Git URL | `https://github.com/owner/repo.git#ref` |
| HTTPS manifest URL | `https://example.com/marketplace.json` (HTTPS only, must point directly to the manifest) |

After adding a marketplace:

- Marketplace caches live in `~/.snow/plugin-marketplaces`; installed Plugins live in `~/.snow/plugins/marketplaces`;
- Select the marketplace to browse its catalog and click **Install Plugin**;
- Installed Plugins show their toggle here, so you can enable / disable / update directly;
- Removing a marketplace deletes its Snow cache but **keeps installed Plugins**.

> Security note: only install Plugins from sources you trust. Snow does not run
> plugin install scripts, but enabling a plugin runtime executes external code —
> review its permission requests first.

## 3. Managed Resources and Release

Imported MCP servers, Skills and Prompt / Command / Agent items are tracked by
Snow as managed resources (stored under `~/.snow` with source paths and content
hashes). When source content changes, the candidate shows **Update available**;
re-import to sync.

When deleting a managed resource:

- **Skill**: only directories inside `~/.snow/skills` or project `.snow/skills` can be deleted (protects original sources);
- **MCP**: the entry is removed from Snow's MCP settings;
- **Prompt / Command / Agent**: the entry is removed from the System Prompt.

## 4. FAQ

| Symptom | Cause & fix |
| --- | --- |
| Source shows "Source not found" | The tool is not installed or never used; install/use it once, then refresh |
| Candidate stays "Unsupported" | Check the warning details (e.g. MCP uses ws / sse transport) |
| "Import discovery changed" on commit | The candidate changed after scanning; click Refresh discovery, then commit |
| Duplicates from multiple tools | Identical content is merged into one candidate; multiple tools are only listed as sources |
| Marketplace add fails | Use a local path, `owner/repo`, a Git URL, or a direct HTTPS `marketplace.json` link |

## 5. Reference

- MCP configuration: [1-configure-mcp](1-configure-mcp.md)
- Installing and managing Skills: [2-install-and-manage-skills](2-install-and-manage-skills.md)
- System prompt (`system-prompt.json`): see [3-config-file-field-reference](../3-reference/3-config-file-field-reference.md)
