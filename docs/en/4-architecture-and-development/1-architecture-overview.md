# Architecture Overview

> For developers: Snow App's overall architecture, layer responsibilities, communication chains, and key mechanisms.
> See also: [Data Storage Locations](../3-reference/4-data-storage-locations.md), [Developer Guide](2-developer-guide.md).

## 1. Tech Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| Renderer | React 19 + TypeScript + Vite | UI, state (React Hooks), i18n (zh-CN/en/zh-TW) |
| Main | Electron 37 + TypeScript | Windows/lifecycle, IPC, system integration (PTY/SSH/updater/tray) |
| Native | Rust + napi-rs | AI engine, MCP tools, SQLite storage, codebase indexing |
| Database | SQLite (rusqlite, WAL) | Single file `~/.snowapp/snowapp.db` |
| Build | electron-vite + cargo + electron-builder | Three-entry bundling + per-platform native `.node` |

## 2. Layered Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ ① Renderer (React)                                           │
│    src/renderer/  components / hooks / i18n / utils           │
│    All capabilities via window.snow.* (exposed by contextBridge)│
└───────────────┬──────────────────────────────────────────────┘
                │ window.snow.* (IPC only, no Node access)
┌───────────────▼──────────────────────────────────────────────┐
│ ② Main (Electron main process)                               │
│    src/main/                                                  │
│    ├── ipc/handlers/     IPC handlers (business orchestration)│
│    ├── native/           Rust bridge (Proxy + storageReady gate)│
│    ├── app/              bootstrap / window / sessionProxy / tray │
│    ├── pty/  ssh/  updater/  plugins/  snowCli/  settings/    │
└───────────────┬──────────────────────────────────────────────┘
                │ napi-rs calls (sync/async bindings)
┌───────────────▼──────────────────────────────────────────────┐
│ ③ Native (Rust)                                               │
│    native/src/                                                │
│    ├── exports/   napi export entries (storage/api/codebase/…) │
│    ├── api/       AI provider adapters (anthropic/gemini/responses)│
│    ├── mcp/       Built-in MCP servers + external MCP client  │
│    ├── storage/   SQLite storage layer (21+ tables)           │
│    ├── prompt/    System prompts                              │
│    └── hooks/     Lifecycle hooks                             │
└──────────────────────────────────────────────────────────────┘
```

### Layering Principles

- **Renderer has no Node access**: every system capability (files, processes, database, network) must go through the `window.snow.*` API exposed by preload. Renderer code must never require Node modules directly.
- **Main process is the orchestration layer**: IPC handlers validate parameters, compose native calls, and serialize results. They never hold the database.
- **Rust is the capability layer**: database access, AI requests, MCP tool execution, and codebase indexing all live on the native side; TypeScript only forwards.

## 3. Communication Chains

### 3.1 Call chain (Renderer → Rust)

```
React component
  → window.snow.listChatConversations(dirId)
    → src/preload/modules/conversationApi.ts  (ipcRenderer.invoke)
      → src/main/ipc/handlers/conversationHandlers.ts  (ipcMain.handle)
        → native.conversations.listChatConversations(dirId)   ← nativeBridge Proxy
          → native/src/exports/storage.rs  (napi export)
            → native/src/storage/services/chat_conversations.rs  (rusqlite)
              → ~/.snowapp/snowapp.db
```

### 3.2 Preload bridge (contextBridge)

`src/preload/index.ts` spreads the methods from the `modules/*Api.ts` objects and exposes them
via `contextBridge.exposeInMainWorld("snow", api)`. Type definitions live in
`src/preload/types/`; the renderer imports types from `@preload`.

The flat `window.snow` API is currently composed from 15 API objects:
`apiConfigApi`, `codexApi`, `configApi`, `conversationApi`, `gitApi`,
`imageLibraryApi`, `importConfigApi`, `memoApi`, `personalizationApi`,
`pluginsApi`, `ptyApi`, `sshApi`, `systemApi`, `windowApi`, and `workspaceApi`.
Methods live directly under `window.snow`; they are not nested under those
API object names.

### 3.3 Main → Rust gate (key mechanism)

`src/main/native/nativeBridge.ts` wraps the native binding in a **Proxy**:
every native method call first `await storageReady` (a Promise that resolves
when the SQLite database has finished initializing). This lets the **window
show instantly** while the database initializes in the background — IPC
handlers need no per-call guards:

```ts
const wrapWithStorageGate = (binding) => new Proxy(binding, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return (...args) => storageReady.then(() => value.apply(target, args));
  },
});
```

### 3.4 Event flow (Native → Renderer)

AI streaming output goes through the session proxy in
`src/main/app/sessionProxy.ts`: native pushes tokens, tool calls, and metric
events via napi callbacks/emitters; the main process forwards them to the
matching WebContents; renderer hooks like `useAgentLoop` consume them.

## 4. Rust Native Layer

### 4.1 napi export entries (native/src/exports/)

| Module | Responsibility |
|--------|----------------|
| `storage.rs` | Storage services (conversations, configs, memos, plugins, import resources, …) |
| `api.rs` | AI API calls (chat / stream / theme palette) |
| `codebase.rs` | Codebase indexing (embedding, chunking, search) |
| `engine.rs` | Conversation engine (agent loop) |
| `git.rs` | Git operations (status/commit/diff for the UI) |
| `terminal.rs` | PTY terminal support |
| `checkpoint.rs` | File-change checkpoints |
| `updater.rs` | App update checks |
| `images.rs` | Image library (list / read data URL / delete with session-reference rewrite / custom save dir) |
| `sphere_layout.rs` | Codebase 3D sphere layout (visualization) |

> `scripts/build-native.cjs` runs cargo build, then copies the artifact to
> `snow_native.<platform>.node` (napi-rs naming convention) per target triple.

### 4.2 MCP layer (native/src/mcp/)

- **servers/** — built-in MCP servers (the AI agent's toolset):
  `filesystem`, `bash` (command execution, supports detach/background), `todo`,
  `grep`, `websearch`, `browser`, `user_interaction` (blocking questions),
  `sub_agents`, `codebase`, `codelens` (code symbol location), `app_control`,
  `config` (config read/write), `terminal` (persistent PTY sessions),
  `imagegen` (image generation), `skills` (dynamically registered),
  `remote_workspace` (SSH); `skills_config` is the internal delegation for the
  `config` server's skills scope (not a standalone registered server). See
  "3-reference/2-builtin-tools-reference" for the full tool list.
- **external/** — external MCP client (connects to user-configured servers).
- **protocol/** — MCP protocol (JSON-RPC) implementation.
- **privacy_mask/** — privacy masking (sensitive info filtering).

### 4.3 AI provider adapters (native/src/api/)

`anthropic/` (Claude), `gemini/` (Gemini), `responses/` (OpenAI Responses
API), `chat/` (OpenAI Chat Completions) — all converge on the normalized
tool-call structure in `api/chat/payload.rs`; conversation-mode fixes and
tool-call normalization happen at this layer.

### 4.4 Storage layer (native/src/storage/)

- `database.rs` — connection management (WAL, busy_timeout, schema creation, migrations)
- `migrations.rs` — pre/post two-phase migrations (snowflake IDs, schema migration)
- `paths.rs` — `~/.snowapp` path resolution
- `services/` — domain-split data access layer (37 modules; see the storage-locations doc)

### 4.5 Prompts & hooks (native/src/prompt/, native/src/hooks/)

- `prompt/` — system prompts: `system_prompt.rs` (base),
  `plan_mode_system_prompt.rs` (Plan Mode), `goal_mode_system_prompt.rs`
  (Goal Mode), `common.rs` (shared fragments).
- `hooks/` — lifecycle hook execution (`execute_hooks`: beforeRequest,
  beforeCompress, etc.; configure via "5-configure-hooks-and-subagents").

## 5. Main Process Modules (src/main/)

| Module | Responsibility |
|--------|----------------|
| `app/bootstrap.ts` | Startup: single-instance lock → init storage → window → app services |
| `app/applicationServices.ts` | Storage init (`native.initializeAppStorage`) |
| `app/sessionProxy.ts` | AI session proxy (streaming event relay) |
| `app/mainWindow.ts` | Main window creation & lifecycle |
| `app/windowState.ts` | Window state persistence (userData/window-state.json) |
| `app/storageReady.ts` | Storage-ready Promise (storageReady gate) |
| `app/tray.ts` | System tray |
| `app/themeBgProtocol.ts` | Custom protocol: background images / stream cursors |
| `app/imageProxyProtocol.ts` | Image proxy protocol |
| `app/ensureBuiltinSkills.ts` | Sync built-in skills/docs to ~/.snow/ |
| `ipc/handlers/` | 19 IPC handler groups (see below) |
| `native/` | Native binding load & storageReady gate (nativeBridge.ts) |
| `notification/` | System notifications (notificationManager.ts) |
| `pty/` | PTY session management (Windows ConPTY / POSIX) |
| `ssh/` | SSH connections, remote workspaces, remote Git |
| `plugins/` | Plugin runtime (isolated worker + permission args) |
| `snowCli/` | CLI config dir (~/.snow) compatibility |
| `settings/` | Settings read/write (API configs, MCP, sensitive commands) |
| `updater/` | App updates (macOS/Windows) |
| `codex/` | Codex compatibility layer (third-party config import) |
| `importConfig/` | Third-party config import (reversible transaction + environment discovery) |
| `types/` · `utils/` | Shared types & utility functions |

### IPC handlers (src/main/ipc/handlers/)

`apiConfigHandlers` · `browserNetworkRecorder` · `browserStorageState` ·
`browserTrace` · `chatHandlers` · `codexHandlers` · `configHandlers` ·
`conversationHandlers` · `gitHandlers` · `imageHandlers` ·
`imageLibraryHandlers` · `importConfigHandlers` · `memoHandlers` ·
`nativeHandlers` · `notificationHandlers` · `personalizationHandlers` ·
`sshHandlers` · `windowHandlers` · `workspaceHandlers`

## 6. Startup Flow

```
Electron starts
  → bootstrap.ts
      1. Single-instance lock (app.requestSingleInstanceLock)
      2. app.name = "Snow App"
      3. Load native binding (loadNativeBridge, raw call to avoid deadlock)
      4. initializeApplicationServices → create ~/.snowapp + snowapp.db
         + migrations + seed defaults → markStorageReady
      5. Apply persisted theme → create main window
      6. Register IPC handlers / protocols / tray
  → Window ready (native calls now safe via the storageReady gate)
```

## 7. Data Flow (one AI conversation)

```
User sends a message
  → renderer: ChatInputView → conversationApi.sendMessage
  → main: chatHandlers → native.api streaming call (anthropic/gemini/...)
  → native: agent loop (model iterations → MCP tool calls: bash/grep/filesystem/...)
  → events pushed: sessionProxy → renderer (consumed by useAgentLoop)
  → persisted: storage::store_chat_exchange → snowapp.db
  → UI: message rendering + run-level stream metrics + file-change tracking
```

## 8. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Database in Rust | Performance (no IPC round-trips), transaction atomicity, in-process path cache |
| storageReady gate | First paint is instant: window doesn't wait for the DB; calls queue automatically |
| Renderer without Node | Security boundary: contextBridge exposes only whitelisted APIs |
| Built-in MCP servers in Rust | Tool execution is close to the system (process/PTY/files), avoids JS relay overhead |
| Single-file SQLite + WAL | Simple backups (copy = backup), concurrent read/write friendly |
| Three-language i18n sync | zh-CN / en / zh-TW files must always be updated together |
| Event-driven streaming | sessionProxy relay keeps multi-window/multi-session isolation |
