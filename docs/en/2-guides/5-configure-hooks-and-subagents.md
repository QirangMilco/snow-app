# 5-Configure Hooks and Sub-agents

Snow App lifecycle hooks (automation) and sub-agents can be configured either
manually in the settings panels or **directly by the AI Agent through the
built-in `config` tool** (same source as the UI — the app SQLite database —
and effective immediately).

## 1. Hooks configuration guide

### 1.1 Concepts

- A **hook** is an automation rule attached to a lifecycle node of the AI
  session: when an event fires, rules execute a command (`command`), inject
  context (`context`) or issue an instruction to the AI (`prompt`).
- **Scope**: `global` (shared by all projects) or `project` (current project
  only). When a project configures the same hook type, **the project-level
  config overrides the global one**.
- Each hook config = one `hookType` + a set of rules (`rules`).

### 1.2 Hook types

| hookType | Fires when | Supported actions |
| --- | --- | --- |
| `onUserMessage` | A new user message is sent, before it reaches the AI | `command`, `context` |
| `beforeToolCall` | Before any tool call (matcher can limit the tools) | `command` |
| `toolConfirmation` | When a tool requires user approval | `command` |
| `afterToolCall` | After a tool call completes | `command` |
| `onSubAgentComplete` | When a sub-agent task finishes | `command`, `prompt` |
| `beforeSubAgentStart` | Before a sub-agent is activated (matcher supported) | `command`, `context` |
| `beforeCompress` | Before context compaction | `command` |
| `onSessionStart` | When an existing conversation is opened (fire-and-forget) | `command`, `context` |
| `onStop` | When a session stops / is cleaned up (fire-and-forget) | `command`, `prompt` |

### 1.3 Rules data structure

```jsonc
[
  {
    "description": "Rule description (required)",
    "matcher": "bash-*",          // optional: glob limiting tool hooks to specific tools
    "hooks": [                     // required: action array
      {
        "type": "command",        // command | prompt | context
        "command": "node guard.js", // for type=command
        "timeout": 5000,          // optional, milliseconds
        "enabled": true           // optional, default true
      }
    ]
  }
]
```

Action types:

| type | Effect | Applicable hooks |
| --- | --- | --- |
| `command` | Runs a shell command; the context JSON is piped via stdin; output is handled per exit code | all |
| `prompt` | An instruction to the AI; result acts as a soft signal | `onSubAgentComplete`, `onStop` |
| `context` | Static context injection | `onSessionStart`, `onUserMessage`, `beforeSubAgentStart` |

### 1.4 Exit code convention (command type)

| Exit code | Meaning |
| --- | --- |
| `0` | Pass; stdout is injected as context (e.g. `[Hook Context]`), invisible in the UI |
| `1` | Soft warning; stdout becomes `[Hook Warning]`; if stdout is JSON of the form `{"decision":{"message":"..."}}`, the decision confirmation UI is triggered |
| `2+` | Blocked; the current flow is interrupted and the error is shown to the user |

### 1.5 How to configure

**Option A: settings panel (manual)**

1. Open **Settings → Hooks settings**;
2. Pick the scope tab (Global / Project; the Project tab requires an active project);
3. Select a hook type → add rules and actions → save.

**Option B: AI Agent via the config tool (automatic)**

```jsonc
// Global hook: block dangerous commands in all bash tool calls
config-set scope=hooks key=beforeToolCall value={
  "rules": [
    {
      "description": "Block rm -rf on the root directory",
      "matcher": "bash-*",
      "hooks": [
        {
          "type": "command",
          "command": "ctx=$(cat); cmd=$(echo \"$ctx\" | jq -r '.args.command // empty'); if echo \"$cmd\" | grep -qE 'rm\\s+-rf\\s+/'; then echo 'Blocked: rm -rf on root is forbidden'; exit 2; fi",
          "timeout": 5000
        }
      ]
    }
  ]
}

// Project-scoped hook (provide projectId): only for one project, overrides the global one
config-set scope=hooks key=onUserMessage projectId=<projectId> value={
  "rules": [
    {
      "description": "Inject tech stack context for this project",
      "hooks": [
        { "type": "context", "content": "This project uses Electron + Rust (napi-rs)." }
      ]
    }
  ]
}

// Query & delete
config-list scope=hooks                    // global hooks
config-list scope=hooks projectId=<projectId>  // project hooks
config-get  scope=hooks key=beforeToolCall
config-delete scope=hooks key=beforeToolCall projectId=<projectId>
```

> `projectId` is the `directoryId` of the project (workspace directory).

## 2. Sub-agents configuration guide

### 2.1 Concepts

- A **sub-agent** is a specialized agent with its own system prompt, tool set
  and API config profile, activated via the `sub-agents-activate` tool.
- **Scope**: global (available in all projects) or project-scoped (available
  in that project only). **On activation the project-scoped sub-agent wins;
  when absent, it falls back to the global one with the same id**.
- The built-in `agent_general` cannot be deleted or modified via config tools.

### 2.2 How to configure

**Option A: settings panel (manual)**

1. Open **Settings → Sub-agent settings**;
2. Pick the scope tab (Global / Project);
3. Add/edit a sub-agent (name, description, system prompt, MCP tools, API
   profile) → save.

**Option B: AI Agent via the config tool (automatic)**

```jsonc
// Create a global sub-agent (key = agentId)
config-set scope=subAgents key=agent_code_reviewer value={
  "name": "Code Reviewer",
  "description": "Reviews code quality and security",
  "systemPrompt": "You are a senior code reviewer focused on bugs, security issues and performance.",
  "toolsJson": ["grep-search", "filesystem-read", "codelens-file_outline"],
  "configProfile": "gpt-4o"
}

// Create a project-scoped sub-agent (provide projectId; same id wins over global)
config-set scope=subAgents key=agent_db_migrator projectId=<projectId> value={
  "name": "DB Migration Assistant",
  "description": "Project-specific: generate and run database migrations",
  "systemPrompt": "You are this project's database migration expert...",
  "toolsJson": ["bash-terminal-execute", "dbx-dbx_execute_query"]
}

// Query & delete
config-list scope=subAgents                        // all (incl. project-scoped)
config-get  scope=subAgents key=agent_code_reviewer
config-delete scope=subAgents key=agent_db_migrator projectId=<projectId>
```

> Note: tool names in `toolsJson` must be full names (`{server_id}-{tool_name}`)
> of built-in or project-enabled MCP tools. `configProfile` must be an existing
> API config profile name; empty means "follow the global active profile".

## 3. AI / CLI Configuration Guide (config tool)

Quick rules for configuring via the built-in `config` tool (mirrors the
`guidance` returned by `config-list`):

### 3.1 Sub-agent rules & common pitfalls

| Rule | Description |
| --- | --- |
| An explicit `toolsJson` tool-name list **requires `projectId`** | A sub-agent with a specific tool list is necessarily **project-scoped**; global agents may only use `"*"` (all tools) or an empty list |
| Tool names must be project-enabled | Every name in `toolsJson` must be a built-in/MCP tool full name enabled for that project, otherwise the write is rejected |
| Empty `configProfile` | Follows the active global config; a profile name pins a specific model config |
| `systemPrompt` must be self-contained | The sub-agent runs standalone with **no conversation history** — mission, principles, tool usage and output format all belong in the prompt |
| Project-scoped wins | At activation, a project-scoped agent takes priority over a same-id global one; falls back to global if not found |
| Built-in protection | `agent_general` cannot be modified or deleted |

**Getting `projectId`**: it is the `directoryId` of the workspace directory —
look it up in `~/.snow/projects/index.json` by the project path (`knownPaths`),
or ask the user to pick the project in **Settings → Sub-agents → Project**.

### 3.2 Hooks quick rules

| Rule | Description |
| --- | --- |
| `hookType` whitelist | `onUserMessage` / `beforeToolCall` / `toolConfirmation` / `afterToolCall` / `onSubAgentComplete` / `beforeSubAgentStart` / `beforeCompress` / `onSessionStart` / `onStop` |
| `matcher` glob | Tool hooks can be limited with a glob (e.g. `bash-*` for bash tools only) |
| `command` exit codes | `0` = pass (stdout injected as `[Hook Context]`); `1` = soft warning (a stdout of `{"decision":{"message":"..."}}` triggers the user decision UI); `2+` = abort |
| Action applicability | `prompt` only for `onSubAgentComplete`/`onStop`; `context` only for `onSessionStart`/`onUserMessage`/`beforeSubAgentStart` |
| Project overrides | A project-scoped hook (with `projectId`) overrides the same-type global hook |

### 3.3 Recommended flow

1. `config-list scope=<scope>` first — inspect the current state and the
   `guidance` in the response;
2. Build the `config-set` request following the examples above;
3. `config-get` afterwards to confirm;
4. Resolve `projectId` first when project-scoped (see 3.1).
