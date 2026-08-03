# Release Notes

## v0.1.15

## New Features

- **User Message Rail**: Added a right-edge hover rail for quick chat navigation. A portaled popover lists user messages with paginated loading and virtualization, scrolling to the corresponding message on click. Visible messages are highlighted in the rail as you scroll, and a custom animation-frame tween replaces native smooth scroll for streaming content.
- **Text Snippet Chip**: Pasted text exceeding 2000 characters is automatically converted into a collapsible chip, preventing performance issues from rendering large text nodes in the contenteditable input. Chips support hover preview, click-to-edit modal, and automatic summary generation.
- **`/changes` Panel**: The file-change stats summary has been moved from the message list into a `/changes` slash-command modal with per-file diff previews. Repeated edits to a file are collapsed into a single latest record, and stats are re-hydrated from persisted history when reopening a conversation. Sub-agent changes are merged into the parent conversation.
- **Non-UTF-8 File Support**: Filesystem read/create/edit now auto-detects encoding (BOM + chardetng), preserving the original encoding and BOM on write-back. CSV files are decoded with the detected encoding.
- **Cancellable Remote SSH Tool Calls**: Per-tool execution cancellation is now supported for SSH-backed tools (bash, grep, filesystem). Rust registers a cancel token and Electron maps `tool_execution` IDs to `AbortControllers` that close the SSH exec channel on stop. All running tool executions are killed on session stop, not just bash.
- **Native Multimodal Tool Images**: Screenshots in tool results are now split from `@@image:@@` tags and emitted as provider-native image content blocks (image_url, input_image, inlineData) across Chat Completions, Responses, Anthropic, and Gemini payloads, instead of leaking base64 into plain text tool fields.
- **Codebase Embedding Error States**: Added error states and a retry flow for codebase embedding failures.
- **Git Graph Commit Tooltip**: Hovering a commit row in the git graph now shows a floating tooltip with full commit info (hash, author, date, refs, parents, message). The tooltip renders in a portal with fixed positioning and flips sides near viewport edges.
- **Sub-Agent Read-Only State**: Once a sub-agent run ends (completed, failed, or cancelled), the conversation becomes read-only — the input box is replaced by a status notice with a shortcut back to the parent conversation. Queued user insertions from the sub-agent are forwarded to the parent's pending queue so they are never lost.

## Improvements

- **Sidebar List Refresh Decoupling**: The sidebar conversation list no longer re-renders on every message version bump. A separate `conversationListVersion` triggers full redraws only after explicit actions (top/delete/rename/truncate), while AI responses use incremental upserts. Unchanged upsert content keeps the original reference to avoid meaningless re-renders.
- **User Message ID Sync**: `store_chat_exchange` now returns the snowflake IDs of persisted user messages, propagated through all API result handlers. The frontend replaces temporary IDs with real database IDs after persistence, keeping in-memory state in sync with the DB.
- **Pending Message Tag Rendering**: Pending queued messages now render file/submit tags and other chips properly. Shortcut key matching has been fixed by merging `mod` and `ctrl` checksums for non-macOS platforms while keeping exact matches on macOS.
- **Chat Input Copy/Cut with Chips**: Copying or cutting a selection from the chat input now serializes chip content via a custom clipboard MIME type (`application/x-snow-chat-chips`), enabling full chip restoration on paste within the app. Plain text and HTML formats are also written for external use.
- **Proxy Sync for Auto-Updater**: Proxy configuration is now synchronized to the electron-updater's partitioned session before update checks and downloads, since the updater uses a separate session that doesn't inherit `defaultSession` proxy settings.
- **Thinking Content Filtering**: Added `extract_chat_content` to strip thinking/reasoning content from Chat Completions responses, including inline `[think]`/`<thinking>` markers, for models that return thinking content even when `reasoning_effort=none` is requested.
- **Sub-Agent Pending Queue Forwarding**: When a sub-agent run ends, its pending user message queue is forwarded to the parent conversation's queue, ensuring messages inserted mid-run are picked up by the parent loop.

## Bug Fixes

- **Mermaid Image Viewer**: Fixed the Mermaid image viewer background in light theme.
- **macOS Tray Activity Icon**: The tray active-status icon previously used a template image that ignored RGB colors, making the green dot invisible. It now pre-renders black/white snowflake lines based on system appearance to simulate template inversion, with the dot uniformly green, and listens for `nativeTheme` changes.
- **Cream Theme Layout Gap**: Removed the app-layout gap in the Cream theme, including padding when the right panel is fullscreen.
- **Search Box Focus Style**: Replaced the separate border color change with a focus ring for the search modal input.
- **Icon Resource Paths**: Updated resource path handling to ensure icons load correctly after packaging.
- **Grep Output Parsing**: Fixed grep output parsing to split on the first `:<digits>:` pair so matched content containing colons is no longer dropped.
- **Tool Parse Error Truncation**: Tool parse errors are now truncated on UTF-8 boundaries to prevent invalid character sequences.
- **CSS Position Anchoring**: Added explicit `position: relative` anchors to `.main-content` and `.chat-content` to prevent child elements from drifting when the theme disables `backdrop-filter`.

## v0.1.14

## New Features

- **App Error Boundary**: Added an application-level error boundary that automatically refreshes and self-heals when dynamic sub-package loading fails. Refresh attempts are limited via `sessionStorage` to prevent infinite refresh loops when build artifacts are missing.
- **Direct Sub-Agent Interaction**: Sub-agent sessions are no longer read-only — they now use the regular `ChatInput` for direct interaction, and the separate monitor UI has been removed. The sub-agent model is fixed to its own `advancedModel` to prevent misleading model memorization by the parent session.
- **Collapsible Projects Section**: The Projects section in the sidebar is now collapsible, with its expand/collapse state persisted to `localStorage`.

## Improvements

- **Sub-Agent Sidebar Refactoring**: The sidebar sub-agent list has been moved to a separate panel with its own surface background to avoid visual conflict with the parent session's selected state. Activating a sub-agent automatically expands its parent session, and deleting a parent session cascades to abort all child agent streams and clears the chat area.
- **Session Compression API Profile**: Compressed sessions now use the session-level `apiProfile` instead of the global active configuration, ensuring consistency with the API configuration actually used in the conversation.
- **Project Rule Editor**: The rule editor now follows the currently active project item, and the project dropdown selector has been removed to keep rule settings in sync with the current context.
- **Localized Time Labels**: Weekday names in chat timestamps are now localized (en, zh-CN, zh-TW) by passing the i18n `t` function to `formatTimeLabel`.
- **TokenUsageRing Placeholder**: Displays a placeholder ring during API configuration loading to avoid false alarms about token capacity being full.
- **MCP & Skill Settings**: Removed the MCP JSON batch import feature; JSON editor errors now use `AutoDismissNotice`. The skill installation panel now shows an example repository address.
- **Simplified Conversation Types**: Removed the `conversationType` status to streamline conversation type management.

## v0.1.13

## New Features

- **Session-Scoped API Profiles**: Each conversation session now remembers its own API provider and model selection. A new `apiProfile` pipeline routes through Rust with graceful fallback, per-session storage binding, and an `Alt+P` shortcut to cycle providers. The provider selector has been moved into the model menu's secondary view for a cleaner header.
- **System Tray (macOS)**: Added full system tray support with template icons, hover statistics, and hide-to-tray. Active status dots are now parameterized instead of using app logos, and the 16 px shrink/solid-block rendering issue is fixed.
- **Personalization Settings**: A dedicated settings page for editing global and project-level `ROLE.md` files with a priority explainer. Global and project rules are composed automatically, and SSH workspaces are supported.
- **Built-in Documentation System**: Introduced an internal documentation framework with the `snow-app-docs` skill, allowing the agent to read bundled docs and assist with MCP, skills, and API configuration.
- **MCP Settings UI Enhancements**: Added a JSON edit mode, batch import, and localized error messages. Built-in `config` and `skills-config` services now support GitHub token and codeload fallback for skill installation.
- **File-Change Stats Panel**: Conversation sessions now display a file-change statistics panel summarizing additions, deletions, and modified files.
- **Right-Panel Context Menus**: Tabs and the terminal now support right-click context menus, including paste-in-terminal.
- **Bash Session Context Injection**: Bash tool execution now injects session context as environment variables, making session-scoped information available to subprocesses.
- **Project Creation & Raw Markdown Toggle**: Projects can now be created directly from the UI, and a raw markdown toggle is available for note editing.
- **Sub-Agent Read-Only View**: Optimized the sub-agent panel as a read-only view for clearer separation from the main conversation.

## Improvements

- **Network Error Handling & Retry**: Enhanced network error classification with exponential backoff retry at the Rust level. Visual (image) request failures now include diagnostic messages and base64 validity checks.
- **Cream Theme**: Introduced the Cream theme (formerly Anthropic theme) with refined personalization UI styling.
- **Git Graph & Refresh**: Added a manual git refresh button and improved graph lane rendering for better readability.
- **Session Icon Selector**: Migrated the session icon emoji selector to a context menu for a less cluttered sidebar.
- **Line-Ending Normalization**: Added `.gitattributes` to enforce LF line endings, preventing CRLF false diffs on Windows.

## Bug Fixes

- **MCP Discover Fallback**: When the modern `discover` handshake fails, the client automatically falls back to the legacy `initialize` flow (issue #19).
- **Plan Mode Approval Persistence**: Plan approval state is now preserved across session switches and migrated alongside pending requests.
- **SSH Browse Path History**: SSH directory browsing no longer loses path history when navigating back and forth.
- **macOS Tray Icon Rendering**: Fixed the tray icon shrinking to 16 px and becoming a solid block on macOS.
- **i18n Completeness**: Filled in missing translations for shortcuts and provider dropdown labels in both English and Chinese.
- **Copilot Review Feedback**: Addressed four review comments from Copilot covering code quality and correctness.

## v0.1.12

## New Features

- **macOS Unsigned Update Flow**: Implemented a full update pipeline for unsigned macOS builds — generates a `latest-mac.json` manifest with SHA-256 checksums per architecture, fetches and verifies updates in Rust before applying, and falls back to ad-hoc identity signing so unsigned builds can auto-update without a Developer ID certificate.
- **On-Demand Bash Subprocess Cancellation**: Every bash command now streams a `tool_execution` ID, enabling a Stop button in the UI and allowing session abort/rollback to kill the entire process tree of a running command.
- **WSL Git Support**: Git commands now run through `wsl.exe` when the configured terminal shell is WSL, with proper argument quoting and UNC path conversion.

## Improvements

- **Non-SSE Stream Retries Moved to Rust**: The entire Gemini/Responses request+stream cycle is wrapped in a single retry loop so non-SSE responses (HTTP 200 JSON errors or empty streams) are retried at the Rust level instead of being returned to the JS agent loop.
- **Git Commands Offloaded to Blocking Pool**: NAPI git exports now use `spawn_blocking`, preventing repo operations from blocking the async runtime.
- **Conversation History Load Deduplication**: Switching away and back while a conversation's initial history is still loading no longer discards the in-flight result or issues a duplicate re-fetch — selections share a single load promise and cache the result for instant reuse.
- **Session-Scoped Working Directories**: Tool execution, checkpoint creation, and hook cwd are now bound to the session's own directory rather than the runtime active directory, keeping checkpoints consistent even after switching projects.
- **Plan Mode Approval Migration**: Migrated Plan Mode approval from the standalone plan-mode server to the unified `app-control` request-approval flow.
- **TODO Panel Rework**: Replaced checkbox multi-select with inline add and click-to-cycle status for a cleaner, faster workflow.
- **File Type Icons**: Added file type icons in right-panel tabs and the diff viewer.
- **Release Notes Automation**: GitHub Releases now automatically extracts version-specific changelog content from `RELEASE_NOTES.md` instead of relying on manual input that was lost on tag-triggered builds.

## Bug Fixes

- **Reasoning Item Round-Tripping**: Added `collect_reasoning_items` to properly preserve reasoning output items across requests when `store: false`, preventing reasoning context loss in multi-turn conversations.
