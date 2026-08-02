use std::{
    path::Path,
    sync::{Mutex, OnceLock},
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use napi::bindgen_prelude::*;
use rusqlite::Connection;

use super::services;

const SNOWFLAKE_EPOCH_MS: u64 = 1_704_067_200_000;
const SNOWFLAKE_WORKER_ID_BITS: u64 = 10;
const SNOWFLAKE_SEQUENCE_BITS: u64 = 12;
const SNOWFLAKE_WORKER_ID_MASK: u64 = (1 << SNOWFLAKE_WORKER_ID_BITS) - 1;
const SNOWFLAKE_SEQUENCE_MASK: u64 = (1 << SNOWFLAKE_SEQUENCE_BITS) - 1;
const SNOWFLAKE_TIMESTAMP_SHIFT: u64 = SNOWFLAKE_WORKER_ID_BITS + SNOWFLAKE_SEQUENCE_BITS;

const PRIMARY_KEY_TABLES: &[&str] = &[
    "system_settings",
    "api_configs",
    "codebase_settings",
    "system_prompts",
    "custom_header_schemes",
    "workspace_directories",
    "mcp_server_configs",
    "sub_agent_configs",
    "sensitive_command_configs",
    "chat_conversations",
    "sub_agent_sessions",
    "chat_messages",
    "usage_records",
];

#[derive(Debug, Default)]
struct SnowflakeState {
    last_timestamp_ms: u64,
    sequence: u64,
}

static SNOWFLAKE_STATE: OnceLock<Mutex<SnowflakeState>> = OnceLock::new();

pub fn create_snowflake_id() -> String {
    let state_lock = SNOWFLAKE_STATE.get_or_init(|| Mutex::new(SnowflakeState::default()));
    let mut state = state_lock
        .lock()
        .expect("snowflake id generator mutex poisoned");
    let mut timestamp_ms = current_timestamp_ms().max(SNOWFLAKE_EPOCH_MS);

    if timestamp_ms < state.last_timestamp_ms {
        timestamp_ms = state.last_timestamp_ms;
    }

    if timestamp_ms == state.last_timestamp_ms {
        state.sequence = (state.sequence + 1) & SNOWFLAKE_SEQUENCE_MASK;
        if state.sequence == 0 {
            timestamp_ms = wait_next_millis(state.last_timestamp_ms);
        }
    } else {
        state.sequence = 0;
    }

    state.last_timestamp_ms = timestamp_ms;

    let worker_id = (std::process::id() as u64) & SNOWFLAKE_WORKER_ID_MASK;
    let snowflake_id = ((timestamp_ms - SNOWFLAKE_EPOCH_MS) << SNOWFLAKE_TIMESTAMP_SHIFT)
        | (worker_id << SNOWFLAKE_SEQUENCE_BITS)
        | state.sequence;

    format!("{snowflake_id:019}")
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(SNOWFLAKE_EPOCH_MS)
}

fn wait_next_millis(last_timestamp_ms: u64) -> u64 {
    loop {
        let timestamp_ms = current_timestamp_ms().max(SNOWFLAKE_EPOCH_MS);
        if timestamp_ms > last_timestamp_ms {
            return timestamp_ms;
        }
        std::hint::spin_loop();
    }
}

/// Opens a SQLite connection with WAL mode and a busy timeout to prevent
/// "database is locked" errors under concurrent access from multiple
/// `spawn_blocking` tasks.
///
/// WAL (Write-Ahead Logging) allows readers and a writer to operate
/// simultaneously, eliminating most reader-writer contention. The busy
/// timeout (5 seconds) makes writers wait instead of failing immediately
/// when another writer holds the lock.
///
/// Every service function should call this instead of `Connection::open`
/// to ensure consistent concurrency behaviour across the codebase.
pub fn open_connection(database_path: impl AsRef<Path>) -> rusqlite::Result<Connection> {
    let connection = Connection::open(database_path)?;
    // busy_timeout MUST be set before any pragma that acquires a write lock
    // (e.g. journal_mode=WAL). Otherwise concurrent connections will get
    // "database is locked" immediately instead of waiting.
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(connection)
}

pub fn ensure_database(database_path: &Path) -> Result<()> {
    open_connection(database_path)
        .and_then(|connection| create_schema(&connection))
        .map_err(|error| database_error(database_path, "initialize", error))
}

fn create_schema(connection: &Connection) -> rusqlite::Result<()> {
    reset_legacy_integer_primary_key_tables(connection)?;

    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS system_settings (
           id TEXT PRIMARY KEY NOT NULL,
           setting_name TEXT NOT NULL,
           setting_code TEXT NOT NULL UNIQUE,
           setting_value TEXT NOT NULL,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );

         CREATE TABLE IF NOT EXISTS api_configs (
           id TEXT PRIMARY KEY NOT NULL,
           profile_name TEXT NOT NULL UNIQUE,
           display_name TEXT NOT NULL,
           is_active INTEGER NOT NULL DEFAULT 0,
           base_url TEXT NOT NULL DEFAULT '',
           base_url_mode TEXT NOT NULL DEFAULT 'auto',
           api_key TEXT NOT NULL DEFAULT '',
           request_method TEXT NOT NULL DEFAULT 'chat',
           advanced_model TEXT NOT NULL DEFAULT '',
           basic_model TEXT NOT NULL DEFAULT '',
           supports_vision INTEGER NOT NULL DEFAULT 1,
           vision_base_url TEXT NOT NULL DEFAULT '',
           vision_base_url_mode TEXT NOT NULL DEFAULT 'auto',
           vision_api_key TEXT NOT NULL DEFAULT '',
           vision_request_method TEXT NOT NULL DEFAULT 'chat',
           vision_model TEXT NOT NULL DEFAULT '',
           max_context_tokens INTEGER,
           max_tokens INTEGER,
           stream_idle_timeout_sec INTEGER,
           enable_auto_compress INTEGER NOT NULL DEFAULT 1,
           auto_compress_threshold INTEGER,
           max_retries INTEGER NOT NULL DEFAULT 5,
           retry_base_delay_ms INTEGER NOT NULL DEFAULT 3000,
           system_prompt_ids_json TEXT NOT NULL DEFAULT '',
           custom_header_scheme_id TEXT NOT NULL DEFAULT '',
           config_json TEXT NOT NULL DEFAULT '{}',
           source TEXT NOT NULL DEFAULT 'manual',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );

CREATE INDEX IF NOT EXISTS idx_api_configs_active
           ON api_configs(is_active);
         CREATE INDEX IF NOT EXISTS idx_api_configs_source
           ON api_configs(source);

         CREATE TABLE IF NOT EXISTS system_prompts (
           id TEXT PRIMARY KEY NOT NULL,
           prompt_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           content TEXT NOT NULL DEFAULT '',
           is_active INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_system_prompts_active
           ON system_prompts(is_active);

         CREATE TABLE IF NOT EXISTS custom_header_schemes (
           id TEXT PRIMARY KEY NOT NULL,
           scheme_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           headers_json TEXT NOT NULL DEFAULT '{}',
           is_active INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_custom_header_schemes_active
           ON custom_header_schemes(is_active);

         CREATE TABLE IF NOT EXISTS workspace_directories (
           id TEXT PRIMARY KEY NOT NULL,
           directory_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           path TEXT NOT NULL DEFAULT '',
           kind TEXT NOT NULL DEFAULT 'local',
           is_active INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'manual',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_workspace_directories_active
           ON workspace_directories(is_active);
         CREATE INDEX IF NOT EXISTS idx_workspace_directories_kind
           ON workspace_directories(kind);

         CREATE TABLE IF NOT EXISTS mcp_server_configs (
           id TEXT PRIMARY KEY NOT NULL,
           server_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL DEFAULT '',
           transport_type TEXT NOT NULL DEFAULT 'stdio',
           url TEXT NOT NULL DEFAULT '',
           command TEXT NOT NULL DEFAULT '',
           args_json TEXT NOT NULL DEFAULT '[]',
           env_json TEXT NOT NULL DEFAULT '{}',
           headers_json TEXT NOT NULL DEFAULT '{}',
           enabled INTEGER NOT NULL DEFAULT 1,
           timeout_ms INTEGER,
           sort_order INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'manual',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_mcp_server_configs_enabled
           ON mcp_server_configs(enabled);
         CREATE INDEX IF NOT EXISTS idx_mcp_server_configs_source
           ON mcp_server_configs(source);

         CREATE TABLE IF NOT EXISTS sub_agent_configs (
           id TEXT PRIMARY KEY NOT NULL,
           agent_id TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL,
           description TEXT NOT NULL DEFAULT '',
           system_prompt TEXT NOT NULL DEFAULT '',
           tools_json TEXT NOT NULL DEFAULT '[]',
           config_profile TEXT NOT NULL DEFAULT '',
           builtin INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'manual',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_sub_agent_configs_builtin
           ON sub_agent_configs(builtin);
         CREATE INDEX IF NOT EXISTS idx_sub_agent_configs_source
           ON sub_agent_configs(source);

         CREATE TABLE IF NOT EXISTS sensitive_command_configs (
           id TEXT PRIMARY KEY NOT NULL,
           command_id TEXT NOT NULL UNIQUE,
           pattern TEXT NOT NULL,
           description TEXT NOT NULL DEFAULT '',
           enabled INTEGER NOT NULL DEFAULT 1,
           is_preset INTEGER NOT NULL DEFAULT 0,
           sort_order INTEGER NOT NULL DEFAULT 0,
           source TEXT NOT NULL DEFAULT 'manual',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_sensitive_command_configs_enabled
           ON sensitive_command_configs(enabled);
         CREATE INDEX IF NOT EXISTS idx_sensitive_command_configs_source
           ON sensitive_command_configs(source);

         CREATE TABLE IF NOT EXISTS chat_conversations (
           id TEXT PRIMARY KEY NOT NULL,
           conversation_id TEXT NOT NULL UNIQUE,
           title TEXT NOT NULL DEFAULT '',
           summary TEXT NOT NULL DEFAULT '',
           last_message_preview TEXT NOT NULL DEFAULT '',
            message_count INTEGER NOT NULL DEFAULT 0,
            model TEXT NOT NULL DEFAULT '',
            api_profile_name TEXT NOT NULL DEFAULT '',
            last_response_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active',
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
            total_duration_ms INTEGER NOT NULL DEFAULT 0,
            directory_id TEXT NOT NULL DEFAULT '',
            forked_from_conversation_id TEXT NOT NULL DEFAULT '',
            fork_message_count INTEGER NOT NULL DEFAULT 0,
            emoji TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated_at
           ON chat_conversations(updated_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_chat_conversations_status
           ON chat_conversations(status);

         CREATE TABLE IF NOT EXISTS sub_agent_sessions (
           id TEXT PRIMARY KEY NOT NULL,
           conversation_id TEXT NOT NULL UNIQUE,
           parent_conversation_id TEXT NOT NULL,
           agent_id TEXT NOT NULL,
           agent_name TEXT NOT NULL DEFAULT '',
           run_status TEXT NOT NULL DEFAULT 'running',
           error_message TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           FOREIGN KEY(conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
           FOREIGN KEY(parent_conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_sub_agent_sessions_parent
           ON sub_agent_sessions(parent_conversation_id, created_at ASC, id ASC);
         CREATE INDEX IF NOT EXISTS idx_sub_agent_sessions_status
           ON sub_agent_sessions(run_status);

         CREATE TABLE IF NOT EXISTS chat_messages (
           id TEXT PRIMARY KEY NOT NULL,
           message_id TEXT NOT NULL UNIQUE,
           conversation_id TEXT NOT NULL,
           role TEXT NOT NULL,
           content TEXT NOT NULL,
           model TEXT NOT NULL DEFAULT '',
           response_id TEXT NOT NULL DEFAULT '',
           checkpoint_id TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL DEFAULT 'sent',
           raw_json TEXT NOT NULL DEFAULT '{}',
           thinking TEXT NOT NULL DEFAULT '',
           thinking_blocks_json TEXT NOT NULL DEFAULT '[]',
           tool_calls_json TEXT NOT NULL DEFAULT '[]',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           FOREIGN KEY(conversation_id) REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id
           ON chat_messages(conversation_id, id ASC);
         CREATE INDEX IF NOT EXISTS idx_chat_messages_response_id
           ON chat_messages(response_id);

         CREATE TABLE IF NOT EXISTS todo_items (
           id TEXT PRIMARY KEY NOT NULL,
           session_id TEXT NOT NULL,
           content TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'pending',
           response_id TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           parent_id TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_todo_items_session
           ON todo_items(session_id);

         CREATE TABLE IF NOT EXISTS usage_records (
           id TEXT PRIMARY KEY NOT NULL,
           conversation_id TEXT NOT NULL DEFAULT '',
           response_id TEXT NOT NULL DEFAULT '',
           model TEXT NOT NULL DEFAULT '',
           api_profile_name TEXT NOT NULL DEFAULT '',
           api_config_id TEXT NOT NULL DEFAULT '',
           request_method TEXT NOT NULL DEFAULT '',
           input_tokens INTEGER NOT NULL DEFAULT 0,
           output_tokens INTEGER NOT NULL DEFAULT 0,
           cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
           cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL DEFAULT '',
           is_sub_agent INTEGER NOT NULL DEFAULT 0,
           directory_id TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_usage_records_created_at
           ON usage_records(created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_usage_records_conversation_id
           ON usage_records(conversation_id, id DESC);
         CREATE INDEX IF NOT EXISTS idx_usage_records_model
           ON usage_records(model);
         CREATE INDEX IF NOT EXISTS idx_usage_records_api_profile_name
           ON usage_records(api_profile_name);

         CREATE TABLE IF NOT EXISTS app_logs (
           id TEXT PRIMARY KEY NOT NULL,
           level TEXT NOT NULL DEFAULT 'INFO',
           module TEXT NOT NULL DEFAULT '',
           func TEXT NOT NULL DEFAULT '',
           line INTEGER,
           message TEXT NOT NULL DEFAULT '',
           input TEXT NOT NULL DEFAULT '',
           output TEXT NOT NULL DEFAULT '',
           duration TEXT NOT NULL DEFAULT '',
           context TEXT NOT NULL DEFAULT '',
           error TEXT NOT NULL DEFAULT '',
           source TEXT NOT NULL DEFAULT 'main',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_app_logs_created_at
           ON app_logs(created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_app_logs_level
           ON app_logs(level);
         CREATE INDEX IF NOT EXISTS idx_app_logs_module
           ON app_logs(module);

         CREATE TABLE IF NOT EXISTS memos (
           id TEXT PRIMARY KEY NOT NULL,
           memo_id TEXT NOT NULL UNIQUE,
           directory_id TEXT NOT NULL DEFAULT '',
           content TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL DEFAULT 'pending',
           created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
         );
         CREATE INDEX IF NOT EXISTS idx_memos_directory_status_created
           ON memos(directory_id, status, created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_memos_directory_created
           ON memos(directory_id, created_at DESC, id DESC);
    ",
    )?;

    // Ensure the codebase embed sessions table exists. Defined in a separate
    // module so the schema lives next to its CRUD functions.
    services::codebase_embed_sessions::ensure_sessions_table(connection)?;

    // Migrate existing databases that were created before per-conversation
    // API profile binding existed. Idempotent: no-op when the column is
    // already present (fresh databases get it from CREATE TABLE above).
    migrate_chat_conversations_api_profile(connection)?;

    connection.pragma_update(None, "user_version", 22)?;

    Ok(())
}

/// Adds the `api_profile_name` column to `chat_conversations` for databases
/// created by older app versions. The column binds a conversation to a
/// specific API config profile so different conversations can route to
/// different providers/models. Empty string means "follow the global active
/// profile" (the legacy behaviour).
fn migrate_chat_conversations_api_profile(connection: &Connection) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(chat_conversations)")?;
    let mut columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    let has_api_profile_column = columns.try_fold(false, |found, column| {
        Ok::<bool, rusqlite::Error>(found || column? == "api_profile_name")
    })?;

    if !has_api_profile_column {
        connection.execute(
            "ALTER TABLE chat_conversations
                ADD COLUMN api_profile_name TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }

    Ok(())
}

fn reset_legacy_integer_primary_key_tables(connection: &Connection) -> rusqlite::Result<()> {
    let has_legacy_primary_key = PRIMARY_KEY_TABLES.iter().try_fold(false, |found, table_name| {
        Ok::<bool, rusqlite::Error>(found || has_integer_primary_key(connection, table_name)?)
    })?;

    if !has_legacy_primary_key {
        return Ok(());
    }

    connection.execute_batch("PRAGMA foreign_keys = OFF;")?;
    for table_name in PRIMARY_KEY_TABLES {
        connection.execute(&format!("DROP TABLE IF EXISTS {table_name}"), [])?;
    }
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;

    Ok(())
}

fn has_integer_primary_key(connection: &Connection, table_name: &str) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let mut columns = statement.query_map([], |row| {
        Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i32>(5)?))
    })?;

    columns.try_fold(false, |found, column| {
        let (column_name, column_type, primary_key_index) = column?;
        Ok(found
            || (column_name == "id"
                && primary_key_index > 0
                && column_type.eq_ignore_ascii_case("INTEGER")))
    })
}

pub fn database_error(database_path: &Path, action: &str, error: rusqlite::Error) -> Error {
    Error::from_reason(format!(
        "Failed to {action} Snow App sqlite database at '{}': {error}",
        database_path.display()
    ))
}
