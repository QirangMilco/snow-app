# Release Notes

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
