# 4-configure-proxy

Snow App's proxy settings apply to application session network requests, web search, and the built-in browser. This article explains how to configure the proxy, search engine, and built-in browser.

## 1. Configuration Entries

| Entry | Description |
| --- | --- |
| Settings → Proxy & Browser (settings page id: `proxy-browser-settings`) | GUI: proxy, search engine, built-in browser configuration |
| `~/.snow/proxy-config.json` | Configuration file that can be synced with the app |

Configuration values are stored in the app's system settings and can be synced with `~/.snow/proxy-config.json`.

## 2. Configuring the Proxy

| Field | Description |
| --- | --- |
| `enabled` | Enable switch: whether to use a proxy |
| `host` | Proxy host, e.g. `127.0.0.1` |
| `port` | Proxy port, e.g. `7890` |

## 3. Configuring the Search Engine

| Field | Description |
| --- | --- |
| `searchEngine` | Search engine, e.g. `bing`, `duckduckgo` |

This setting affects the search result source of the `websearch` tool.

## 4. Configuring the Built-in Browser

| Field | Description |
| --- | --- |
| `browserPath` | Browser executable path; when empty, Chrome / Edge / Chromium is auto-detected, or click Browse to select manually |
| `browserDebugPort` | Browser debug port, e.g. `9222` |

The debug port is used for the built-in browser panel connection; if the port is occupied, the panel may fail to open.

## 5. Scope of Effect

- **App session proxy**: network requests, update checks;
- **Web search**: the `websearch` tool;
- **Built-in browser panel**: embedded browser instances.

## 6. AI / CLI Configuration (config tool)

Use the `config` tool to read/write the `proxy` scope (`~/.snow/proxy-config.json`, same source as the UI):

| Tool | Example |
| --- | --- |
| `config-get scope=proxy` | View the current proxy / search engine / browser config |
| `config-set scope=proxy value={enabled: true, host: "127.0.0.1", port: 7890}` | Enable the proxy |
| `config-set scope=proxy key=searchEngine value="duckduckgo"` | Switch the search engine |
| `config-set scope=proxy key=browserPath value="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"` | Set the browser path (Windows backslashes must be escaped as `\\` in JSON) |

> File-backed config: changes take effect after an app restart or a UI re-save;
> `config-list scope=proxy` lists all keys and current values.

## 7. FAQ

| Symptom | Cause & fix |
| --- | --- |
| Search fails | Check whether the proxy is enabled and whether `host`/`port` are correct |
| Browser panel won't open | Check whether `browserPath` is correct, or the debug port is occupied |
| Changes don't take effect | Make sure it was saved (inputs auto-save on blur) |

## 7. Reference

- Full field documentation: [3-reference/1-settings-json-reference](../3-reference/1-settings-json-reference.md)
