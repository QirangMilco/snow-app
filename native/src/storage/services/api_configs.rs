use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};

use super::super::database;
use super::super::{ApiConfigInput, ApiConfigRecord};

const DEFAULT_PROFILE_NAME: &str = "default";
const DEFAULT_DISPLAY_NAME: &str = "Default API";
const DEFAULT_BASE_URL: &str = "https://api.deepseek.com/v1";
const DEFAULT_REQUEST_METHOD: &str = "chat";
const DEFAULT_ADVANCED_MODEL: &str = "deepseek-v4-pro";
const DEFAULT_BASIC_MODEL: &str = "deepseek-v4-flash";
const DEFAULT_MAX_CONTEXT_TOKENS: i32 = 256000;
const DEFAULT_CONFIG_JSON: &str = "{\"snowcfg\":{\"baseUrl\":\"https://api.deepseek.com/v1\",\"baseUrlMode\":\"auto\",\"requestMethod\":\"chat\",\"advancedModel\":\"deepseek-v4-pro\",\"basicModel\":\"deepseek-v4-flash\",\"supportsVision\":false,\"chatThinking\":{\"enabled\":true,\"reasoning_effort\":\"high\"},\"responsesReasoning\":{\"enabled\":true,\"effort\":\"high\"},\"geminiThinking\":{\"enabled\":true,\"thinkingLevel\":\"high\"},\"thinking\":{\"enabled\":true,\"effort\":\"high\"}}}";

pub fn seed_default_api_config(database_path: &Path) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|connection| seed_default_api_config_with_connection(&connection))
        .map_err(|error| database::database_error(database_path, "seed default API config", error))
}

pub fn list_api_configs(database_path: &Path) -> Result<Vec<ApiConfigRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,
                        profile_name,
                        display_name,
                        is_active,
                        base_url,
                        base_url_mode,
                        api_key,
                        request_method,
                        advanced_model,
                        basic_model,
                        supports_vision,
                        vision_base_url,
                        vision_base_url_mode,
                        vision_api_key,
                        vision_request_method,
                        vision_model,
                        max_context_tokens,
                        max_tokens,
                        stream_idle_timeout_sec,
                        enable_auto_compress,
                        auto_compress_threshold,
                        max_retries,
                        retry_base_delay_ms,
                        system_prompt_ids_json,
                        custom_header_scheme_id,
                        config_json,
                        source,
                        updated_at
                   FROM api_configs
                  ORDER BY is_active DESC, display_name COLLATE NOCASE ASC",
            )?;

            let rows = statement.query_map([], |row| {
                let is_active: i64 = row.get(3)?;
                let supports_vision: i64 = row.get(10)?;
                let enable_auto_compress: i64 = row.get(19)?;
                let max_retries: Option<i64> = row.get(21)?;
                let retry_base_delay_ms: Option<i64> = row.get(22)?;

                Ok(ApiConfigRecord {
                    id: row.get(0)?,
                    profile_name: row.get(1)?,
                    display_name: row.get(2)?,
                    is_active: is_active != 0,
                    base_url: row.get(4)?,
                    base_url_mode: row.get(5)?,
                    api_key: row.get(6)?,
                    request_method: row.get(7)?,
                    advanced_model: row.get(8)?,
                    basic_model: row.get(9)?,
                    supports_vision: supports_vision != 0,
                    vision_base_url: row.get(11)?,
                    vision_base_url_mode: row.get(12)?,
                    vision_api_key: row.get(13)?,
                    vision_request_method: row.get(14)?,
                    vision_model: row.get(15)?,
                    max_context_tokens: row.get(16)?,
                    max_tokens: row.get(17)?,
                    stream_idle_timeout_sec: row.get(18)?,
                    enable_auto_compress: enable_auto_compress != 0,
                    auto_compress_threshold: row.get(20)?,
                    max_retries: max_retries.map(|v| v as i32),
                    retry_base_delay_ms: retry_base_delay_ms.map(|v| v as i32),
                    system_prompt_ids_json: row.get(23)?,
                    custom_header_scheme_id: row.get(24)?,
                    config_json: row.get(25)?,
                    source: row.get(26)?,
                    updated_at: row.get(27)?,
                })
            })?;

            rows.collect()
        })
        .map_err(|error| database::database_error(database_path, "list API configs", error))
}

pub fn upsert_api_config(database_path: &Path, config: &ApiConfigInput) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;

            if config.is_active {
                transaction.execute(
                    "UPDATE api_configs
                        SET is_active = 0,
                            updated_at = datetime('now', 'localtime')
                      WHERE is_active = 1",
                    [],
                )?;
            }

            transaction.execute(
                "INSERT INTO api_configs (
                   id,
                   profile_name,
                   display_name,
                   is_active,
                   base_url,
                   base_url_mode,
                   api_key,
                   request_method,
                   advanced_model,
                   basic_model,
                   supports_vision,
                   vision_base_url,
                   vision_base_url_mode,
                   vision_api_key,
                   vision_request_method,
                   vision_model,
                   max_context_tokens,
                   max_tokens,
                   stream_idle_timeout_sec,
                   enable_auto_compress,
                   auto_compress_threshold,
                   max_retries,
                   retry_base_delay_ms,
                   system_prompt_ids_json,
                   custom_header_scheme_id,
                   config_json,
                   source,
                   created_at,
                   updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                   ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                   ?21, ?22, ?23, ?24, ?25, ?26, ?27,
                   datetime('now', 'localtime'), datetime('now', 'localtime')
                 )
                 ON CONFLICT(profile_name) DO UPDATE SET
                   display_name = excluded.display_name,
                   is_active = excluded.is_active,
                   base_url = excluded.base_url,
                   base_url_mode = excluded.base_url_mode,
                   api_key = CASE
                     WHEN excluded.api_key = '' AND api_configs.api_key <> '' THEN api_configs.api_key
                     ELSE excluded.api_key
                   END,
                   request_method = excluded.request_method,
                   advanced_model = excluded.advanced_model,
                   basic_model = excluded.basic_model,
                   supports_vision = excluded.supports_vision,
                   vision_base_url = excluded.vision_base_url,
                   vision_base_url_mode = excluded.vision_base_url_mode,
                   vision_api_key = CASE
                     WHEN excluded.vision_api_key = '' AND api_configs.vision_api_key <> '' THEN api_configs.vision_api_key
                     ELSE excluded.vision_api_key
                   END,
                   vision_request_method = excluded.vision_request_method,
                   vision_model = excluded.vision_model,
                   max_context_tokens = excluded.max_context_tokens,
                   max_tokens = excluded.max_tokens,
                   stream_idle_timeout_sec = excluded.stream_idle_timeout_sec,
                   enable_auto_compress = excluded.enable_auto_compress,
                   auto_compress_threshold = excluded.auto_compress_threshold,
                   max_retries = excluded.max_retries,
                   retry_base_delay_ms = excluded.retry_base_delay_ms,
                   system_prompt_ids_json = excluded.system_prompt_ids_json,
                   custom_header_scheme_id = excluded.custom_header_scheme_id,
                   config_json = excluded.config_json,
                   source = excluded.source,
                   updated_at = datetime('now', 'localtime')",
                params![
                    database::create_snowflake_id(),
                    config.profile_name,
                    config.display_name,
                    config.is_active as i32,
                    config.base_url,
                    config.base_url_mode,
                    config.api_key,
                    config.request_method,
                    config.advanced_model,
                    config.basic_model,
                    config.supports_vision as i32,
                    config.vision_base_url,
                    config.vision_base_url_mode,
                    config.vision_api_key,
                    config.vision_request_method,
                    config.vision_model,
                    config.max_context_tokens,
                    config.max_tokens,
                    config.stream_idle_timeout_sec,
                    config.enable_auto_compress as i32,
                    config.auto_compress_threshold,
                    config.max_retries.unwrap_or(5),
                    config.retry_base_delay_ms.unwrap_or(3000),
                    config.system_prompt_ids_json,
                    config.custom_header_scheme_id,
                    config.config_json,
                    config.source,
                ],
            )?;

            if !config.is_active {
                ensure_one_active_config(&transaction)?;
            }

            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "upsert API config", error))
}

pub fn delete_api_config(database_path: &Path, profile_name: &str) -> Result<()> {
    database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;

            transaction.execute(
                "DELETE FROM api_configs WHERE profile_name = ?1",
                [profile_name],
            )?;

            seed_default_api_config_with_connection(&transaction)?;
            ensure_one_active_config(&transaction)?;

            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "delete API config", error))
}

fn seed_default_api_config_with_connection(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO api_configs (
           id,
           profile_name,
           display_name,
           is_active,
           base_url,
           base_url_mode,
           api_key,
           request_method,
           advanced_model,
           basic_model,
           supports_vision,
           vision_base_url,
           vision_base_url_mode,
           vision_api_key,
           vision_request_method,
           vision_model,
           max_context_tokens,
           system_prompt_ids_json,
           custom_header_scheme_id,
           config_json,
           source,
           created_at,
           updated_at
         )
         SELECT
           ?1, ?2, ?3, 1, ?4, 'auto', '', ?5, ?6, ?7, 1,
           '', 'auto', '', ?5, '', ?9, '', '', ?8, 'default', datetime('now', 'localtime'), datetime('now', 'localtime')
         WHERE NOT EXISTS (SELECT 1 FROM api_configs)",
        params![
            database::create_snowflake_id(),
            DEFAULT_PROFILE_NAME,
            DEFAULT_DISPLAY_NAME,
            DEFAULT_BASE_URL,
            DEFAULT_REQUEST_METHOD,
            DEFAULT_ADVANCED_MODEL,
            DEFAULT_BASIC_MODEL,
            DEFAULT_CONFIG_JSON,
            DEFAULT_MAX_CONTEXT_TOKENS,
        ],
    )?;

    ensure_one_active_config(connection)
}

fn ensure_one_active_config(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE api_configs
            SET is_active = 1,
                updated_at = datetime('now', 'localtime')
          WHERE id = (
            SELECT id
              FROM api_configs
             ORDER BY updated_at DESC, display_name COLLATE NOCASE ASC
             LIMIT 1
          )
            AND NOT EXISTS (
              SELECT 1
                FROM api_configs
               WHERE is_active = 1
            )",
        [],
    )?;

    Ok(())
}

