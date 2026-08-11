use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection};

use super::super::database;
use super::super::{ApiConfigInput, ApiConfigRecord};

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
                        partial_retry_max_chars,
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
                let partial_retry_max_chars: Option<i64> = row.get(23)?;

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
                    partial_retry_max_chars: partial_retry_max_chars.map(|v| v as i32),
                    system_prompt_ids_json: row.get(24)?,
                    custom_header_scheme_id: row.get(25)?,
                    config_json: row.get(26)?,
                    source: row.get(27)?,
                    updated_at: row.get(28)?,
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
                   partial_retry_max_chars,
                   system_prompt_ids_json,
                   custom_header_scheme_id,
                   config_json,
                   source,
                   created_at,
                   updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                   ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                   ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28,
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
                   partial_retry_max_chars = excluded.partial_retry_max_chars,
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
                    config.partial_retry_max_chars.unwrap_or(1000),
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

            ensure_one_active_config(&transaction)?;

            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "delete API config", error))
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

    // 表为空（删除了最后一个档案）时自动 seed 一个默认档案，
    // 保证始终存在一个 active 档案（与 UI 交互契约一致）。
    connection.execute(
        "INSERT INTO api_configs (id, profile_name, display_name, is_active)
         SELECT ?1, 'default', 'default', 1
          WHERE NOT EXISTS (SELECT 1 FROM api_configs)",
        params![database::create_snowflake_id()],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::database;
    use super::super::super::{ApiConfigInput, ApiConfigRecord};
    use super::{delete_api_config, list_api_configs, upsert_api_config};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path() -> PathBuf {
        let unique = format!(
            "snow-app-test-api-configs-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        );
        std::env::temp_dir().join(unique)
    }

    fn init_db(path: &Path) {
        let connection = database::open_connection(path).expect("open database");
        database::create_schema(&connection).expect("create schema");
    }

    fn make_input(
        profile_name: &str,
        is_active: bool,
        api_key: &str,
    ) -> ApiConfigInput {
        ApiConfigInput {
            profile_name: profile_name.to_string(),
            display_name: profile_name.to_string(),
            is_active,
            base_url: "https://api.example.com/v1".to_string(),
            base_url_mode: "auto".to_string(),
            api_key: api_key.to_string(),
            request_method: "chat".to_string(),
            advanced_model: "model-a".to_string(),
            basic_model: "model-b".to_string(),
            supports_vision: true,
            vision_base_url: String::new(),
            vision_base_url_mode: "auto".to_string(),
            vision_api_key: String::new(),
            vision_request_method: "chat".to_string(),
            vision_model: String::new(),
            max_context_tokens: Some(256000),
            max_tokens: Some(64000),
            stream_idle_timeout_sec: Some(180),
            enable_auto_compress: true,
            auto_compress_threshold: Some(80),
            max_retries: Some(5),
            retry_base_delay_ms: Some(3000),
            partial_retry_max_chars: Some(1000),
            system_prompt_ids_json: String::new(),
            custom_header_scheme_id: String::new(),
            config_json: format!(
                r#"{{"snowcfg":{{"baseUrl":"https://api.example.com/v1","apiKey":"{api_key}"}}}}"#
            ),
            source: "manual".to_string(),
        }
    }

    fn find_by_name<'a>(records: &'a [ApiConfigRecord], profile_name: &str) -> &'a ApiConfigRecord {
        records
            .iter()
            .find(|record| record.profile_name == profile_name)
            .unwrap_or_else(|| panic!("profile not found: {profile_name}"))
    }

    fn active_count(records: &[ApiConfigRecord]) -> usize {
        records.iter().filter(|record| record.is_active).count()
    }

    #[test]
    fn upsert_with_empty_api_key_keeps_existing_key() {
        let db_path = temp_db_path();
        init_db(&db_path);

        upsert_api_config(&db_path, &make_input("test", true, "sk-old-key-1234"))
            .expect("create profile");
        // 空密钥 upsert：必须保留旧密钥（无密钥档案后补密钥/改字段不丢密钥）。
        let mut update = make_input("test", true, "");
        update.advanced_model = "model-new".to_string();
        upsert_api_config(&db_path, &update).expect("update profile");

        let records = list_api_configs(&db_path).expect("list profiles");
        let profile = find_by_name(&records, "test");
        assert_eq!(profile.api_key, "sk-old-key-1234");
        assert_eq!(profile.advanced_model, "model-new");

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn new_keyless_profile_has_empty_api_key() {
        let db_path = temp_db_path();
        init_db(&db_path);

        upsert_api_config(&db_path, &make_input("keyless", true, "")).expect("create keyless");

        let records = list_api_configs(&db_path).expect("list profiles");
        let profile = find_by_name(&records, "keyless");
        assert_eq!(profile.api_key, "");
        assert!(profile.is_active);

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn switching_active_profile_keeps_single_active() {
        let db_path = temp_db_path();
        init_db(&db_path);

        upsert_api_config(&db_path, &make_input("a", true, "sk-a")).expect("create a");
        upsert_api_config(&db_path, &make_input("b", true, "sk-b")).expect("create b");

        let records = list_api_configs(&db_path).expect("list profiles");
        assert_eq!(active_count(&records), 1);
        assert!(!find_by_name(&records, "a").is_active);
        assert!(find_by_name(&records, "b").is_active);

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn delete_last_profile_seeds_default_active() {
        let db_path = temp_db_path();
        init_db(&db_path);

        upsert_api_config(&db_path, &make_input("only", true, "sk-only")).expect("create only");
        delete_api_config(&db_path, "only").expect("delete profile");

        let records = list_api_configs(&db_path).expect("list profiles");
        assert_eq!(active_count(&records), 1);
        let default = find_by_name(&records, "default");
        assert!(default.is_active);
        assert_eq!(default.profile_name, "default");

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn delete_active_profile_promotes_another() {
        let db_path = temp_db_path();
        init_db(&db_path);

        upsert_api_config(&db_path, &make_input("a", true, "sk-a")).expect("create a");
        upsert_api_config(&db_path, &make_input("b", false, "sk-b")).expect("create b");
        delete_api_config(&db_path, "a").expect("delete active a");

        let records = list_api_configs(&db_path).expect("list profiles");
        assert_eq!(active_count(&records), 1);
        assert!(find_by_name(&records, "b").is_active);

        let _ = std::fs::remove_file(&db_path);
    }
}
