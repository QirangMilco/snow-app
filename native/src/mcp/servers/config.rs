//! Built-in MCP service that lets the agent read and write Snow App global
//! configuration files (`~/.snow/*.json`) through a whitelist-driven
//! key-value API.
//!
//! Tools:
//! - `config-list`   — list manageable scopes and their keys
//! - `config-get`    — read a value (sensitive keys are masked)
//! - `config-set`    — write a value (whitelist + type check + backup + atomic write)
//! - `config-delete` — remove an optional key
//!
//! Safety model:
//! - Only whitelisted scopes/keys are reachable; arbitrary paths are rejected.
//! - Values are type-checked against each key's schema before writing.
//! - Sensitive keys (apiKey, visionApiKey) are masked on read; plaintext is
//!   never returned by this service.
//! - Every write is preceded by a timestamped backup under
//!   `~/.snow/.config-backups/` (latest 10 kept per file) and the target file
//!   is replaced atomically (tmp file + rename) so a crash cannot corrupt it.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use serde_json::{json, Map, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

pub const SERVER_ID: &str = "config";

const TOOL_LIST: &str = "list";
const TOOL_GET: &str = "get";
const TOOL_SET: &str = "set";
const TOOL_DELETE: &str = "delete";

/// 配置值类型。
#[derive(Clone, Copy)]
enum ValueType {
    String,
    Bool,
    Int,
    Object,
    Array,
}

/// 单个键的规格（白名单 + 类型 + 敏感标记）。
struct KeySpec {
    key: &'static str,
    value_type: ValueType,
    sensitive: bool,
}

/// 一个配置域（= 一个文件 + 若干白名单键）。
struct ScopeSpec {
    scope: &'static str,
    file_name: &'static str,
    /// 读写文件中的哪个对象根（如 `snowcfg`），None 表示文件顶层。
    root_key: Option<&'static str>,
    keys: &'static [KeySpec],
}

const SETTINGS_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec { key: "mcpServers", value_type: ValueType::Object, sensitive: false },
    KeySpec { key: "codebase", value_type: ValueType::Object, sensitive: false },
    KeySpec { key: "sensitiveCommands", value_type: ValueType::Array, sensitive: false },
    KeySpec { key: "yoloMode", value_type: ValueType::Bool, sensitive: false },
    KeySpec { key: "planMode", value_type: ValueType::Bool, sensitive: false },
    KeySpec { key: "vulnerabilityHuntingMode", value_type: ValueType::Bool, sensitive: false },
    KeySpec { key: "toolSearchEnabled", value_type: ValueType::Bool, sensitive: false },
    KeySpec { key: "hybridCompressEnabled", value_type: ValueType::Bool, sensitive: false },
    KeySpec { key: "teamMode", value_type: ValueType::Bool, sensitive: false },
    KeySpec { key: "goal", value_type: ValueType::Object, sensitive: false },
    KeySpec { key: "ultraTodoEnabled", value_type: ValueType::Bool, sensitive: false },
];

const SNOWCFG_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec { key: "baseUrl", value_type: ValueType::String, sensitive: false },
    KeySpec { key: "baseUrlMode", value_type: ValueType::String, sensitive: false },
    KeySpec { key: "apiKey", value_type: ValueType::String, sensitive: true },
    KeySpec { key: "requestMethod", value_type: ValueType::String, sensitive: false },
    KeySpec { key: "advancedModel", value_type: ValueType::String, sensitive: false },
    KeySpec { key: "basicModel", value_type: ValueType::String, sensitive: false },
    KeySpec { key: "supportsVision", value_type: ValueType::Bool, sensitive: false },
    KeySpec { key: "visionBaseUrl", value_type: ValueType::String, sensitive: false },
    KeySpec { key: "visionApiKey", value_type: ValueType::String, sensitive: true },
    KeySpec { key: "visionModel", value_type: ValueType::String, sensitive: false },
    KeySpec { key: "maxContextTokens", value_type: ValueType::Int, sensitive: false },
    KeySpec { key: "maxTokens", value_type: ValueType::Int, sensitive: false },
    KeySpec { key: "showThinking", value_type: ValueType::Bool, sensitive: false },
    KeySpec { key: "streamIdleTimeoutSec", value_type: ValueType::Int, sensitive: false },
    KeySpec { key: "maxRetries", value_type: ValueType::Int, sensitive: false },
    KeySpec { key: "retryDelayMs", value_type: ValueType::Int, sensitive: false },
    KeySpec { key: "enableAutoCompress", value_type: ValueType::Bool, sensitive: false },
    KeySpec { key: "autoCompressThreshold", value_type: ValueType::Int, sensitive: false },
    KeySpec { key: "toolResultTokenLimit", value_type: ValueType::Int, sensitive: false },
];

const PROXY_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec { key: "enabled", value_type: ValueType::Bool, sensitive: false },
    KeySpec { key: "host", value_type: ValueType::String, sensitive: false },
    KeySpec { key: "port", value_type: ValueType::Int, sensitive: false },
    KeySpec { key: "searchEngine", value_type: ValueType::String, sensitive: false },
    KeySpec { key: "browserPath", value_type: ValueType::String, sensitive: false },
    KeySpec { key: "browserDebugPort", value_type: ValueType::Int, sensitive: false },
];

const APP_SCOPE_KEYS: &[KeySpec] = &[
    KeySpec { key: "activeProfile", value_type: ValueType::String, sensitive: false },
];

const SCOPES: &[ScopeSpec] = &[
    ScopeSpec { scope: "settings", file_name: "settings.json", root_key: None, keys: SETTINGS_SCOPE_KEYS },
    ScopeSpec { scope: "snowcfg", file_name: "config.json", root_key: Some("snowcfg"), keys: SNOWCFG_SCOPE_KEYS },
    ScopeSpec { scope: "proxy", file_name: "proxy-config.json", root_key: None, keys: PROXY_SCOPE_KEYS },
    ScopeSpec { scope: "app", file_name: "active-profile.json", root_key: None, keys: APP_SCOPE_KEYS },
];

/// 备份目录名（~/.snow/.config-backups）。
const BACKUP_DIR_NAME: &str = ".config-backups";
/// 每个文件保留的最大备份份数。
const MAX_BACKUPS_PER_FILE: usize = 10;

pub struct ConfigService {
    db_path: String,
}

impl ConfigService {
    pub fn new() -> Self {
        let storage_info = crate::storage::initialize_app_storage().map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to initialize app storage: {e}"),
            )
        });
        let db_path = match storage_info {
            Ok(info) => info.database_path,
            Err(_) => String::new(),
        };
        ConfigService { db_path }
    }

    /// Async entry point used by `call_mcp_tool` in tools.rs.
    pub async fn execute_async(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        let tool_name = tool_name.to_string();
        let args = args.clone();
        let db_path = self.db_path.clone();

        tokio::task::spawn_blocking(move || {
            let service = ConfigService { db_path };
            service.execute(&tool_name, &args)
        })
        .await
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Config service task failed: {error}"),
            )
        })?
    }

    /// `~/.snow` 目录路径（与 Snow CLI 共享）。
    fn snow_dir() -> PathBuf {
        dirs_next::home_dir()
            .map(|home| home.join(".snow"))
            .unwrap_or_else(|| PathBuf::from(".snow"))
    }

    /// 域对应的目标文件路径。
    fn scope_file_path(scope: &ScopeSpec) -> PathBuf {
        Self::snow_dir().join(scope.file_name)
    }

    fn find_scope(scope: &str) -> Option<&'static ScopeSpec> {
        SCOPES.iter().find(|spec| spec.scope == scope)
    }

    fn find_key<'a>(scope: &'a ScopeSpec, key: &str) -> Option<&'a KeySpec> {
        scope.keys.iter().find(|spec| spec.key == key)
    }

    /// 读取目标文件为 JSON 对象；文件不存在时返回域默认骨架。
    fn read_json(scope: &ScopeSpec) -> napi::Result<Map<String, Value>> {
        let file_path = Self::scope_file_path(scope);
        let content = match fs::read_to_string(&file_path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default_root(scope));
            }
            Err(error) => {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("Failed to read {}: {error}", file_path.display()),
                ));
            }
        };
        match serde_json::from_str::<Value>(&content) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unexpected JSON root in {} (expected object)",
                    file_path.display()
                ),
            )),
            Err(error) => Err(Error::new(
                Status::GenericFailure,
                format!("Invalid JSON in {}: {error}", file_path.display()),
            )),
        }
    }

    /// 域默认骨架（root_key 存在时以空对象承载）。
    fn default_root(scope: &ScopeSpec) -> Map<String, Value> {
        match scope.root_key {
            Some(root_key) => {
                let mut root = Map::new();
                root.insert(root_key.to_string(), Value::Object(Map::new()));
                root
            }
            None => Map::new(),
        }
    }

    /// 获取实际存储配置的根对象（root_key 存在时取/建子对象）。
    fn config_root<'a>(
        scope: &ScopeSpec,
        root: &'a mut Map<String, Value>,
    ) -> napi::Result<&'a mut Map<String, Value>> {
        match scope.root_key {
            None => Ok(root),
            Some(root_key) => {
                if !root.contains_key(root_key) {
                    root.insert(root_key.to_string(), Value::Object(Map::new()));
                }
                match root.get_mut(root_key) {
                    Some(Value::Object(map)) => Ok(map),
                    _ => Err(Error::new(
                        Status::GenericFailure,
                        format!(
                            "Invalid JSON structure: `{root_key}` is not an object in {}",
                            scope.file_name
                        ),
                    )),
                }
            }
        }
    }

    /// 敏感值脱敏：字符串保留首尾各 4 字符，其余显示 `****`。
    fn mask_value(value: &Value) -> Value {
        match value {
            Value::String(text) => {
                let chars: Vec<char> = text.chars().collect();
                if chars.len() <= 8 {
                    json!("****")
                } else {
                    let head: String = chars[..4].iter().collect();
                    let tail: String = chars[chars.len() - 4..].iter().collect();
                    json!(format!("{head}****{tail}"))
                }
            }
            _ => json!("****"),
        }
    }

    /// 校验值的类型与结构（写前检查）。
    fn validate_value(key_spec: &KeySpec, value: &Value) -> napi::Result<()> {
        let type_ok = match key_spec.value_type {
            ValueType::String => value.is_string(),
            ValueType::Bool => value.is_boolean(),
            ValueType::Int => value.is_i64() || value.is_u64(),
            ValueType::Object => value.is_object(),
            ValueType::Array => value.is_array(),
        };
        if !type_ok {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "Invalid value type for key `{}` (expected {})",
                    key_spec.key,
                    type_name(key_spec.value_type)
                ),
            ));
        }
        // 结构性校验：mcpServers 的每个服务器条目必须是对象。
        if key_spec.key == "mcpServers" {
            if let Value::Object(servers) = value {
                for (name, entry) in servers {
                    if !entry.is_object() {
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!("mcpServers.{name} must be an object"),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// 备份目标文件（保留 MAX_BACKUPS_PER_FILE 份，超出删除最旧）。
    fn backup_file(file_path: &Path) -> napi::Result<()> {
        if !file_path.exists() {
            return Ok(());
        }
        let backup_dir = Self::snow_dir().join(BACKUP_DIR_NAME);
        fs::create_dir_all(&backup_dir).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to create backup dir: {error}"),
            )
        })?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config");
        let backup_path = backup_dir.join(format!("{file_name}.{timestamp}.bak"));
        fs::copy(file_path, &backup_path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to backup {}: {error}", file_path.display()),
            )
        })?;

        // 清理超出上限的旧备份（按路径字典序即时间序）。
        let prefix = format!("{file_name}.");
        let mut backups: Vec<PathBuf> = fs::read_dir(&backup_dir)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| {
                                name.starts_with(&prefix) && name.ends_with(".bak")
                            })
                    })
                    .collect()
            })
            .unwrap_or_default();
        backups.sort();
        while backups.len() > MAX_BACKUPS_PER_FILE {
            if let Some(oldest) = backups.first() {
                let _ = fs::remove_file(oldest);
            }
            backups.remove(0);
        }
        Ok(())
    }

    /// 原子写入：先写 tmp 文件再 rename 覆盖目标。
    fn atomic_write(file_path: &Path, content: &str) -> napi::Result<()> {
        let tmp_path = file_path.with_extension("json.tmp");
        fs::write(&tmp_path, content).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to write {}: {error}", tmp_path.display()),
            )
        })?;
        fs::rename(&tmp_path, file_path).map_err(|error| {
            let _ = fs::remove_file(&tmp_path);
            Error::new(
                Status::GenericFailure,
                format!("Failed to replace {}: {error}", file_path.display()),
            )
        })
    }

    /// 把 settings.json 的 mcpServers 差集同步到应用 DB（生效作用域）。
    ///
    /// 语义与 UI "同步 Snow CLI MCP 设置" 完全一致：
    /// - upsert 文件中出现的每个服务器（serverId = `global:{name}`，
    ///   source = `snow-cli`）；
    /// - 删除 DB 中 source=snow-cli、serverId 以 `global:` 开头、但不在
    ///   新文件中的孤儿条目。
    ///
    /// 同步成功后配置立即生效（应用运行时直接读 DB），无需用户手动同步。
    fn sync_mcp_servers_to_db(&self, value: &Value) -> napi::Result<()> {
        use crate::storage::services::mcp_server_configs as mcp_store;

        let db_path = std::path::Path::new(&self.db_path);
        let servers = match value {
            Value::Object(servers) => servers,
            _ => return Ok(()),
        };

        let mut next_ids = std::collections::HashSet::new();
        for (index, (name, entry)) in servers.iter().enumerate() {
            let server = match entry {
                Value::Object(server) => server,
                _ => continue,
            };
            let server_id = format!("global:{name}");
            next_ids.insert(server_id.clone());

            let input = crate::storage::McpServerConfigInput {
                server_id,
                name: name.clone(),
                transport_type: server
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("stdio")
                    .to_string(),
                url: server
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                command: server
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                args_json: serde_json::to_string(server.get("args").unwrap_or(&json!([])))
                    .unwrap_or_else(|_| "[]".to_string()),
                env_json: serde_json::to_string(server.get("env").unwrap_or(&json!({})))
                    .unwrap_or_else(|_| "{}".to_string()),
                headers_json: serde_json::to_string(server.get("headers").unwrap_or(&json!({})))
                    .unwrap_or_else(|_| "{}".to_string()),
                enabled: server.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                timeout_ms: server
                    .get("timeoutMs")
                    .and_then(Value::as_i64)
                    .map(|value| value as i32),
                sort_order: index as i32,
                source: "snow-cli".to_string(),
            };
            mcp_store::upsert_mcp_server_config(db_path, &input).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to sync MCP server config to app database: {error}"),
                )
            })?;
        }

        // 差集删除：DB 中 source=snow-cli 的 global:* 孤儿条目。
        let existing = mcp_store::list_mcp_server_configs(db_path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to list MCP server configs for sync: {error}"),
            )
        })?;
        for item in existing {
            if item.source == "snow-cli"
                && item.server_id.starts_with("global:")
                && !next_ids.contains(&item.server_id)
            {
                mcp_store::delete_mcp_server_config(db_path, &item.server_id).map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to delete stale MCP server config: {error}"),
                    )
                })?;
            }
        }
        Ok(())
    }

    /// 删除 settings.mcpServers 键时，同步清空 DB 中 source=snow-cli 的
    /// global:* 服务器（与 UI 同步的差集语义对称；UI 手动添加的 manual
    /// 条目不受影响）。
    fn clear_snow_cli_mcp_servers_from_db(&self) -> napi::Result<()> {
        use crate::storage::services::mcp_server_configs as mcp_store;

        let db_path = std::path::Path::new(&self.db_path);
        let existing = mcp_store::list_mcp_server_configs(db_path).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to list MCP server configs for cleanup: {error}"),
            )
        })?;
        for item in existing {
            if item.source == "snow-cli" && item.server_id.starts_with("global:") {
                mcp_store::delete_mcp_server_config(db_path, &item.server_id).map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to delete MCP server config: {error}"),
                    )
                })?;
            }
        }
        Ok(())
    }

    fn execute_list(&self, args: &Value) -> napi::Result<Value> {
        if let Some(scope_name) = args.get("scope").and_then(Value::as_str) {
            let scope = Self::find_scope(scope_name).ok_or_else(|| invalid_scope_error(scope_name))?;
            let mut root = Self::read_json(scope)?;
            let config_root = Self::config_root(scope, &mut root)?;

            let mut keys = Vec::new();
            for key_spec in scope.keys {
                let configured = config_root.contains_key(key_spec.key);
                let display = match config_root.get(key_spec.key) {
                    Some(value) if key_spec.sensitive => Self::mask_value(value),
                    Some(value) => value.clone(),
                    None => Value::Null,
                };
                keys.push(json!({
                    "key": key_spec.key,
                    "type": type_name(key_spec.value_type),
                    "sensitive": key_spec.sensitive,
                    "configured": configured,
                    "value": display,
                }));
            }
            Ok(json!({
                "scope": scope.scope,
                "file": scope.file_name,
                "keys": keys,
            }))
        } else {
            let scopes: Vec<Value> = SCOPES
                .iter()
                .map(|scope| {
                    json!({
                        "scope": scope.scope,
                        "file": scope.file_name,
                        "keys": scope.keys.iter().map(|spec| spec.key).collect::<Vec<_>>(),
                    })
                })
                .collect();
            Ok(json!({ "scopes": scopes }))
        }
    }

    fn execute_get(&self, args: &Value) -> napi::Result<Value> {
        let scope_name = required_string(args, "scope")?;
        let key_name = required_string(args, "key")?;
        let scope = Self::find_scope(scope_name).ok_or_else(|| invalid_scope_error(scope_name))?;
        let key_spec = Self::find_key(scope, key_name).ok_or_else(|| invalid_key_error(scope, key_name))?;

        let mut root = Self::read_json(scope)?;
        let config_root = Self::config_root(scope, &mut root)?;
        let display = match config_root.get(key_name) {
            Some(value) if key_spec.sensitive => Self::mask_value(value),
            Some(value) => value.clone(),
            None => Value::Null,
        };
        Ok(json!({
            "scope": scope.scope,
            "key": key_name,
            "value": display,
        }))
    }

    fn execute_set(&self, args: &Value) -> napi::Result<Value> {
        let scope_name = required_string(args, "scope")?;
        let key_name = required_string(args, "key")?;
        let value = args.get("value").cloned().ok_or_else(|| {
            Error::new(Status::InvalidArg, "value is required for config-set".to_string())
        })?;
        let scope = Self::find_scope(scope_name).ok_or_else(|| invalid_scope_error(scope_name))?;
        let key_spec = Self::find_key(scope, key_name).ok_or_else(|| invalid_key_error(scope, key_name))?;
        Self::validate_value(key_spec, &value)?;

        // settings.mcpServers 特殊处理：同步到应用 DB（生效作用域），
        // 差集语义与 UI "同步 Snow CLI MCP 设置" 完全一致，立即生效。
        // DB 同步失败时中止（文件保持不变），保证文件与 DB 一致。
        if scope.scope == "settings" && key_name == "mcpServers" && !self.db_path.is_empty() {
            self.sync_mcp_servers_to_db(&value)?;
        }

        let file_path = Self::scope_file_path(scope);
        Self::backup_file(&file_path)?;

        let mut root = Self::read_json(scope)?;
        {
            let config_root = Self::config_root(scope, &mut root)?;
            config_root.insert(key_name.to_string(), value.clone());
        }
        let content = serde_json::to_string_pretty(&Value::Object(root)).map_err(|error| {
            Error::new(Status::GenericFailure, format!("Failed to serialize config: {error}"))
        })?;
        Self::atomic_write(&file_path, &content)?;

        let display = if key_spec.sensitive {
            Self::mask_value(&value)
        } else {
            value
        };
        Ok(json!({
            "scope": scope.scope,
            "key": key_name,
            "value": display,
        }))
    }

    fn execute_delete(&self, args: &Value) -> napi::Result<Value> {
        let scope_name = required_string(args, "scope")?;
        let key_name = required_string(args, "key")?;
        let scope = Self::find_scope(scope_name).ok_or_else(|| invalid_scope_error(scope_name))?;
        // 仅校验键存在（白名单），无需保留绑定。
        Self::find_key(scope, key_name).ok_or_else(|| invalid_key_error(scope, key_name))?;

        let file_path = Self::scope_file_path(scope);
        let mut root = Self::read_json(scope)?;
        let removed = {
            let config_root = Self::config_root(scope, &mut root)?;
            config_root.remove(key_name).is_some()
        };
        if !removed {
            return Ok(json!({
                "scope": scope.scope,
                "key": key_name,
                "deleted": false,
            }));
        }

        // settings.mcpServers 删除时同步清空 DB 中 source=snow-cli 的
        // global:* 服务器（与 UI 同步的差集语义对称）。
        if scope.scope == "settings" && key_name == "mcpServers" && !self.db_path.is_empty() {
            self.clear_snow_cli_mcp_servers_from_db()?;
        }

        Self::backup_file(&file_path)?;
        let content = serde_json::to_string_pretty(&Value::Object(root)).map_err(|error| {
            Error::new(Status::GenericFailure, format!("Failed to serialize config: {error}"))
        })?;
        Self::atomic_write(&file_path, &content)?;
        Ok(json!({
            "scope": scope.scope,
            "key": key_name,
            "deleted": true,
        }))
    }
}

impl McpService for ConfigService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_LIST.to_string(),
                description: "List manageable configuration scopes and their keys. Scopes: settings (~/.snow/settings.json: mcpServers, codebase, sensitiveCommands, yoloMode, planMode, ...), snowcfg (~/.snow/config.json snowcfg object: baseUrl, apiKey, advancedModel, ...), proxy (~/.snow/proxy-config.json: enabled, host, port, searchEngine, browserPath, browserDebugPort), app (~/.snow/active-profile.json: activeProfile). Pass `scope` to inspect a single scope with current values; sensitive values (apiKey, visionApiKey) are masked.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "enum": ["settings", "snowcfg", "proxy", "app"],
                            "description": "Optional config scope name; when omitted, lists all scopes."
                        }
                    },
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_GET.to_string(),
                description: "Read the value of a configuration key. Sensitive keys (apiKey, visionApiKey) are always returned masked (e.g. sk-****abcd); this tool never exposes plaintext secrets. Returns null when the key is not configured.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "enum": ["settings", "snowcfg", "proxy", "app"],
                            "description": "Config scope name."
                        },
                        "key": {
                            "type": "string",
                            "description": "Key name within the scope (see config-list)."
                        }
                    },
                    "required": ["scope", "key"],
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_SET.to_string(),
                description: "Write a value for a configuration key. Only whitelisted scopes/keys are accepted; the value is type-checked, the target file is backed up to ~/.snow/.config-backups before the write, and the file is replaced atomically. Special case: writing `mcpServers` in the `settings` scope also syncs the servers into the app database (same diff semantics as the UI 'Sync Snow CLI MCP settings' action), so MCP changes take effect immediately without manual sync. Other settings (snowcfg/proxy/app) are file-based and may require an app restart or UI re-save.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "enum": ["settings", "snowcfg", "proxy", "app"],
                            "description": "Config scope name."
                        },
                        "key": {
                            "type": "string",
                            "description": "Key name within the scope (see config-list)."
                        },
                        "value": {
                            "description": "New value; type must match the key schema (see config-list)."
                        }
                    },
                    "required": ["scope", "key", "value"],
                    "additionalProperties": false
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: TOOL_DELETE.to_string(),
                description: "Delete a configuration key (e.g. clear an apiKey). The target file is backed up before the write and replaced atomically. Returns deleted=false when the key was not configured.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "enum": ["settings", "snowcfg", "proxy", "app"],
                            "description": "Config scope name."
                        },
                        "key": {
                            "type": "string",
                            "description": "Key name within the scope (see config-list)."
                        }
                    },
                    "required": ["scope", "key"],
                    "additionalProperties": false
                }),
            },
        ]
    }

    fn execute(&self, tool_name: &str, args: &Value) -> napi::Result<Value> {
        match tool_name {
            TOOL_LIST => self.execute_list(args),
            TOOL_GET => self.execute_get(args),
            TOOL_SET => self.execute_set(args),
            TOOL_DELETE => self.execute_delete(args),
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown tool: \"{tool_name}\" for MCP server \"{SERVER_ID}\". Available tools: [config-list, config-get, config-set, config-delete]"
                ),
            )),
        }
    }
}

fn type_name(value_type: ValueType) -> &'static str {
    match value_type {
        ValueType::String => "string",
        ValueType::Bool => "boolean",
        ValueType::Int => "integer",
        ValueType::Object => "object",
        ValueType::Array => "array",
    }
}

fn available_scopes() -> String {
    SCOPES
        .iter()
        .map(|spec| spec.scope)
        .collect::<Vec<_>>()
        .join(", ")
}

fn available_keys(scope: &ScopeSpec) -> String {
    scope
        .keys
        .iter()
        .map(|spec| spec.key)
        .collect::<Vec<_>>()
        .join(", ")
}

fn invalid_scope_error(scope: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!(
            "Unknown config scope: \"{scope}\". Available scopes: [{}]",
            available_scopes()
        ),
    )
}

fn invalid_key_error(scope: &ScopeSpec, key: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!(
            "Unknown config key: \"{key}\" in scope \"{}\". Available keys: [{}]",
            scope.scope,
            available_keys(scope)
        ),
    )
}

fn required_string<'a>(args: &'a Value, key: &str) -> napi::Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("{key} is required")))
}
