# 10-Using Chat & AI Assistant

The core of Snow App is conversational collaboration with AI: besides plain
text replies, the AI can read/write files, run commands, search the web,
browse pages, and generate images — every step is shown live in the
conversation. This guide covers the UI layout, conversation workflow, and
common interactions.

## 1. UI Layout

```
┌──────────────┬──────────────────────────────┬──────────────┐
│   Sidebar    │         Main Area            │  Right Panel  │
│ ・Projects    │ ・AI chat (conversation)     │ ・File viewer │
│ ・Sessions    │ ・Terminal / SSH / Git /      │ ・MD preview  │
│ ・Memos       │   Browser / Codebase         │ ・Diff preview│
│ ・Scheduled   │ ・Scheduled tasks /          │ ・Git panel   │
│   tasks       │   Image library             │              │
│ ・Settings    │ ・Input box (/ @ images)     │              │
└──────────────┴──────────────────────────────┴──────────────┘
```

| Area | Contents |
| --- | --- |
| Sidebar | Workspace directories (local & SSH), session list, memos, scheduled tasks, settings |
| Main area | Current view: AI chat, terminal, Git, browser, codebase, image library, etc. |
| Right panel | File viewer (Markdown render preview, images, Office docs), diff preview, Git panel — multi-tab |
| Top bar | View switching, API profile switching (`Alt+P`, macOS `Ctrl+P`), settings |

## 2. Starting a Conversation

1. Select or create a **session** in the sidebar (conversations are organized
   per project/directory);
2. Type in the input box and press Enter (or click send);
3. The AI replies **streaming**; when it needs tools, it calls them
   automatically and shows each call as a card.

**First example**: send

```text
Look at the current project, find all Python files, and summarize each file's purpose
```

The AI will call `grep-search` for `*.py`, `filesystem-read` to read files,
`codelens-file_outline` to analyze structure, then answer — each step appears
as a card in the conversation (see "Tool Call Visualization" below).

> **Switching models/profiles**: use the top bar or the input-area controls;
> system prompts and thinking strength are also adjustable nearby. See
> [3-configure-api-keys](3-configure-api-keys.md).

### 2.1 Managing Sessions

Every session in the sidebar list exposes an action menu via the **"⋯"
button** (shown on hover at the end of the row) or by **right-clicking the
session row**:

| Action | Description |
| --- | --- |
| Pin / Unpin | Pin the session to the "Pinned" group at the top of the list |
| Rename | Change the display name; you can also **double-click the title** to edit inline |
| Icon | Set an Emoji icon for the session |
| Export | Export as Markdown / HTML / JSON / CSV |
| Multi-select | Enter multi-select mode to batch-select sessions |
| Delete | Delete the session (requires confirmation) |

> **Right-click menu**: right-clicking a session row opens the exact same
> menu as the "⋯" button at the **cursor position**. Right-click is not
> intercepted while renaming or in multi-select mode, so the system menu
> (e.g. copy/paste in the input) is preserved.

## 3. Input Box Features

### 3.1 Slash Commands (`/`)

Type `/` to open the command panel:

| Command | Purpose |
| --- | --- |
| `/new` (new chat) | Clear the current session and start fresh |
| `/compact` | Compress context and generate a handoff summary (see below) |
| `/file-changes` | Open the file-changes panel: files changed by the AI + diffs |
| `/mcp` | Open the MCP server management panel |
| `/role` | Pick a role/system prompt (requires a selected project) |
| `/sensitive-commands` | Configure project-scoped sensitive commands (requires a project) |
| `/skills` | View and enable skills (requires a selected project) |
| `/codebase` | Open the codebase index panel (requires a selected project) |

> Some commands are disabled while the AI is running.

### 3.2 File Mentions & Images (`@`)

- Type `@` to open the **file mention** panel: search and pick a workspace
  file; the AI reads it automatically;
- **Path navigation**: the panel lets you **browse into folders** like a file
  manager —
  - Click a folder entry (or select it and press `→` / `Enter`) to enter it;
    the `@` query in the input updates to `relative/path/` automatically;
  - A **breadcrumb bar** at the top shows the workspace name and each path
    segment — click any segment to jump back;
  - Press `←` to go up one level;
  - You can also type a path directly: `src/` lists the contents of `src`,
    while `src/renderer/App` filters file names inside `renderer`;
  - To reference a whole folder (let the AI read the entire directory), check
    it (`Space`) and press `Enter` to insert in batch, or drag the folder
    entry into the input.
- **Images** can be **pasted** (`Ctrl+V`) or **dragged in from the file
  manager** (single or multiple at once): thumbnails appear as chips in the
  input box (hover to preview, click to zoom); the AI understands them with a
  vision model, and they can also be used for **image-to-image editing** (see
  [9-image-generation](9-image-generation.md)). When the main model does not
  support vision, images are first textified by a separate vision model and
  each one gets a `[Reference image #N ...]` block (just a relative path under
  the upload/ directory) — the AI reads the **original image** by reference
  for image-to-image, so it is never downgraded to text-to-image.

### 3.3 Other

| Feature | Notes |
| --- | --- |
| Manual model pick | Temporarily override the model for this message |
| Thinking strength | Adjust reasoning effort (e.g. `minimal`/`high`); thinking blocks are expandable |
| Multi-line input | `Shift+Enter` for a newline, `Enter` to send |
| Auto-saved drafts | Draft text (including image chips) is **saved per conversation**: switching chats, starting a new chat, or waiting for history to load never loses it — it is restored automatically when you come back, and cleared after a successful send |

## 4. AI Replies & Message Actions

Each AI reply has actions in its top-right corner:

| Action | Notes |
| --- | --- |
| Copy | Copy the reply |
| Copy as Markdown | Copy the Markdown source |
| Copy as plain text | Copy without formatting |
| View raw Markdown | Toggle between rendered view and source |
| Rollback | Rewind the session to before this message (see below) |
| Stop | Interrupt generation while streaming ("Stopping...") |

Markdown rendering supports: headings, tables (wide tables scroll
horizontally), code blocks (language label + copy button), KaTeX math
(`$...$` / `$$...$$`), Mermaid diagrams (code/diagram toggle, save as image),
task lists, blockquotes, and more.

## 5. Tool Call Visualization

When the AI calls tools, cards appear in the conversation:

| Tool family | Shown content |
| --- | --- |
| `bash-terminal-execute` | Command, colored stdout/stderr streams, interactive input |
| `terminal-*` | Persistent terminal session view (live output, can be operated in sync) |
| `filesystem-*` | Read contents/image previews, edit diff summaries (open full diff in the right panel) |
| `grep-search` / `websearch-*` | Query and matched results |
| `browser-*` | Opened page, screenshots, console/network info |
| `todo-todo-manage` | Task list changes (expandable) |
| `imagegen-generate` | Generated images (with streaming preview) |
| `sub-agents-activate` | Sub-agent run details (prompt, steps, result) |
| `codelens-*` / `codebase-search` | Diagnostics, semantic search results |

> After file changes, use `/file-changes` to review which files were modified
> and their diffs; click a file to open the full diff preview in the right
> panel.

## 6. Rollback

If the AI's file changes are unsatisfactory, roll the session back to a
point before a message:

1. Click **Rollback** on the target AI message;
2. A confirmation dialog lists the changes involved (added/modified/deleted
   files);
3. Choose the scope:
   - **Rollback conversation only**: delete messages after that point;
   - **Rollback conversation and files**: also restore files from the
     checkpoint snapshot, and remove the corresponding TODO items.

> Rollback relies on message-level checkpoints; preview the diff first via
> "View changes" when in doubt.

## 7. Context Compaction

Long conversations consume a lot of context. Click **Compact** (or `/compact`):

1. The AI summarizes the conversation into a **handoff document** (summary);
2. The conversation is replaced by the summary + subsequent messages, greatly
   reducing context usage;
3. The summary can be expanded/collapsed.

> Compaction is irreversible — check the summary before continuing. Hooks can
> run custom logic before compaction via `beforeCompress` (see
> [5-configure-hooks-and-subagents](5-configure-hooks-and-subagents.md)).

## 8. Scheduled Tasks

The **Scheduled Tasks** entry in the sidebar (or the AI tool
`app-control-createScheduledTask`) creates automation: at the scheduled time,
the preset prompt is sent to the AI.

| Setting | Notes |
| --- | --- |
| Name / Prompt | Task description and what the AI should do |
| Type | Once (at a start time) or recurring |
| Recurring mode | Fixed interval (minutes/hours) or daily at a fixed time |
| Actions | Run now, pause/resume, delete, clear all |

> Tasks only run **while the app is running** and are cleared on exit.

## 9. Memos

The **Memos** entry in the sidebar stores quick notes (create/edit/delete);
the AI can also create memos for you via `app-control-createMemo`.

## 10. Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| The AI has no tools | Check the API profile/model config; some tools are exposed on demand (e.g. image generation, see [9-image-generation](9-image-generation.md)) |
| Output interrupted | A stopped generation will not resume; re-send or use rollback |
| Images not understood | Make sure the active profile has a vision model configured (see [3-configure-api-keys](3-configure-api-keys.md)) |
| Tables/formulas look wrong | Wide tables scroll horizontally; formulas need `$...$` syntax |
| TODO items missing | Rollback also deletes matching TODO items (shown in the confirmation) |

## 11. References

- All built-in tools: [3-reference/2-builtin-tools-reference](../3-reference/2-builtin-tools-reference.md)
- Model configuration: [3-configure-api-keys](3-configure-api-keys.md)
- Automation & sub-agents: [5-configure-hooks-and-subagents](5-configure-hooks-and-subagents.md)
