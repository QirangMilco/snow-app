use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::super::database;
use super::super::{
    ImportResourceInput, ImportResourceRecord, ImportResourceRelease, ImportResourceReleaseInput,
    ImportResourceSourceInput, ImportResourceSourceRecord,
};

pub fn list_import_resources(database_path: &Path) -> Result<Vec<ImportResourceRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_resources(&connection))
        .map_err(|error| database::database_error(database_path, "list import resources", error))
}

pub fn upsert_import_resources(database_path: &Path, items: &[ImportResourceInput]) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            for item in items {
                upsert_resource(&transaction, item)?;
            }
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "upsert import resources", error))
}

pub fn release_import_resource(
    database_path: &Path,
    input: &ImportResourceReleaseInput,
) -> Result<ImportResourceRelease> {
    let disposition = input.disposition.trim();
    if disposition != "delete" && disposition != "adopt" {
        return Err(Error::from_reason(
            "Import resource disposition must be delete or adopt",
        ));
    }

    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            let Some(resource) = query_resource(&transaction, &input.resource_id)? else {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            };
            if !resource
                .sources
                .iter()
                .any(|source| source.source_id == input.source_id)
            {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            if disposition == "adopt" {
                transaction.execute(
                    "DELETE FROM import_resource_sources WHERE resource_id = ?1",
                    [&input.resource_id],
                )?;
            } else {
                transaction.execute(
                    "DELETE FROM import_resource_sources WHERE source_id = ?1 AND resource_id = ?2",
                    params![input.source_id, input.resource_id],
                )?;
            }
            let remaining: i32 = transaction.query_row(
                "SELECT COUNT(*) FROM import_resource_sources WHERE resource_id = ?1",
                [&input.resource_id],
                |row| row.get(0),
            )?;
            if remaining == 0 {
                transaction.execute(
                    "DELETE FROM import_resources WHERE resource_id = ?1",
                    [&input.resource_id],
                )?;
            }
            transaction.commit()?;

            Ok(ImportResourceRelease {
                cleanup_target: remaining == 0
                    && disposition == "delete"
                    && resource.management == "snapshot",
                resource,
                remaining_source_count: remaining,
            })
        })
        .map_err(|error| database::database_error(database_path, "release import resource", error))
}

pub(crate) fn delete_mcp_tracking_for_target(
    transaction: &Transaction<'_>,
    scope: &str,
    project_id: Option<&str>,
    target_id: &str,
) -> rusqlite::Result<()> {
    transaction.execute(
        "DELETE FROM import_resources
          WHERE resource_type = 'mcp'
            AND scope = ?1
            AND project_id IS ?2
            AND target_id = ?3",
        params![scope, project_id, target_id],
    )?;
    Ok(())
}

pub(crate) fn delete_prompt_tracking_for_target(
    transaction: &Transaction<'_>,
    target_id: &str,
) -> rusqlite::Result<()> {
    transaction.execute(
        "DELETE FROM import_resources
          WHERE resource_type IN ('prompt', 'command', 'agent')
            AND target_id = ?1",
        [target_id],
    )?;
    Ok(())
}

pub(crate) fn upsert_resource(
    transaction: &Transaction<'_>,
    item: &ImportResourceInput,
) -> rusqlite::Result<()> {
    validate_resource(item).map_err(|message| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            message,
        )))
    })?;
    transaction.execute(
        "INSERT INTO import_resources (
           resource_id, resource_type, scope, project_id, target_id, target_path, management, created_at, updated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now', 'localtime'), datetime('now', 'localtime')
         ) ON CONFLICT(resource_id) DO UPDATE SET
           resource_type = excluded.resource_type,
           scope = excluded.scope,
           project_id = excluded.project_id,
           target_id = excluded.target_id,
           target_path = excluded.target_path,
           management = excluded.management,
           updated_at = datetime('now', 'localtime')",
        params![
            item.resource_id,
            item.resource_type,
            item.scope,
            item.project_id,
            item.target_id,
            item.target_path,
            item.management,
        ],
    )?;
    transaction.execute(
        "DELETE FROM import_resource_sources WHERE resource_id = ?1",
        [&item.resource_id],
    )?;
    for source in &item.sources {
        insert_source(transaction, &item.resource_id, source)?;
    }
    Ok(())
}

fn validate_resource(item: &ImportResourceInput) -> std::result::Result<(), String> {
    if item.resource_id.trim().is_empty()
        || item.resource_type.trim().is_empty()
        || item.target_id.trim().is_empty()
    {
        return Err("Import resource id, type and target are required".to_string());
    }
    if item.scope != "global" && item.scope != "project" {
        return Err("Import resource scope must be global or project".to_string());
    }
    if item.management != "snapshot"
        && item.management != "reference"
        && item.management != "user-adopted"
    {
        return Err("Import resource management is invalid".to_string());
    }
    if item.sources.is_empty() {
        return Err("Import resource needs at least one source".to_string());
    }
    Ok(())
}

fn insert_source(
    transaction: &Transaction<'_>,
    resource_id: &str,
    source: &ImportResourceSourceInput,
) -> rusqlite::Result<()> {
    if source.provider.trim().is_empty()
        || source.origin_path.trim().is_empty()
        || source.content_hash.trim().is_empty()
    {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Import resource source is incomplete",
            ),
        )));
    }
    let source_id = source_id(resource_id, source);
    transaction.execute(
        "INSERT INTO import_resource_sources (
           source_id, resource_id, provider, scope, origin_path, project_id, imported_hash, current_hash, last_scanned_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, datetime('now', 'localtime'))",
        params![
            source_id,
            resource_id,
            source.provider,
            source.scope,
            source.origin_path,
            source.project_id,
            source.content_hash,
        ],
    )?;
    Ok(())
}

fn source_id(resource_id: &str, source: &ImportResourceSourceInput) -> String {
    let project_id = source.project_id.as_deref().unwrap_or("");
    format!(
        "import-source:{}",
        blake3::hash(
            format!(
                "{resource_id}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{project_id}",
                source.provider, source.scope, source.origin_path
            )
            .as_bytes()
        )
        .to_hex()
    )
}

fn query_resources(connection: &Connection) -> rusqlite::Result<Vec<ImportResourceRecord>> {
    let mut statement = connection.prepare(
        "SELECT resource_id, resource_type, scope, project_id, target_id, target_path, management, updated_at
           FROM import_resources
          ORDER BY updated_at DESC, resource_id ASC",
    )?;
    let resource_ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    resource_ids
        .iter()
        .map(|resource_id| {
            query_resource(connection, resource_id)
                .and_then(|record| record.ok_or(rusqlite::Error::QueryReturnedNoRows))
        })
        .collect()
}

fn query_resource(
    connection: &Connection,
    resource_id: &str,
) -> rusqlite::Result<Option<ImportResourceRecord>> {
    let row = connection
        .query_row(
            "SELECT resource_id, resource_type, scope, project_id, target_id, target_path, management, updated_at
               FROM import_resources
              WHERE resource_id = ?1",
            [resource_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((
        resource_id,
        resource_type,
        scope,
        project_id,
        target_id,
        target_path,
        management,
        updated_at,
    )) = row
    else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT source_id, provider, scope, origin_path, project_id, imported_hash, current_hash, last_scanned_at
           FROM import_resource_sources
          WHERE resource_id = ?1
          ORDER BY provider ASC, origin_path ASC",
    )?;
    let sources = statement
        .query_map([&resource_id], |row| {
            Ok(ImportResourceSourceRecord {
                source_id: row.get(0)?,
                provider: row.get(1)?,
                scope: row.get(2)?,
                origin_path: row.get(3)?,
                project_id: row.get(4)?,
                imported_hash: row.get(5)?,
                current_hash: row.get(6)?,
                last_scanned_at: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(ImportResourceRecord {
        resource_id,
        resource_type,
        scope,
        project_id,
        target_id,
        target_path,
        management,
        source_count: sources.len() as i32,
        sources,
        updated_at,
    }))
}
