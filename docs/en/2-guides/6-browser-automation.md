# 6-Browser Automation

Snow App ships an embedded Electron browser that the AI agent can drive
directly to test, scrape and interact with web pages. This guide covers all
tools of the built-in `browser` server and typical workflows.

## 1. Tools Overview

| Tool | Purpose |
| --- | --- |
| `browser-create` | Create a browser instance (optional initial URL) |
| `browser-navigate` | Navigate to a URL |
| `browser-click` | Click page elements with real mouse events (CSS selector or visible text) |
| `browser-type` | Type text into an element (set at once or key by key) |
| `browser-evaluate` | Run arbitrary JavaScript in the page and return the result |
| `browser-screenshot` | Capture the page as PNG (full page supported) |
| `browser-devtools` | Page snapshot / console messages / network requests / dialog handling / open DevTools |
| `browser-close` | Close a browser tab |
| `browser-focus` | Switch to a tab |
| `browser-list` | List all open tabs |

## 2. Typical Workflows

### 2.1 Open a page

```text
browser-create url=https://example.com
→ creates an instance and returns its instanceId

browser-navigate instanceId=<id> url=https://example.com/docs
→ navigate to another URL
```

### 2.2 Inspect page state

```text
browser-devtools action=snapshot instanceId=<id>
→ page metadata + text snapshot (understand the page structure)

browser-devtools action=console level=error instanceId=<id>
→ console errors (troubleshoot page JS failures)

browser-devtools action=network filter=api instanceId=<id>
→ network request log (observe API calls)
```

### 2.3 Interact with the page

```text
# Click (by CSS selector or visible text)
browser-click selector="#submit-btn" instanceId=<id>
browser-click text="Sign in" instanceId=<id>

# Type text
browser-type selector="#username" value="user1" instanceId=<id>
browser-type text="password field" value="secret" delayMs=30 instanceId=<id>

# Evaluate arbitrary JS (read/mutate page state)
browser-evaluate expression="document.title" instanceId=<id>
```

### 2.4 Screenshot and close

```text
browser-screenshot instanceId=<id> fullPage=true
→ returns a PNG image

browser-close instanceId=<id>
```

## 3. Dialog (alert / confirm / prompt) handling

When the page shows a dialog, subsequent agent actions may be blocked:

```text
browser-devtools action=dialog instanceId=<id>
→ list pending dialogs

browser-devtools action=dialog dialogResponse={accept:true} instanceId=<id>
→ accept (OK) the dialog
browser-devtools action=dialog dialogResponse={accept:false} instanceId=<id>
→ dismiss (Cancel) the dialog
browser-devtools action=dialog dialogResponse={accept:true, promptText:"input"} instanceId=<id>
→ provide input for a prompt dialog
```

## 4. Best Practices

- **Snapshot before interacting**: use `browser-devtools action=snapshot` or
  `browser-evaluate` to confirm the page structure before picking selectors;
- **Multi-tab management**: `browser-list` lists all tabs,
  `browser-focus` switches to the target one;
- **Pair with the network panel**: when a page misbehaves, check
  `action=console level=error` and `action=network` before re-navigating;
- **Real mouse events**: `browser-click` uses real Electron mouse input
  events, unlike script injection — handlers relying on real events fire;
- **Not headless**: the built-in browser is an embedded window and requires
  the app to be running.

## 5. Related config

Proxy and browser paths are configured in **Settings → Proxy & Browser**
(`app-control-openSettings page=proxy-browser-settings`); fields are
documented in [3-config-file-field-reference](../3-reference/3-config-file-field-reference.md)
under `proxy-config.json` (`browserPath`, `browserDebugPort`).
