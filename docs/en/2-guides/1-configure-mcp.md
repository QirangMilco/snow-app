# 1-configure-mcp

MCP (Model Context Protocol) servers provide external tools to the AI, such as database queries, browser automation, and document retrieval. This article explains how to configure **global MCP servers** (shared by all projects) in Snow App.

## 1. Configuration Entries

| Entry | Description |
| --- | --- |
| Settings → MCP Settings | GUI: add / edit / delete / enable / fetch tools |
| `config` built-in tool | The AI agent reads/writes config files; writing `mcpServers` auto-syncs to the app database and takes effect immediately |
| `mcpServers` field in `~/.snow/settings.json` | Configuration file shared with Snow CLI; requires manual sync |

## 2. Method 1: GUI (recommended for beginners)

1. Open **Settings → MCP Settings**;
2. Click **Add Service** and fill in:
   - **Name**: e.g. `dbx`
   - **Transport**: `stdio` (local command) or `http` (remote service)
   - **Command** (stdio): the executable path, e.g. `npx` or a full path
   - **Arguments** (stdio): arguments passed to the command, added one by one
   - **URL** (http): the service endpoint URL
   - **Environment variables / Headers**: add key-value pairs as needed
   - **Enable service**: enabled by default after saving
3. Click **Save Service**;
4. Click the tools icon in the list and **Fetch Tools** to verify connectivity.

### JSON Editing and Bulk Import

- The editor has a **Form / JSON** toggle, so you can paste JSON directly to edit a single server;
- The global page has an **Import JSON** button, supporting bulk import in three formats:

```json
{
  "mcpServers": {
    "example": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "env": {},
      "enabled": true
    }
  }
}
```

Claude-style `{ "servers": {...} }` and plain server mapping formats are also supported.

## 3. Method 2: Let the AI Agent Configure (recommended)

Snow App ships with a generic configuration service `config`, so the agent can read and write config files under `~/.snow/` (settings.json / config.json / proxy-config.json / active-profile.json):

| Tool | Purpose |
| --- | --- |
| `config-list` | List manageable scopes (settings/snowcfg/proxy/app) and their keys |
| `config-get` | Read a key's value (sensitive keys like `apiKey` are masked) |
| `config-set` | Write a key (whitelist + type check + auto backup + atomic write) |
| `config-delete` | Delete a key |

Configuring an MCP server = writing the `mcpServers` key of the `settings` scope:

```json
{
  "scope": "settings",
  "key": "mcpServers",
  "value": {
    "dbx": {
      "type": "stdio",
      "command": "D:\\fnm\\node-versions\\v24.15.0\\installation\\node.exe",
      "args": [
        "D:\\fnm\\node-versions\\v24.15.0\\installation\\node_modules\\@dbx-app\\mcp-server\\bin\\dbx-mcp-server.js"
      ],
      "env": {},
      "enabled": true
    }
  }
}
```

HTTP server example (server object inside `value`):

```json
{
  "scope": "settings",
  "key": "mcpServers",
  "value": {
    "my-http-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}
```

> **Effect**: writing `settings.mcpServers` automatically syncs the servers into the app database with the same diff semantics as the UI "Sync Snow CLI MCP settings" action (upsert servers in the file, delete ones that no longer exist), so **MCP changes take effect immediately without manual sync**. The other scopes (snowcfg/proxy/app) are plain file writes and may require an app restart or a UI re-save.
>
> **Safety**:
> - Only whitelisted scopes/keys are reachable; arbitrary paths are rejected;
> - `config-get` always masks sensitive keys (`apiKey`, `visionApiKey`), e.g. `sk-****abcd`;
> - Every write is backed up to `~/.snow/.config-backups/` first (latest 10 kept) and the file is replaced atomically.
>
> **Windows paths**: backslashes in JSON must be written as `\\`, otherwise `\f`, `\n`,
> `\v` are treated as escape sequences and the server fails to start.

## 4. Method 3: Edit settings.json (bulk / offline)

Global MCP configuration is also stored in the `mcpServers` field of `~/.snow/settings.json`:

```json
{
  "mcpServers": {
    "dbx": {
      "type": "stdio",
      "command": "D:\\fnm\\node-versions\\v24.15.0\\installation\\node.exe",
      "args": [
        "D:\\fnm\\node-versions\\v24.15.0\\installation\\node_modules\\@dbx-app\\mcp-server\\bin\\dbx-mcp-server.js"
      ],
      "env": {},
      "enabled": true
    }
  }
}
```

After modifying, import it manually via **Settings → MCP Settings → Sync Snow CLI MCP Settings**.

## 5. FAQ

| Symptom | Cause & fix |
| --- | --- |
| Fetching tools reports `connection closed: discover response` | The server is based on an old SDK; the client automatically falls back to the legacy handshake. If it still fails, update the server version |
| Server fails to start | Check the command path; Windows backslashes need `\\` escaping; prefix npx commands with `cmd /c` |
| Changes not applied after saving | Make sure `enabled: true`; settings.json requires manual sync |
| Tool list is empty | The server returned no tools, or `enabled` is false |

## 6. Reference

- Full field documentation: [3-reference/1-settings-json-reference](../3-reference/1-settings-json-reference.md)
