//! 内置 MCP 服务全局开关。
//!
//! 开关状态持久化于 `system_settings` 表（setting_code = "builtin_services_status"，
//! JSON 对象 { service_id: bool }）。被禁用的服务其工具会在 mcp/tools.rs
//! 的工具暴露层被过滤，模型上下文中不可见、无法调用。
//!
//! 能力控制发生在工具暴露层而非运行层：禁用即不注册工具，比运行时拦截更干净。

use std::collections::BTreeMap;
use std::path::Path;

use napi::bindgen_prelude::*;

use super::system_settings::{get_system_setting_value, set_system_setting};

const BUILTIN_SERVICES_STATUS_SETTING_CODE: &str = "builtin_services_status";
const BUILTIN_SERVICES_STATUS_SETTING_NAME: &str = "Built-in services";

/// 全部内置 MCP 服务 id（与 mcp/builtin.rs 的注册列表保持一致）。
pub const BUILTIN_SERVICE_IDS: &[&str] = &[
    "filesystem",
    "bash",
    "todo",
    "grep",
    "websearch",
    "browser",
    "user-interaction",
    "sub-agents",
    "codebase",
    "codelens",
    "app-control",
];

/// 读取全局开关状态。未显式记录的服务的默认值为启用（true），
/// 保证升级前已存在的行为不受影响。
pub fn get_builtin_services_status(database_path: &Path) -> Result<BTreeMap<String, bool>> {
    let raw = get_system_setting_value(database_path, BUILTIN_SERVICES_STATUS_SETTING_CODE)?;
    let mut statuses: BTreeMap<String, bool> = match raw {
        Some(value) => serde_json::from_str(&value).unwrap_or_default(),
        None => BTreeMap::new(),
    };

    for service_id in BUILTIN_SERVICE_IDS {
        statuses.entry(service_id.to_string()).or_insert(true);
    }

    Ok(statuses)
}

/// 写入全局开关状态。只合并已知内置服务 id，未知 key 忽略；
/// 未提及的服务保持启用。
pub fn set_builtin_services_status(
    database_path: &Path,
    statuses: BTreeMap<String, bool>,
) -> Result<()> {
    let mut merged: BTreeMap<String, bool> = BTreeMap::new();
    for service_id in BUILTIN_SERVICE_IDS {
        merged.insert(
            service_id.to_string(),
            statuses.get(*service_id).copied().unwrap_or(true),
        );
    }

    let value = serde_json::to_string(&merged).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize built-in services status: {error}"),
        )
    })?;

    set_system_setting(
        database_path,
        BUILTIN_SERVICES_STATUS_SETTING_NAME,
        BUILTIN_SERVICES_STATUS_SETTING_CODE,
        &value,
    )
}

/// 判断某个内置服务是否被全局禁用（非内置服务 id 一律视为启用）。
pub fn is_builtin_service_enabled(
    statuses: &BTreeMap<String, bool>,
    service_id: &str,
) -> bool {
    match statuses.get(service_id) {
        Some(enabled) => *enabled,
        None => true,
    }
}
