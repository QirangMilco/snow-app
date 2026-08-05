//! 图像管理系统（Image Library）
//!
//! 生成的图片落盘到 `~/.snowapp/image/` 目录（按日期子目录区分），
//! 元数据写入 `image_library` 表。删除图片时同步重写会话消息
//! （content / raw_json 中的图片引用），保证会话内不再显示已删除的图。

use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use base64::Engine;
use super::super::database;
use super::super::paths;
use super::system_settings;

/// image_library 记录（服务层结构体，napi 结构体在 storage/mod.rs 门面层）
#[derive(Debug, Clone)]
pub struct ImageLibraryRecord {
    pub id: String,
    pub relative_path: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub prompt: String,
    pub model: String,
    pub provider: String,
    pub created_at: String,
}

/// 建表（B 模式：在 database.rs::create_schema() 末尾调用）
pub fn ensure_image_library_table(connection: &rusqlite::Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS image_library (
           id TEXT PRIMARY KEY NOT NULL,
           relative_path TEXT NOT NULL UNIQUE,
           file_name TEXT NOT NULL DEFAULT '',
           mime_type TEXT NOT NULL DEFAULT 'image/png',
           size_bytes INTEGER NOT NULL DEFAULT 0,
           width INTEGER,
           height INTEGER,
           prompt TEXT NOT NULL DEFAULT '',
           model TEXT NOT NULL DEFAULT '',
           provider TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_image_library_created
           ON image_library(created_at DESC, id DESC);",
    )
}

/// 图片根目录：优先读取用户自定义路径（system_settings `image_library_dir`），
/// 未设置或路径无效时回退到默认 `~/.snowapp/image`。跨平台一致
/// （macOS / Windows / Linux 均解析到用户主目录），
/// persist 时按 `root/YYYY-MM-DD/文件名` 落盘。
pub fn image_library_root() -> Result<PathBuf> {
    let database_path = paths::database_file_path(&paths::app_storage_dir()?);
    let custom_dir = system_settings::get_image_library_dir(&database_path).unwrap_or_default();
    if !custom_dir.is_empty() {
        let candidate = PathBuf::from(&custom_dir);
        if fs::create_dir_all(&candidate).is_ok() {
            return Ok(candidate);
        }
        // 自定义路径不可用，回退默认
    }
    let storage_dir = paths::app_storage_dir()?;
    let image_dir = storage_dir.join("image");
    fs::create_dir_all(&image_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create image library directory at '{}': {error}",
            image_dir.display()
        ))
    })?;
    Ok(image_dir)
}

fn ext_for_mime(mime_type: &str) -> &'static str {
    let lower = mime_type.to_ascii_lowercase();
    if lower.contains("jpeg") || lower.contains("jpg") {
        "jpg"
    } else if lower.contains("webp") {
        "webp"
    } else if lower.contains("gif") {
        "gif"
    } else {
        "png"
    }
}

/// 从图片二进制头部探测宽高（PNG / JPEG；其余格式返回 None）。
fn probe_dimensions(bytes: &[u8], mime_type: &str) -> (Option<i64>, Option<i64>) {
    let lower = mime_type.to_ascii_lowercase();
    if lower.contains("png") && bytes.len() >= 24 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return (Some(width as i64), Some(height as i64));
    }
    if lower.contains("jpeg") && bytes.len() >= 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        // 扫描 SOF0-SOF15 标记（0xC0-0xCF 中的 C0-C3/C5-C7/C9-CB/CD-CF）
        let mut offset = 2usize;
        while offset + 9 < bytes.len() {
            if bytes[offset] != 0xFF {
                offset += 1;
                continue;
            }
            let marker = bytes[offset + 1];
            if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
                let height = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]);
                let width = u16::from_be_bytes([bytes[offset + 7], bytes[offset + 8]]);
                return (Some(width as i64), Some(height as i64));
            }
            if marker == 0xD8 || (0xD0..=0xD9).contains(&marker) {
                offset += 2;
                continue;
            }
            if offset + 4 <= bytes.len() {
                let seg_len = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
                if seg_len < 2 {
                    break;
                }
                offset += 2 + seg_len;
            } else {
                break;
            }
        }
    }
    (None, None)
}

/// 将结果 content 中的 base64 图片块落盘并写入索引。
/// 成功块改写为 `{"type":"image","path":"image/YYYY-MM-DD/xxx.png","mimeType":...}`
/// （消息里不再携带大体积 base64）；任何一块失败都保留原 data 字段（容错）。
/// 返回成功落盘的相对路径列表。
pub fn persist_generated_images(
    database_path: &Path,
    prompt: &str,
    model: &str,
    provider: &str,
    blocks: &mut [Value],
) -> Result<Vec<String>> {
    let root = image_library_root()?;
    let date_dir = chrono::Local::now().format("%Y-%m-%d").to_string();
    let target_dir = root.join(&date_dir);
    fs::create_dir_all(&target_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create image library date directory '{}': {error}",
            target_dir.display()
        ))
    })?;

    let mut stored: Vec<String> = Vec::new();
    for block in blocks.iter_mut() {
        if block.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        if block.get("path").and_then(Value::as_str).is_some() {
            continue; // 已是 path 引用
        }
        let Some(data) = block.get("data").and_then(Value::as_str) else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        let mime_type = block
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("image/png")
            .to_string();

        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.trim()) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }

        let file_name = format!(
            "img-{}-{}.{}",
            chrono::Local::now().format("%Y%m%d%H%M%S"),
            database::create_snowflake_id(),
            ext_for_mime(&mime_type)
        );
        let abs_path = target_dir.join(&file_name);
        if let Err(error) = fs::write(&abs_path, &bytes) {
            // 落盘失败：保留 base64 块，不阻断生成结果返回
            eprintln!(
                "[image-library] failed to persist image '{}': {error}",
                abs_path.display()
            );
            continue;
        }

        let relative_path = format!("image/{date_dir}/{file_name}");
        let (width, height) = probe_dimensions(&bytes, &mime_type);

        let insert_result = database::open_connection(database_path).and_then(|connection| {
            connection.execute(
                "INSERT INTO image_library (
                   id, relative_path, file_name, mime_type, size_bytes, width, height,
                   prompt, model, provider
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    database::create_snowflake_id(),
                    relative_path,
                    file_name,
                    mime_type,
                    bytes.len() as i64,
                    width,
                    height,
                    prompt,
                    model,
                    provider,
                ],
            )
        });
        if let Err(error) = insert_result {
            // 索引失败不影响展示（消息里 path 仍可读），仅记录
            eprintln!("[image-library] failed to index image '{relative_path}': {error}");
        }

        // 改写块：去掉 base64，保留 path 引用
        let mut rewritten = serde_json::Map::new();
        rewritten.insert("type".to_string(), Value::String("image".to_string()));
        rewritten.insert("path".to_string(), Value::String(relative_path.clone()));
        rewritten.insert("mimeType".to_string(), Value::String(mime_type));
        *block = Value::Object(rewritten);
        stored.push(relative_path);
    }
    Ok(stored)
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImageLibraryRecord> {
    Ok(ImageLibraryRecord {
        id: row.get(0)?,
        relative_path: row.get(1)?,
        file_name: row.get(2)?,
        mime_type: row.get(3)?,
        size_bytes: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        prompt: row.get(7)?,
        model: row.get(8)?,
        provider: row.get(9)?,
        created_at: row.get(10)?,
    })
}

/// 列出全部图片（按创建时间倒序）。
pub fn list_images(database_path: &Path) -> Result<Vec<ImageLibraryRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, relative_path, file_name, mime_type, size_bytes, width, height,
                        prompt, model, provider, created_at
                   FROM image_library
                  ORDER BY created_at DESC, id DESC",
            )?;
            let rows = statement.query_map([], map_row)?;
            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list image library", error))
}

/// 将图库相对路径（image/...）解析为根目录下的绝对路径。
/// 根目录本身即 image 目录，物理文件直接位于根目录下（persist 时
/// 按 `root/日期/文件名` 落盘），因此 `image/` 仅是逻辑前缀，需先去掉再拼接。
fn library_file_path(root: &Path, relative_path: &str) -> PathBuf {
    let normalized = relative_path.trim().replace('\\', "/");
    let inner = normalized.strip_prefix("image/").unwrap_or(&normalized);
    root.join(inner)
}

/// 读取图库文件并返回 data URL（白名单校验：仅 image/ 前缀 + 防穿越）。
pub fn read_image_file(relative_path: &str) -> Result<Option<String>> {
    let normalized = relative_path.trim().replace('\\', "/");
    if !normalized.starts_with("image/") || normalized.contains("..") {
        return Ok(None);
    }
    let root = image_library_root()?;
    let file_path = library_file_path(&root, &normalized);
    // 二次校验：绝对路径必须落在 image 根目录内
    let Ok(canonical_root) = root.canonicalize() else {
        return Ok(None);
    };
    let Ok(canonical_file) = file_path.canonicalize() else {
        return Ok(None);
    };
    if !canonical_file.starts_with(&canonical_root) {
        return Ok(None);
    }
    let Ok(bytes) = fs::read(&canonical_file) else {
        return Ok(None);
    };
    let mime_type = match file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    Ok(Some(format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    )))
}

/// 删除图片：事务内先重写引用该图片的会话消息，再删除索引行；
/// 最后物理删除文件。任一步失败则回滚（不留下半删状态）。
pub fn delete_image(database_path: &Path, id: &str) -> Result<()> {
    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open for image delete", error))?;

    let tx = connection
        .transaction()
        .map_err(|error| database::database_error(database_path, "begin image delete tx", error))?;

    let record: Option<(String, String)> = tx
        .query_row(
            "SELECT relative_path, file_name FROM image_library WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| database::database_error(database_path, "query image record", error))?;

    let Some((relative_path, _file_name)) = record else {
        return Ok(()); // 不存在视为已删除
    };

    // 1) 重写引用该图的会话消息（content + raw_json）
    let rewritten = rewrite_messages_referencing(&tx, &relative_path)
        .map_err(|error| database::database_error(database_path, "rewrite messages for image", error))?;

    // 2) 删除索引行
    tx.execute("DELETE FROM image_library WHERE id = ?1", params![id])
        .map_err(|error| database::database_error(database_path, "delete image index", error))?;

    tx.commit()
        .map_err(|error| database::database_error(database_path, "commit image delete", error))?;

    // 3) 物理删除文件（索引已删，失败仅产生孤儿文件，不阻断）
    let root = image_library_root()?;
    let file_path = library_file_path(&root, &relative_path);
    if let Ok(canonical_root) = root.canonicalize() {
        if let Ok(canonical_file) = file_path.canonicalize() {
            if canonical_file.starts_with(&canonical_root) {
                let _ = fs::remove_file(&canonical_file);
            }
        }
    }

    if rewritten > 0 {
        eprintln!("[image-library] deleted '{relative_path}', rewrote {rewritten} message(s)");
    }
    Ok(())
}

/// 扫描并重写所有引用 `relative_path` 的消息。
/// 返回受影响的消息条数。
fn rewrite_messages_referencing(
    tx: &rusqlite::Transaction<'_>,
    relative_path: &str,
) -> rusqlite::Result<usize> {
    let pattern = format!("%{relative_path}%");
    let mut statement = tx.prepare(
        "SELECT message_id, content, raw_json FROM chat_messages
          WHERE content LIKE ?1 OR raw_json LIKE ?1",
    )?;
    let rows: Vec<(String, String, Option<String>)> = statement
        .query_map(params![pattern], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut updated = 0usize;
    for (message_id, content, raw_json) in rows {
        let new_content = strip_image_ref_from_content(&content, relative_path);
        let new_raw_json = raw_json
            .as_deref()
            .map(|raw| strip_image_ref_from_raw_json(raw, relative_path));

        let content_changed = new_content != content;
        let raw_changed = match (&raw_json, &new_raw_json) {
            (Some(old), Some(new)) => new != old,
            (Some(_), None) => true,
            (None, None) => false,
            (None, Some(_)) => true,
        };
        if !content_changed && !raw_changed {
            continue;
        }

        match new_raw_json {
            Some(new_raw) => {
                tx.execute(
                    "UPDATE chat_messages SET content = ?1, raw_json = ?2 WHERE message_id = ?3",
                    params![new_content, new_raw, message_id],
                )?;
            }
            None => {
                tx.execute(
                    "UPDATE chat_messages SET content = ?1, raw_json = NULL WHERE message_id = ?2",
                    params![new_content, message_id],
                )?;
            }
        }
        updated += 1;
    }
    Ok(updated)
}

/// 从文本中提取所有图库相对路径引用：
/// - JSON 字段 `"path":"image/..."`（生成结果 content 块）
/// - 历史标签 `@@image:image/...@@`
fn extract_image_paths(text: &str, paths: &mut Vec<String>) {
    let json_path = regex::Regex::new(r#""path"\s*:\s*"(image/[^"]+)""#).unwrap();
    let tag = regex::Regex::new(r"@@image:(image/[^@]+)@@").unwrap();
    for capture in json_path.captures_iter(text) {
        if let Some(value) = capture.get(1) {
            let path = value.as_str().to_string();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    for capture in tag.captures_iter(text) {
        if let Some(value) = capture.get(1) {
            let path = value.as_str().to_string();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
}

/// 收集指定会话中引用的图库图片路径（去重）。
fn collect_paths_for_conversations(
    connection: &rusqlite::Connection,
    conversation_ids: &[String],
) -> rusqlite::Result<Vec<String>> {
    let mut paths: Vec<String> = Vec::new();
    for conversation_id in conversation_ids {
        let mut statement = connection.prepare(
            "SELECT content, raw_json FROM chat_messages WHERE conversation_id = ?1",
        )?;
        let rows = statement.query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        for row in rows {
            let (content, raw_json) = row?;
            extract_image_paths(&content, &mut paths);
            if let Some(raw) = raw_json {
                extract_image_paths(&raw, &mut paths);
            }
        }
    }
    Ok(paths)
}

/// 统计指定会话中引用的图库图片数量（去重后按索引存在性计数）。
pub fn count_conversation_images(
    database_path: &Path,
    conversation_ids: &[String],
) -> Result<i64> {
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open for image count", error))?;
    let paths = collect_paths_for_conversations(&connection, conversation_ids)
        .map_err(|error| database::database_error(database_path, "scan conversation images", error))?;
    let mut count = 0i64;
    for path in &paths {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM image_library WHERE relative_path = ?1)",
                params![path],
                |row| row.get(0),
            )
            .map_err(|error| database::database_error(database_path, "check image index", error))?;
        if exists {
            count += 1;
        }
    }
    Ok(count)
}

/// 级联删除指定会话中引用的图库图片（物理文件 + 索引行）。
/// 会话本身即将被删除，无需重写消息。返回删除的图片数量。
pub fn delete_conversation_images(
    database_path: &Path,
    conversation_ids: &[String],
) -> Result<i64> {
    let mut connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "open for image cascade", error))?;
    let paths = collect_paths_for_conversations(&connection, conversation_ids)
        .map_err(|error| database::database_error(database_path, "scan conversation images", error))?;

    let tx = connection
        .transaction()
        .map_err(|error| database::database_error(database_path, "begin image cascade tx", error))?;

    let mut removed_files: Vec<String> = Vec::new();
    for path in &paths {
        let file_name: Option<String> = tx
            .query_row(
                "SELECT file_name FROM image_library WHERE relative_path = ?1",
                params![path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| database::database_error(database_path, "query image record", error))?;
        if file_name.is_none() {
            continue;
        }
        tx.execute("DELETE FROM image_library WHERE relative_path = ?1", params![path])
            .map_err(|error| database::database_error(database_path, "delete image index", error))?;
        removed_files.push(path.clone());
    }

    tx.commit()
        .map_err(|error| database::database_error(database_path, "commit image cascade", error))?;

    // 物理删除文件（失败仅产生孤儿文件，不阻断会话删除）
    let root = image_library_root()?;
    for path in &removed_files {
        let file_path = library_file_path(&root, path);
        if let Ok(canonical_root) = root.canonicalize() {
            if let Ok(canonical_file) = file_path.canonicalize() {
                if canonical_file.starts_with(&canonical_root) {
                    let _ = fs::remove_file(&canonical_file);
                }
            }
        }
    }

    if !removed_files.is_empty() {
        eprintln!(
            "[image-library] cascade deleted {} image(s) for {} conversation(s)",
            removed_files.len(),
            conversation_ids.len()
        );
    }
    Ok(removed_files.len() as i64)
}

/// 从消息 content（`[Tool: name#callId]\n<result JSON>` 分段格式）中移除
/// 指定 path 的图片块，并清理残留的 `@@image:<path>@@` 标签。
fn strip_image_ref_from_content(content: &str, relative_path: &str) -> String {
    let mut result = String::new();
    let mut rest = content;

    while let Some(idx) = rest.find("[Tool: ") {
        result.push_str(&rest[..idx]);
        let after = &rest[idx..];
        let Some(nl) = after.find('\n') else {
            result.push_str(after);
            rest = "";
            break;
        };
        result.push_str(&after[..=nl]);
        let body = &after[nl + 1..];
        let next = body.find("\n[Tool: ");
        let (json_part, tail) = match next {
            Some(i) => (&body[..i], &body[i..]),
            None => (body, ""),
        };

        let trimmed = json_part.trim_end();
        let rewritten = serde_json::from_str::<Value>(trimmed)
            .ok()
            .map(|mut value| {
                if let Some(blocks) = value.get_mut("content").and_then(Value::as_array_mut) {
                    blocks.retain(|block| {
                        !(block.get("type").and_then(Value::as_str) == Some("image")
                            && block.get("path").and_then(Value::as_str) == Some(relative_path))
                    });
                }
                serde_json::to_string(&value).unwrap_or_else(|_| trimmed.to_string())
            })
            .unwrap_or_else(|| trimmed.to_string());

        result.push_str(&rewritten);
        rest = tail;
    }
    result.push_str(rest);

    // 清理历史残留的标签形式引用
    result.replace(&format!("@@image:{relative_path}@@"), "")
}

/// 从消息 raw_json（`[{name, callId, result}]` 格式）中移除指定 path 的图片块。
fn strip_image_ref_from_raw_json(raw_json: &str, relative_path: &str) -> String {
    let Ok(mut array) = serde_json::from_str::<Value>(raw_json) else {
        return raw_json.replace(&format!("@@image:{relative_path}@@"), "");
    };
    if let Some(items) = array.as_array_mut() {
        for item in items.iter_mut() {
            let Some(result_str) = item.get("result").and_then(Value::as_str) else {
                continue;
            };
            let Some(mut result_value) = serde_json::from_str::<Value>(result_str).ok() else {
                continue;
            };
            let mut changed = false;
            if let Some(blocks) = result_value
                .get_mut("content")
                .and_then(Value::as_array_mut)
            {
                let before = blocks.len();
                blocks.retain(|block| {
                    !(block.get("type").and_then(Value::as_str) == Some("image")
                        && block.get("path").and_then(Value::as_str) == Some(relative_path))
                });
                changed = blocks.len() != before;
            }
            if changed {
                if let Ok(new_result) = serde_json::to_string(&result_value) {
                    item["result"] = Value::String(new_result);
                }
            }
        }
    }
    serde_json::to_string(&array).unwrap_or_else(|_| raw_json.to_string())
}
