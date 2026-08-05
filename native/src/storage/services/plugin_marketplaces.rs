use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::params;

use super::super::database;
use super::super::{PluginMarketplaceInput, PluginMarketplaceRecord};

pub fn list_plugin_marketplaces(database_path: &Path) -> Result<Vec<PluginMarketplaceRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT marketplace_id, name, display_name, description, source_type, source_path,
                        ref_name, cache_path, manifest_path, content_hash, added_at, updated_at
                   FROM plugin_marketplaces ORDER BY updated_at DESC, marketplace_id ASC",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok(PluginMarketplaceRecord {
                        marketplace_id: row.get(0)?,
                        name: row.get(1)?,
                        display_name: row.get(2)?,
                        description: row.get(3)?,
                        source_type: row.get(4)?,
                        source_path: row.get(5)?,
                        ref_name: row.get(6)?,
                        cache_path: row.get(7)?,
                        manifest_path: row.get(8)?,
                        content_hash: row.get(9)?,
                        added_at: row.get(10)?,
                        updated_at: row.get(11)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>();
            rows
        })
        .map_err(|error| database::database_error(database_path, "list plugin marketplaces", error))
}

pub fn upsert_plugin_marketplace(
    database_path: &Path,
    item: &PluginMarketplaceInput,
) -> Result<()> {
    validate_marketplace(item).map_err(Error::from_reason)?;
    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO plugin_marketplaces (
                   marketplace_id, name, display_name, description, source_type, source_path,
                   ref_name, cache_path, manifest_path, content_hash
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(marketplace_id) DO UPDATE SET
                   name = excluded.name,
                   display_name = excluded.display_name,
                   description = excluded.description,
                   source_type = excluded.source_type,
                   source_path = excluded.source_path,
                   ref_name = excluded.ref_name,
                   cache_path = excluded.cache_path,
                   manifest_path = excluded.manifest_path,
                   content_hash = excluded.content_hash,
                   updated_at = datetime('now', 'localtime')",
                params![
                    item.marketplace_id,
                    item.name,
                    item.display_name,
                    item.description,
                    item.source_type,
                    item.source_path,
                    item.ref_name,
                    item.cache_path,
                    item.manifest_path,
                    item.content_hash,
                ],
            )?;
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "upsert plugin marketplace", error)
        })
}

pub fn delete_plugin_marketplace(database_path: &Path, marketplace_id: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let deleted = connection.execute(
                "DELETE FROM plugin_marketplaces WHERE marketplace_id = ?1",
                [marketplace_id],
            )?;
            if deleted == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            Ok(())
        })
        .map_err(|error| {
            database::database_error(database_path, "delete plugin marketplace", error)
        })
}

fn validate_marketplace(item: &PluginMarketplaceInput) -> std::result::Result<(), String> {
    if item.marketplace_id.trim().is_empty()
        || item.name.trim().is_empty()
        || item.display_name.trim().is_empty()
        || item.source_path.trim().is_empty()
        || item.manifest_path.trim().is_empty()
        || item.content_hash.trim().is_empty()
    {
        return Err("Plugin marketplace identity and source fields are required".to_string());
    }
    if !matches!(
        item.source_type.as_str(),
        "local" | "github" | "git" | "url"
    ) {
        return Err("Plugin marketplace source type is invalid".to_string());
    }
    Ok(())
}
