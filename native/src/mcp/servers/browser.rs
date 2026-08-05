use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

const SERVER_ID: &str = "browser";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_MAX_CONTENT_LENGTH: u64 = 20_000;
const MIN_MAX_CONTENT_LENGTH: u64 = 1_000;
const MAX_MAX_CONTENT_LENGTH: u64 = 100_000;

#[napi(object)]
pub struct BrowserCommand {
    pub operation: String,
    pub args_json: String,
}

pub type BrowserCommandCallback =
    ThreadsafeFunction<BrowserCommand, Promise<String>, BrowserCommand, Status, false>;

pub struct BrowserService;

impl BrowserService {
    pub fn new() -> Self {
        BrowserService
    }

    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        on_command: &BrowserCommandCallback,
    ) -> napi::Result<Value> {
        let normalized_args = validate_and_normalize_args(tool_name, args)?;
        let command = BrowserCommand {
            operation: tool_name.to_string(),
            args_json: serde_json::to_string(&normalized_args).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to serialize browser command: {error}"),
                )
            })?,
        };

        let promise = on_command
            .call_async_catch(command)
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to dispatch browser command to Electron: {error}"),
                )
            })?;
        let result_json = promise.await.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Browser command failed: {error}"),
            )
        })?;

        serde_json::from_str(&result_json).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Browser command returned invalid JSON: {error}"),
            )
        })
    }
}

impl McpService for BrowserService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "create".to_string(),
                description: "Create an embedded Electron browser instance in the right panel. Returns an instanceId for explicitly targeting it later. Optionally opens an initial URL.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Optional initial URL (http://, https://, or file://). If omitted, the configured browser homepage is used."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "navigate".to_string(),
                description: "Navigate an embedded browser instance to a URL (http://, https://, or file://) and wait asynchronously for loading to finish. Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "url": {
                            "type": "string",
                            "description": "URL to visit (http://, https://, or file://)."
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Navigation timeout in milliseconds (default 30000, range 1000-120000).",
                            "default": DEFAULT_TIMEOUT_MS,
                            "minimum": MIN_TIMEOUT_MS,
                            "maximum": MAX_TIMEOUT_MS
                        }
                    },
                    "required": ["url"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "click".to_string(),
                description: "Click page content in an embedded browser with a real Electron mouse input event. Target an element with a CSS selector or visible text. Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the element to click."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate when selector is not provided."
                        },
                        "exact": {
                            "type": "boolean",
                            "description": "Whether text matching must be exact (default false).",
                            "default": false
                        }
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] }
                    ]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "screenshot".to_string(),
                description: "Capture an embedded browser page as PNG. Omit instanceId to capture the most recently focused browser tab, including a browser opened by the user. Returns page metadata and an image content block containing base64 PNG data.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "fullPage": {
                            "type": "boolean",
                            "description": "Capture the full scrollable page instead of only the viewport (default false).",
                            "default": false
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "devtools".to_string(),
                description: "Inspect developer-tools-related information for an embedded browser. Omit instanceId to inspect the most recently focused browser tab, including a browser opened by the user. Use action=snapshot for page metadata and text, action=console for captured console messages (optionally filtered by level), action=network for recorded network requests, action=dialog to list and respond to pending JavaScript dialogs (alert/confirm/prompt), or action=open to open Electron DevTools for the page.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "action": {
                            "type": "string",
                            "enum": ["snapshot", "console", "open", "network", "dialog"],
                            "description": "Developer tools action (default snapshot).",
                            "default": "snapshot"
                        },
                        "clearConsole": {
                            "type": "boolean",
                            "description": "Clear captured console messages after returning them (console action only).",
                            "default": false
                        },
                        "level": {
                            "type": "string",
                            "enum": ["verbose", "info", "warning", "error"],
                            "description": "Minimum console level to return (console action only). Each level includes more severe levels. Defaults to info."
                        },
                        "filter": {
                            "type": "string",
                            "description": "Only return network requests whose URL matches this regexp (network action only)."
                        },
                        "limit": {
                            "type": "number",
                            "description": "Maximum number of network requests to return (network action only, default 50, range 1-200).",
                            "default": 50,
                            "minimum": 1,
                            "maximum": 200
                        },
                        "dialogResponse": {
                            "type": "object",
                            "description": "Response for the dialog action: { accept: boolean, promptText?: string }. When provided, the most recent pending dialog is answered instead of listing dialogs.",
                            "properties": {
                                "accept": {
                                    "type": "boolean",
                                    "description": "true to accept (OK) the dialog, false to dismiss (Cancel)."
                                },
                                "promptText": {
                                    "type": "string",
                                    "description": "Text to enter for prompt dialogs."
                                }
                            },
                            "required": ["accept"]
                        },
                        "maxContentLength": {
                            "type": "number",
                            "description": "Maximum page text length for snapshot (default 20000, range 1000-100000).",
                            "default": DEFAULT_MAX_CONTENT_LENGTH,
                            "minimum": MIN_MAX_CONTENT_LENGTH,
                            "maximum": MAX_MAX_CONTENT_LENGTH
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "close".to_string(),
                description: "Close an embedded browser tab and destroy its webview. Omit instanceId to close the most recently focused browser tab. Use the list tool to see available browser tabs and their IDs.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID to close. Omit it or use current to close the most recently focused embedded browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "focus".to_string(),
                description: "Switch to (activate) an embedded browser tab by its instance ID, bringing it to the foreground. Use the list tool to see available browser tabs and their IDs.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "The browser instance ID to switch to."
                        }
                    },
                    "required": ["instanceId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "list".to_string(),
                description: "List all open embedded browser tabs with their instance IDs, titles, URLs, and active state. Use this to discover available tabs before closing or switching.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "evaluate".to_string(),
                description: "Evaluate a JavaScript expression in an embedded browser page and return the serialized result. Use for inspecting page state, reading variables, or exercising the page directly. Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "expression": {
                            "type": "string",
                            "description": "JavaScript expression to evaluate in the page (e.g. \"document.title\" or \"(() => ({ url: location.href, ready: document.readyState }))()\")."
                        }
                    },
                    "required": ["expression"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "type".to_string(),
                description: "Type text into an editable element in an embedded browser. Target the element with a CSS selector or visible text (same locating rules as browser-click). By default the value is set at once and input/change events are fired; pass delayMs to type character by character for key handlers. Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the target element."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate when selector is not provided."
                        },
                        "value": {
                            "type": "string",
                            "description": "Text to type into the element."
                        },
                        "submit": {
                            "type": "boolean",
                            "description": "Whether to submit the containing form after typing (default false).",
                            "default": false
                        },
                        "delayMs": {
                            "type": "number",
                            "description": "When greater than 0, type one character at a time with this delay in milliseconds (default 0 = set value at once).",
                            "default": 0,
                            "minimum": 0,
                            "maximum": 1000
                        }
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] }
                    ],
                    "required": ["value"]
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "create" | "navigate" | "click" | "screenshot" | "devtools" | "close" | "focus"
            | "list" | "evaluate" | "type" => Err(Error::new(
                Status::GenericFailure,
                "Browser tools must be executed through the asynchronous Electron command bridge"
                    .to_string(),
            )),
            _ => Err(unknown_tool_error(tool_name)),
        }
    }
}

fn validate_and_normalize_args(tool_name: &str, args: &Value) -> napi::Result<Value> {
    let object = args.as_object().ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("Arguments for browser-{tool_name} must be a JSON object"),
        )
    })?;
    let mut normalized = object.clone();

    match tool_name {
        "create" => {
            if let Some(url) = optional_non_empty_string(args, "url")? {
                validate_web_url(url)?;
            }
        }
        "navigate" => {
            optional_non_empty_string(args, "instanceId")?;
            let url = required_non_empty_string(args, "url", tool_name)?;
            validate_web_url(url)?;
            let timeout = bounded_u64(
                args,
                "timeoutMs",
                DEFAULT_TIMEOUT_MS,
                MIN_TIMEOUT_MS,
                MAX_TIMEOUT_MS,
            )?;
            normalized.insert("timeoutMs".to_string(), json!(timeout));
        }
        "click" => {
            optional_non_empty_string(args, "instanceId")?;
            let selector = optional_non_empty_string(args, "selector")?;
            let text = optional_non_empty_string(args, "text")?;
            if selector.is_none() && text.is_none() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Either selector or text is required for browser-click".to_string(),
                ));
            }
            optional_boolean(args, "exact")?;
        }
        "screenshot" => {
            optional_non_empty_string(args, "instanceId")?;
            optional_boolean(args, "fullPage")?;
        }
        "devtools" => {
            optional_non_empty_string(args, "instanceId")?;
            let action = args
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("snapshot");
            if !matches!(
                action,
                "snapshot" | "console" | "open" | "network" | "dialog"
            ) {
                return Err(Error::new(
                    Status::InvalidArg,
                    "action must be one of snapshot, console, open, network, or dialog for browser-devtools"
                        .to_string(),
                ));
            }
            optional_boolean(args, "clearConsole")?;
            if let Some(level) = optional_non_empty_string(args, "level")? {
                if !matches!(level, "verbose" | "info" | "warning" | "error") {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "level must be one of verbose, info, warning, or error for browser-devtools"
                            .to_string(),
                    ));
                }
            }
            if let Some(filter) = optional_non_empty_string(args, "filter")? {
                if regex::Regex::new(filter).is_err() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "filter must be a valid regular expression for browser-devtools"
                            .to_string(),
                    ));
                }
            }
            let limit = bounded_u64(args, "limit", 50, 1, 200)?;
            if let Some(response) = args.get("dialogResponse") {
                if !response.is_object() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "dialogResponse must be an object for browser-devtools".to_string(),
                    ));
                }
                let accept = response.get("accept").and_then(Value::as_bool);
                if accept.is_none() {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "dialogResponse.accept must be a boolean for browser-devtools".to_string(),
                    ));
                }
                optional_non_empty_string(response, "promptText")?;
            }
            let max_content_length = bounded_u64(
                args,
                "maxContentLength",
                DEFAULT_MAX_CONTENT_LENGTH,
                MIN_MAX_CONTENT_LENGTH,
                MAX_MAX_CONTENT_LENGTH,
            )?;
            normalized.insert("action".to_string(), json!(action));
            normalized.insert("limit".to_string(), json!(limit));
            normalized.insert("maxContentLength".to_string(), json!(max_content_length));
        }
        "evaluate" => {
            optional_non_empty_string(args, "instanceId")?;
            required_non_empty_string(args, "expression", tool_name)?;
        }
        "type" => {
            optional_non_empty_string(args, "instanceId")?;
            let selector = optional_non_empty_string(args, "selector")?;
            let text = optional_non_empty_string(args, "text")?;
            if selector.is_none() && text.is_none() {
                return Err(Error::new(
                    Status::InvalidArg,
                    "Either selector or text is required for browser-type".to_string(),
                ));
            }
            required_string(args, "value", tool_name)?;
            optional_boolean(args, "submit")?;
            let delay_ms = bounded_u64(args, "delayMs", 0, 0, 1000)?;
            normalized.insert("delayMs".to_string(), json!(delay_ms));
        }
        "close" => {
            optional_non_empty_string(args, "instanceId")?;
        }
        "focus" => {
            required_non_empty_string(args, "instanceId", tool_name)?;
        }
        "list" => {}
        _ => return Err(unknown_tool_error(tool_name)),
    }

    Ok(Value::Object(normalized))
}

fn required_string<'a>(args: &'a Value, field: &str, tool_name: &str) -> napi::Result<&'a str> {
    args.get(field).and_then(Value::as_str).ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("{field} must be a string for browser-{tool_name}"),
        )
    })
}

fn required_non_empty_string<'a>(
    args: &'a Value,
    field: &str,
    tool_name: &str,
) -> napi::Result<&'a str> {
    args.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} is required for browser-{tool_name}"),
            )
        })
}

fn optional_non_empty_string<'a>(args: &'a Value, field: &str) -> napi::Result<Option<&'a str>> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Err(Error::new(
                    Status::InvalidArg,
                    format!("{field} must not be empty when provided"),
                ))
            } else {
                Ok(Some(trimmed))
            }
        }
        Some(_) => Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be a string when provided"),
        )),
    }
}

fn optional_boolean(args: &Value, field: &str) -> napi::Result<()> {
    if args
        .get(field)
        .is_some_and(|value| !value.is_null() && !value.is_boolean())
    {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be a boolean when provided"),
        ));
    }
    Ok(())
}

fn bounded_u64(
    args: &Value,
    field: &str,
    default: u64,
    minimum: u64,
    maximum: u64,
) -> napi::Result<u64> {
    let value = match args.get(field) {
        None | Some(Value::Null) => default,
        Some(value) => value.as_u64().ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("{field} must be a positive integer"),
            )
        })?,
    };

    if !(minimum..=maximum).contains(&value) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{field} must be between {minimum} and {maximum}"),
        ));
    }
    Ok(value)
}

fn validate_web_url(url: &str) -> napi::Result<()> {
    if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("file://") {
        return Ok(());
    }
    Err(Error::new(
        Status::InvalidArg,
        "Browser URLs must start with http://, https://, or file://".to_string(),
    ))
}

fn unknown_tool_error(tool_name: &str) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "Unknown tool: \"{tool_name}\" for MCP server \"browser\". Available tools: [browser-create, browser-navigate, browser-click, browser-screenshot, browser-devtools, browser-close, browser-focus, browser-list, browser-evaluate, browser-type]"
        ),
    )
}
