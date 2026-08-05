use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use similar::TextDiff;

use super::gitignore::GitignoreMatcher;

const CHECKPOINT_DIR_NAME: &str = "checkpoints";
const OBJECT_DIR_NAME: &str = "objects";
const PENDING_DIR_NAME: &str = "pending";
const MANIFEST_VERSION: u32 = 2;

/// Prefix marking a manifest entry path as an absolute path outside the
/// checkpoint's working directory. Entries whose path starts with this marker
/// store the full absolute filesystem path (after the marker) instead of a
/// path relative to `work_dir`. This lets the checkpoint system record and
/// restore files edited outside the project workspace (e.g. `~/.snow/settings.json`).
const ABSOLUTE_PATH_MARKER: &str = "\x00abs:";

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "out",
    "coverage",
    ".cache",
    ".turbo",
    ".vercel",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    ".vs",
    ".snow",
    ".snowapp",
    "release",
    ".output",
    ".angular",
    ".parcel-cache",
];

static COUNTER: AtomicU64 = AtomicU64::new(0);
static CHECKPOINT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct CheckpointManifest {
    version: u32,
    work_dir: String,
    git: Option<GitBaseline>,
    entries: Vec<CheckpointEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
struct GitBaseline {
    repository_root: String,
    work_dir_prefix: String,
    head: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct CheckpointEntry {
    path: String,
    original: OriginalState,
    #[serde(default)]
    expected: Option<OriginalState>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum OriginalState {
    Missing,
    Object { object_id: String },
    Git,
}
struct PendingFileState(PathBuf);

pub struct CheckpointWorktreeCapture {
    checkpoint_ids: Vec<String>,
    work_dir: String,
    before_paths: HashMap<String, HashSet<String>>,
    before_states: HashMap<String, PendingFileState>,
    pending_dir: PathBuf,
}

impl Drop for CheckpointWorktreeCapture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.pending_dir);
    }
}
fn checkpoint_root() -> Result<PathBuf> {
    let storage_dir = crate::storage::paths::app_storage_dir()?;
    Ok(storage_dir.join(CHECKPOINT_DIR_NAME))
}

fn checkpoint_guard() -> Result<MutexGuard<'static, ()>> {
    CHECKPOINT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| Error::from_reason("Checkpoint state lock is poisoned"))
}

fn should_skip_relative(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name
            .to_str()
            .map(|value| SKIP_DIRS.contains(&value))
            .unwrap_or(false),
        _ => false,
    })
}

fn generate_checkpoint_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("cp-{}-{}-{}", now.as_secs(), now.subsec_nanos(), count)
}

fn to_forward_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn from_forward_slashes(relative: &str) -> PathBuf {
    PathBuf::from(relative.replace(
        '/',
        &std::path::MAIN_SEPARATOR.to_string(),
    ))
}

fn canonical_work_dir(work_dir: &str) -> Result<PathBuf> {
    let root = Path::new(work_dir);
    if !root.exists() {
        return Err(Error::from_reason(format!(
            "Working directory does not exist: {work_dir}"
        )));
    }
    if !root.is_dir() {
        return Err(Error::from_reason(format!(
            "Path is not a directory: {work_dir}"
        )));
    }
    fs::canonicalize(root).map_err(|error| {
        Error::from_reason(format!(
            "Failed to resolve working directory '{}': {error}",
            root.display()
        ))
    })
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// Strip Windows extended-length path prefixes so absolute and canonical paths
/// can be compared consistently.
///
/// `fs::canonicalize` on Windows returns paths like `\\?\D:\repo` or
/// `\\?\UNC\server\share`. Logical absolute paths from the AI / UI usually do
/// not include this prefix, so `starts_with` would otherwise reject in-workspace
/// absolute paths (especially for files that do not exist yet).
fn strip_windows_extended_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

fn path_key(path: &Path) -> String {
    let stripped = strip_windows_extended_prefix(path);
    let mut key = stripped.to_string_lossy().replace('\\', "/");
    while key.ends_with('/') && key.len() > 1 {
        key.pop();
    }
    #[cfg(windows)]
    {
        key = key.to_ascii_lowercase();
    }
    key
}

fn is_path_within_root(path: &Path, root: &Path) -> bool {
    let candidate_key = path_key(path);
    let base_key = path_key(root);
    candidate_key == base_key
        || candidate_key.starts_with(&format!("{base_key}/"))
}

/// Resolve a path that may not exist yet while preserving the same Windows
/// extended-path form as `fs::canonicalize` on the parent directory.
fn resolve_path_for_checkpoint(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return fs::canonicalize(path).map_err(|error| {
            Error::from_reason(format!(
                "Failed to resolve checkpoint path '{}': {error}",
                path.display()
            ))
        });
    }

    let normalized = normalize_path(path);
    if let Some(parent) = normalized.parent() {
        if !parent.as_os_str().is_empty() && parent.exists() {
            let parent_canonical = fs::canonicalize(parent).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to resolve checkpoint path parent '{}': {error}",
                    parent.display()
                ))
            })?;
            if let Some(file_name) = normalized.file_name() {
                return Ok(parent_canonical.join(file_name));
            }
        }
    }

    Ok(strip_windows_extended_prefix(&normalized))
}

fn resolve_checkpoint_path(root: &Path, file_path: &str) -> Result<(PathBuf, String)> {
    let supplied = Path::new(file_path);
    let candidate = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        // Join relative paths against the logical root so Windows extended
        // prefixes do not leak into intermediate path components.
        strip_windows_extended_prefix(root).join(supplied)
    };
    let normalized = resolve_path_for_checkpoint(&candidate)?;

    if !is_path_within_root(&normalized, root) {
        // File is outside the checkpoint's working directory (e.g. editing
        // `~/.snow/settings.json`). Store it as an absolute-path-marked entry
        // so the checkpoint can still record and restore it on rollback.
        let abs_key = to_forward_slashes(&strip_windows_extended_prefix(&normalized));
        let marked = format!("{ABSOLUTE_PATH_MARKER}{abs_key}");
        return Ok((normalized, marked));
    }

    let relative = {
        let path_key_value = path_key(&normalized);
        let root_key_value = path_key(root);
        if path_key_value == root_key_value {
            String::new()
        } else {
            let relative_key = path_key_value
                .strip_prefix(&format!("{root_key_value}/"))
                .ok_or_else(|| Error::from_reason("Failed to create checkpoint-relative path"))?;
            relative_key.to_string()
        }
    };
    Ok((normalized, relative))
}

/// Resolve a manifest entry path back to an absolute filesystem path.
///
/// Paths stored with the `ABSOLUTE_PATH_MARKER` prefix are outside-workspace
/// absolute paths and are returned as-is (after stripping the marker).
/// All other paths are treated as relative to `root` and joined accordingly.
fn resolve_manifest_path(root: &Path, manifest_path: &str) -> PathBuf {
    if let Some(abs_path) = manifest_path.strip_prefix(ABSOLUTE_PATH_MARKER) {
        from_forward_slashes(abs_path)
    } else {
        root.join(from_forward_slashes(manifest_path))
    }
}

/// Check whether a manifest entry path should be skipped (e.g. it falls inside
/// a `node_modules` or `.git` directory). Absolute-path-marked entries are
/// never skipped by this check — they represent files outside the workspace
/// that the user explicitly chose to edit.
fn should_skip_manifest_path(manifest_path: &str) -> bool {
    if manifest_path.starts_with(ABSOLUTE_PATH_MARKER) {
        return false;
    }
    should_skip_relative(Path::new(manifest_path))
}

fn checkpoint_dir(checkpoint_id: &str) -> Result<PathBuf> {
    Ok(checkpoint_root()?.join(checkpoint_id))
}
fn manifest_path(checkpoint_id: &str) -> Result<PathBuf> {
    Ok(checkpoint_dir(checkpoint_id)?.join("manifest.json"))
}

/// Check whether a checkpoint manifest file exists on disk.
fn checkpoint_manifest_exists(checkpoint_id: &str) -> bool {
    match manifest_path(checkpoint_id) {
        Ok(path) => path.is_file(),
        Err(_) => false,
    }
}

/// Filter out checkpoint IDs whose manifest no longer exists on disk.
///
/// When a conversation is resumed from history, the frontend reconstructs the
/// `checkpoint_ids` list from persisted message records. Some of those
/// checkpoints may have been deleted (by rollback, compaction cleanup, or
/// new-chat pruning), leaving dangling IDs that would cause `read_manifest`
/// to fail. This helper silently drops them so tool execution can proceed
/// against the still-valid checkpoints.
fn filter_existing_checkpoints(checkpoint_ids: Vec<String>) -> Vec<String> {
    checkpoint_ids
        .into_iter()
        .filter(|id| checkpoint_manifest_exists(id))
        .collect()
}

fn read_manifest(checkpoint_id: &str) -> Result<CheckpointManifest> {
    let path = manifest_path(checkpoint_id)?;
    let json = fs::read_to_string(&path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read checkpoint manifest '{}': {error}",
            path.display()
        ))
    })?;
    let manifest: CheckpointManifest = serde_json::from_str(&json).map_err(|error| {
        Error::from_reason(format!(
            "Failed to parse checkpoint manifest '{}': {error}",
            path.display()
        ))
    })?;
    if manifest.version != MANIFEST_VERSION {
        return Err(Error::from_reason(format!(
            "Unsupported checkpoint format version: {}",
            manifest.version
        )));
    }
    Ok(manifest)
}

fn write_manifest(checkpoint_id: &str, manifest: &CheckpointManifest) -> Result<()> {
    let directory = checkpoint_dir(checkpoint_id)?;
    fs::create_dir_all(&directory).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint directory '{}': {error}",
            directory.display()
        ))
    })?;
    let json = serde_json::to_vec(manifest).map_err(|error| {
        Error::from_reason(format!("Failed to serialize checkpoint manifest: {error}"))
    })?;
    let temporary = directory.join(format!("manifest-{}.tmp", generate_checkpoint_id()));
    fs::write(&temporary, json).map_err(|error| {
        Error::from_reason(format!(
            "Failed to write checkpoint manifest '{}': {error}",
            temporary.display()
        ))
    })?;
    fs::rename(&temporary, directory.join("manifest.json")).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        Error::from_reason(format!("Failed to publish checkpoint manifest: {error}"))
    })
}

fn run_git(work_dir: &Path, args: &[&str]) -> Result<Output> {
    let mut command = Command::new("git");
    // `safe.directory=*` bypasses Git's dubious-ownership check
    // (CVE-2022-24765), so git works inside WSL (`\\wsl$\...`) and other
    // UNC/network paths where the repo is owned by a different user.
    command
        .args(["-c", "core.quotepath=false", "-c", "safe.directory=*"])
        .args(args)
        .current_dir(work_dir);

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .output()
        .map_err(|error| Error::from_reason(format!("Failed to execute git: {error}")))
}

fn git_text(work_dir: &Path, args: &[&str]) -> Option<String> {
    let output = run_git(work_dir, args).ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn detect_git_baseline(work_dir: &Path) -> Option<GitBaseline> {
    let repository_root = git_text(work_dir, &["rev-parse", "--show-toplevel"])?;
    let head = git_text(work_dir, &["rev-parse", "HEAD"])?;
    let repository_root = fs::canonicalize(repository_root).ok()?;
    let prefix = work_dir.strip_prefix(&repository_root).ok()?;
    Some(GitBaseline {
        repository_root: repository_root.to_string_lossy().to_string(),
        work_dir_prefix: to_forward_slashes(prefix),
        head,
    })
}

fn checkpoint_git_ref(checkpoint_id: &str) -> String {
    format!("refs/snow/checkpoints/{checkpoint_id}")
}

fn update_checkpoint_git_ref(
    checkpoint_id: &str,
    baseline: &GitBaseline,
    delete: bool,
) -> Result<()> {
    let repository_root = Path::new(&baseline.repository_root);
    let reference = checkpoint_git_ref(checkpoint_id);
    let output = if delete {
        run_git(repository_root, &["update-ref", "-d", &reference])?
    } else {
        run_git(
            repository_root,
            &["update-ref", &reference, &baseline.head],
        )?
    };
    if output.status.success() {
        Ok(())
    } else {
        Err(Error::from_reason(format!(
            "Failed to update checkpoint Git reference: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn collect_worktree_file_paths(root: &Path) -> Result<HashSet<String>> {
    let matcher = GitignoreMatcher::from_project_root(root);
    let mut paths = HashSet::new();
    let mut directories = vec![root.to_path_buf()];

    while let Some(directory) = directories.pop() {
        let entries = fs::read_dir(&directory).map_err(|error| {
            Error::from_reason(format!(
                "Failed to scan checkpoint directory '{}': {error}",
                directory.display()
            ))
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                Error::from_reason(format!("Failed to read checkpoint entry: {error}"))
            })?;
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to resolve checkpoint-relative path '{}': {error}",
                    path.display()
                ))
            })?;
            if should_skip_relative(relative) {
                continue;
            }

            let file_type = entry.file_type().map_err(|error| {
                Error::from_reason(format!(
                    "Failed to inspect checkpoint path '{}': {error}",
                    path.display()
                ))
            })?;
            if file_type.is_symlink() {
                continue;
            }

            let relative_path = to_forward_slashes(relative);
            if matcher.is_ignored(&relative_path, file_type.is_dir()) {
                continue;
            }

            if file_type.is_dir() {
                directories.push(path);
            } else if file_type.is_file() {
                paths.insert(relative_path);
            }
        }
    }

    Ok(paths)
}

fn git_object_spec(baseline: &GitBaseline, relative: &str) -> String {
    let repository_path = if baseline.work_dir_prefix.is_empty() {
        relative.to_string()
    } else {
        format!(
            "{}/{}",
            baseline.work_dir_prefix.trim_end_matches('/'),
            relative
        )
    };
    format!("{}:{}", baseline.head, repository_path)
}

fn read_git_object(baseline: &GitBaseline, relative: &str) -> Result<Option<Vec<u8>>> {
    let repository_root = Path::new(&baseline.repository_root);
    let object_spec = git_object_spec(baseline, relative);
    let output = run_git(repository_root, &["show", &object_spec])?;
    if output.status.success() {
        Ok(Some(output.stdout))
    } else {
        Ok(None)
    }
}

fn store_object(path: &Path) -> Result<String> {
    let object_dir = checkpoint_root()?.join(OBJECT_DIR_NAME);
    fs::create_dir_all(&object_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint object directory: {error}"
        ))
    })?;
    let temporary = object_dir.join(format!("{}.tmp", generate_checkpoint_id()));
    let mut source = File::open(path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read checkpoint source '{}': {error}",
            path.display()
        ))
    })?;
    let mut destination = File::create(&temporary).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint object '{}': {error}",
            temporary.display()
        ))
    })?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer).map_err(|error| {
            Error::from_reason(format!("Failed to read checkpoint source: {error}"))
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        destination.write_all(&buffer[..count]).map_err(|error| {
            Error::from_reason(format!("Failed to write checkpoint object: {error}"))
        })?;
    }
    destination.flush().map_err(|error| {
        Error::from_reason(format!("Failed to flush checkpoint object: {error}"))
    })?;

    let object_id = hasher.finalize().to_hex().to_string();
    let final_path = object_dir.join(&object_id);
    if final_path.exists() {
        let _ = fs::remove_file(&temporary);
    } else {
        fs::rename(&temporary, &final_path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            Error::from_reason(format!("Failed to publish checkpoint object: {error}"))
        })?;
    }
    Ok(object_id)
}

fn current_state(path: &Path) -> Result<OriginalState> {
    if !path.exists() {
        return Ok(OriginalState::Missing);
    }
    if !path.is_file() {
        return Err(Error::from_reason(format!(
            "Checkpoint path is not a regular file: {}",
            path.display()
        )));
    }
    Ok(OriginalState::Object {
        object_id: store_object(path)?,
    })
}

fn states_match(
    current: &Path,
    expected: &OriginalState,
    baseline: Option<&GitBaseline>,
    relative: &str,
) -> Result<bool> {
    Ok(classify_change(current, expected, baseline, relative)?.is_none())
}

fn update_expected_state(manifest: &mut CheckpointManifest, absolute: &Path, path: &str) -> Result<bool> {
    let Some(entry) = manifest.entries.iter_mut().find(|entry| entry.path == path) else {
        return Ok(false);
    };
    entry.expected = Some(current_state(absolute)?);
    Ok(true)
}

fn capture_entry(
    manifest: &mut CheckpointManifest,
    absolute: &Path,
    relative: &Path,
    original: OriginalState,
) -> Result<()> {
    if relative.as_os_str().is_empty() || should_skip_relative(relative) {
        return Ok(());
    }
    let path = to_forward_slashes(relative);
    let expected = current_state(absolute)?;
    if let Some(entry) = manifest.entries.iter_mut().find(|entry| entry.path == path) {
        entry.expected = Some(expected);
        return Ok(());
    }

    manifest.entries.push(CheckpointEntry {
        path,
        original,
        expected: Some(expected),
    });
    Ok(())
}

fn validate_manifest_work_dir(manifest: &CheckpointManifest, work_dir: &str) -> Result<PathBuf> {
    let requested = canonical_work_dir(work_dir)?;
    let recorded = PathBuf::from(&manifest.work_dir);
    if requested != recorded {
        return Err(Error::from_reason(format!(
            "Checkpoint belongs to '{}', not '{}'",
            recorded.display(),
            requested.display()
        )));
    }
    Ok(requested)
}

/// 捕获阶段的目录校验(工具执行前/后):checkpoint 属于其他目录时返回
/// None,调用方跳过该 checkpoint 并继续,绝不因目录不匹配拦截工具执行。
/// 回滚阶段仍由 validate_manifest_work_dir 严格校验。
fn validate_capture_work_dir(
    manifest: &CheckpointManifest,
    work_dir: &str,
) -> Option<PathBuf> {
    match validate_manifest_work_dir(manifest, work_dir) {
        Ok(root) => Some(root),
        Err(error) => {
            eprintln!("[checkpoint] {error}; skipping checkpoint capture");
            None
        }
    }
}

/// Create an incremental checkpoint without copying the working directory.
/// File content is captured lazily, immediately before a tool first changes it.
pub fn create_checkpoint(work_dir: String) -> Result<String> {
    let _guard = checkpoint_guard()?;
    let root = canonical_work_dir(&work_dir)?;
    let checkpoint_id = generate_checkpoint_id();
    let manifest = CheckpointManifest {
        version: MANIFEST_VERSION,
        work_dir: root.to_string_lossy().to_string(),
        git: detect_git_baseline(&root),
        entries: Vec::new(),
    };

    write_manifest(&checkpoint_id, &manifest)?;
    if let Some(baseline) = manifest.git.as_ref() {
        if let Err(error) = update_checkpoint_git_ref(&checkpoint_id, baseline, false) {
            let _ = fs::remove_dir_all(checkpoint_dir(&checkpoint_id)?);
            return Err(error);
        }
    }
    Ok(checkpoint_id)
}

/// Capture the original state of one file before a filesystem tool changes it.
pub fn record_checkpoint_file(
    checkpoint_ids: Vec<String>,
    work_dir: String,
    file_path: String,
) -> Result<()> {
    let checkpoint_ids = filter_existing_checkpoints(checkpoint_ids);
    if checkpoint_ids.is_empty() {
        return Ok(());
    }
    let _guard = checkpoint_guard()?;
    let root = canonical_work_dir(&work_dir)?;
    let (absolute, path) = resolve_checkpoint_path(&root, &file_path)?;
    if path.is_empty() || should_skip_manifest_path(&path) {
        return Ok(());
    }

    for checkpoint_id in checkpoint_ids {
        let mut manifest = read_manifest(&checkpoint_id)?;
        let Some(_root) = validate_capture_work_dir(&manifest, &work_dir) else {
            continue;
        };
        if manifest.entries.iter().any(|entry| entry.path == path) {
            continue;
        }
        manifest.entries.push(CheckpointEntry {
            path: path.clone(),
            original: current_state(&absolute)?,
            expected: None,
        });
        write_manifest(&checkpoint_id, &manifest)?;
    }
    Ok(())
}

/// Record the state produced by a successful filesystem tool execution.
pub fn record_checkpoint_file_after(
    checkpoint_ids: Vec<String>,
    work_dir: String,
    file_path: String,
) -> Result<()> {
    let checkpoint_ids = filter_existing_checkpoints(checkpoint_ids);
    if checkpoint_ids.is_empty() {
        return Ok(());
    }
    let _guard = checkpoint_guard()?;
    let root = canonical_work_dir(&work_dir)?;
    let (absolute, path) = resolve_checkpoint_path(&root, &file_path)?;
    if path.is_empty() || should_skip_manifest_path(&path) {
        return Ok(());
    }

    for checkpoint_id in checkpoint_ids {
        let mut manifest = read_manifest(&checkpoint_id)?;
        let Some(_root) = validate_capture_work_dir(&manifest, &work_dir) else {
            continue;
        };
        if update_expected_state(&mut manifest, &absolute, &path)? {
            write_manifest(&checkpoint_id, &manifest)?;
        }
    }
    Ok(())
}

fn copy_pending_file(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create pending checkpoint directory '{}': {error}",
                parent.display()
            ))
        })?;
    }
    fs::copy(source, destination).map_err(|error| {
        Error::from_reason(format!(
            "Failed to capture pending checkpoint file '{}': {error}",
            source.display()
        ))
    })?;
    Ok(())
}

fn pending_state_matches_current(state: &PendingFileState, current: &Path) -> bool {
    current.is_file() && !files_are_different(current, &state.0)
}

fn pending_state_to_original(state: &PendingFileState) -> Result<OriginalState> {
    Ok(OriginalState::Object {
        object_id: store_object(&state.0)?,
    })
}

/// Snapshot the current worktree into temporary storage before a terminal
/// command. No manifest entries are committed until the command ends.
pub fn capture_checkpoint_worktree_before(
    checkpoint_ids: Vec<String>,
    work_dir: String,
) -> Result<Option<CheckpointWorktreeCapture>> {
    let checkpoint_ids = filter_existing_checkpoints(checkpoint_ids);
    if checkpoint_ids.is_empty() {
        return Ok(None);
    }
    let _guard = checkpoint_guard()?;
    let root = canonical_work_dir(&work_dir)?;
    let pending_dir = checkpoint_root()?
        .join(PENDING_DIR_NAME)
        .join(generate_checkpoint_id());
    let all_paths = collect_worktree_file_paths(&root)?;
    let mut before_paths = HashMap::new();

    for checkpoint_id in &checkpoint_ids {
        let manifest = read_manifest(checkpoint_id)?;
        let Some(_root) = validate_capture_work_dir(&manifest, &work_dir) else {
            continue;
        };
        before_paths.insert(checkpoint_id.clone(), all_paths.clone());
    }

    // 所有 checkpoint 都与当前目录不匹配:没有任何可捕获目标,
    // 不做无意义的全目录快照。
    if before_paths.is_empty() {
        return Ok(None);
    }

    let mut before_states = HashMap::new();
    for relative_path in all_paths {
        let relative = from_forward_slashes(&relative_path);
        let absolute = root.join(&relative);
        let snapshot = pending_dir.join(&relative);
        copy_pending_file(&absolute, &snapshot)?;
        before_states.insert(relative_path, PendingFileState(snapshot));
    }

    Ok(Some(CheckpointWorktreeCapture {
        checkpoint_ids,
        work_dir,
        before_paths,
        before_states,
        pending_dir,
    }))
}

/// Commit only paths whose state changed while the terminal command ran.
pub fn record_checkpoint_worktree_after(capture: CheckpointWorktreeCapture) -> Result<()> {
    let _guard = checkpoint_guard()?;

    for checkpoint_id in &capture.checkpoint_ids {
        if !checkpoint_manifest_exists(checkpoint_id) {
            continue;
        }
        let mut manifest = read_manifest(checkpoint_id)?;
        let Some(root) = validate_capture_work_dir(&manifest, &capture.work_dir) else {
            continue;
        };
        let after_paths = collect_worktree_file_paths(&root)?;
        let mut candidates = capture
            .before_paths
            .get(checkpoint_id)
            .cloned()
            .unwrap_or_default();
        candidates.extend(after_paths);
        let mut changed = false;

        for relative_path in candidates {
            let relative = from_forward_slashes(&relative_path);
            if should_skip_relative(&relative) {
                continue;
            }
            let absolute = root.join(&relative);
            let before_state = capture.before_states.get(&relative_path);
            let command_changed_path = before_state
                .map(|state| !pending_state_matches_current(state, &absolute))
                .unwrap_or_else(|| absolute.is_file());
            if !command_changed_path {
                continue;
            }

            let original = before_state
                .map(pending_state_to_original)
                .transpose()?
                .unwrap_or(OriginalState::Missing);
            capture_entry(&mut manifest, &absolute, &relative, original)?;
            changed = true;
        }

        if changed {
            write_manifest(checkpoint_id, &manifest)?;
        }
    }
    Ok(())
}

/// Restore only paths that were recorded by mutating tools after this checkpoint.
pub fn restore_checkpoint(checkpoint_id: String, work_dir: String) -> Result<()> {
    let _guard = checkpoint_guard()?;
    // If the manifest no longer exists (checkpoint was deleted or corrupted),
    // there is nothing to restore. Return Ok so the rollback flow continues
    // to delete messages without being blocked by a missing checkpoint.
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    let root = validate_manifest_work_dir(&manifest, &work_dir)?;

    let mut restored_entries = Vec::new();
    for entry in &manifest.entries {
        if should_skip_manifest_path(&entry.path) {
            continue;
        }
        let destination = resolve_manifest_path(&root, &entry.path);
        let Some(expected) = entry.expected.as_ref() else {
            continue;
        };
        if !states_match(&destination, expected, manifest.git.as_ref(), &entry.path)? {
            continue;
        }
        restore_entry(&root, &manifest, entry)?;
        restored_entries.push(entry.path.clone());
    }
    prune_empty_parent_directories(
        &root,
        &manifest
            .entries
            .iter()
            .filter(|entry| restored_entries.contains(&entry.path))
            .cloned()
            .collect::<Vec<_>>(),
    );

    Ok(())
}

fn restore_entry(
    root: &Path,
    manifest: &CheckpointManifest,
    entry: &CheckpointEntry,
) -> Result<()> {
    let destination = resolve_manifest_path(root, &entry.path);
    match &entry.original {
        OriginalState::Missing => {
            if destination.is_file() || destination.is_symlink() {
                fs::remove_file(&destination).map_err(|error| {
                    Error::from_reason(format!(
                        "Failed to remove added file '{}': {error}",
                        destination.display()
                    ))
                })?;
            }
            Ok(())
        }
        OriginalState::Object { object_id } => {
            let source = checkpoint_root()?.join(OBJECT_DIR_NAME).join(object_id);
            restore_file(&source, &destination)
        }
        OriginalState::Git => {
            let baseline = manifest.git.as_ref().ok_or_else(|| {
                Error::from_reason("Checkpoint Git baseline is missing")
            })?;
            let content = read_git_object(baseline, &entry.path)?.ok_or_else(|| {
                Error::from_reason(format!(
                    "Checkpoint Git object is missing for '{}'",
                    entry.path
                ))
            })?;
            write_file(&destination, &content)
        }
    }
}

fn restore_file(source: &Path, destination: &Path) -> Result<()> {
    if !source.is_file() {
        return Err(Error::from_reason(format!(
            "Checkpoint object not found: {}",
            source.display()
        )));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create restore directory '{}': {error}",
                parent.display()
            ))
        })?;
    }
    fs::copy(source, destination).map_err(|error| {
        Error::from_reason(format!(
            "Failed to restore file '{}': {error}",
            destination.display()
        ))
    })?;
    Ok(())
}

fn write_file(destination: &Path, content: &[u8]) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create restore directory '{}': {error}",
                parent.display()
            ))
        })?;
    }
    fs::write(destination, content).map_err(|error| {
        Error::from_reason(format!(
            "Failed to restore file '{}': {error}",
            destination.display()
        ))
    })
}

fn prune_empty_parent_directories(root: &Path, entries: &[CheckpointEntry]) {
    let mut directories: Vec<PathBuf> = entries
        .iter()
        .filter_map(|entry| resolve_manifest_path(root, &entry.path).parent().map(Path::to_path_buf))
        .collect();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    directories.dedup();
    for directory in directories {
        let mut current = directory;
        while current.starts_with(root) && current != root {
            if fs::remove_dir(&current).is_err() {
                break;
            }
            let Some(parent) = current.parent() else {
                break;
            };
            current = parent.to_path_buf();
        }
    }
}

/// Delete a checkpoint and release its Git reference. Shared objects are
/// garbage-collected once no remaining manifest references them.
pub fn delete_checkpoint(checkpoint_id: String) -> Result<()> {
    let _guard = checkpoint_guard()?;
    let directory = checkpoint_dir(&checkpoint_id)?;
    if !directory.exists() {
        return Ok(());
    }

    if let Ok(manifest) = read_manifest(&checkpoint_id) {
        if let Some(baseline) = manifest.git.as_ref() {
            update_checkpoint_git_ref(&checkpoint_id, baseline, true)?;
        }
    }
    fs::remove_dir_all(&directory).map_err(|error| {
        Error::from_reason(format!(
            "Failed to delete checkpoint '{}': {error}",
            checkpoint_id
        ))
    })?;
    collect_unused_objects()
}

fn collect_unused_objects() -> Result<()> {
    let root = checkpoint_root()?;
    let object_dir = root.join(OBJECT_DIR_NAME);
    if !object_dir.is_dir() {
        return Ok(());
    }

    let mut referenced = HashSet::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if !entry.path().is_dir()
                || entry.file_name() == OBJECT_DIR_NAME
                || entry.file_name() == PENDING_DIR_NAME
            {
                continue;
            }
            let checkpoint_id = entry.file_name().to_string_lossy().to_string();
            if let Ok(manifest) = read_manifest(&checkpoint_id) {
                for item in manifest.entries {
                    if let OriginalState::Object { object_id } = item.original {
                        referenced.insert(object_id);
                    }
                    if let Some(OriginalState::Object { object_id }) = item.expected {
                        referenced.insert(object_id);
                    }
                }
            }
        }
    }

    for entry in fs::read_dir(&object_dir).map_err(|error| {
        Error::from_reason(format!("Failed to scan checkpoint objects: {error}"))
    })? {
        let entry = entry.map_err(|error| {
            Error::from_reason(format!("Failed to read checkpoint object entry: {error}"))
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_file() && !referenced.contains(&name) {
            fs::remove_file(entry.path()).map_err(|error| {
                Error::from_reason(format!("Failed to remove unused checkpoint object: {error}"))
            })?;
        }
    }
    Ok(())
}

/// A single file change between the checkpoint snapshot and the current
/// working directory state.
#[napi(object)]
pub struct CheckpointFileChange {
    /// Relative file path (forward-slash separated).
    pub path: String,
    /// "added" (created after checkpoint, will be deleted),
    /// "modified" (content differs, will be reverted),
    /// "deleted" (existed at checkpoint, was removed, will be restored).
    pub change_type: String,
}

/// A file change with a unified diff suitable for rollback preview.
#[napi(object)]
pub struct CheckpointFileDiff {
    pub path: String,
    pub change_type: String,
    pub content: String,
    pub is_binary: bool,
}

fn collect_tracked_entries(manifest: &CheckpointManifest) -> Vec<CheckpointEntry> {
    manifest.entries.clone()
}

/// Compare only paths explicitly recorded while this conversation's tools ran.
pub fn list_checkpoint_changes(
    checkpoint_id: String,
    work_dir: String,
) -> Result<Vec<CheckpointFileChange>> {
    let _guard = checkpoint_guard()?;
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(Vec::new());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    let root = validate_manifest_work_dir(&manifest, &work_dir)?;
    let tracked = collect_tracked_entries(&manifest);

    let mut changes = Vec::new();
    for entry in tracked {
        if should_skip_manifest_path(&entry.path) {
            continue;
        }
        let Some(expected) = entry.expected.as_ref() else {
            continue;
        };
        let current = resolve_manifest_path(&root, &entry.path);
        if !states_match(&current, expected, manifest.git.as_ref(), &entry.path)? {
            continue;
        }
        if let Some(change_type) = classify_change(
            &current,
            &entry.original,
            manifest.git.as_ref(),
            &entry.path,
        )? {
            changes.push(CheckpointFileChange {
                path: entry.path,
                change_type,
            });
        }
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(changes)
}

/// Build unified diffs from checkpoint content to the current working state.
/// This is read-only and is used by the renderer's rollback preview and the
/// file-changes panel.
///
/// `include_all` controls which captured entries are reported:
/// - `false` (rollback preview): only files whose current state still matches
///   the checkpoint's post-change state. These are exactly the files rollback
///   would restore, so the preview matches the restore behaviour.
/// - `true` (file-changes panel): every captured entry is reported as long as
///   its current state differs from the pre-change state. Files that were
///   re-modified by later runs in a shared working tree stay visible, so an
///   earlier conversation's modifications are never erased from the panel.
pub fn list_checkpoint_diffs(
    checkpoint_id: String,
    work_dir: String,
    include_all: bool,
) -> Result<Vec<CheckpointFileDiff>> {
    let _guard = checkpoint_guard()?;
    if !checkpoint_manifest_exists(&checkpoint_id) {
        return Ok(Vec::new());
    }
    let manifest = read_manifest(&checkpoint_id)?;
    let root = validate_manifest_work_dir(&manifest, &work_dir)?;
    let tracked = collect_tracked_entries(&manifest);

    let mut diffs = Vec::new();
    for entry in tracked {
        if should_skip_manifest_path(&entry.path) {
            continue;
        }
        let Some(expected) = entry.expected.as_ref() else {
            continue;
        };
        let current = resolve_manifest_path(&root, &entry.path);
        if !include_all
            && !states_match(&current, expected, manifest.git.as_ref(), &entry.path)?
        {
            continue;
        }
        let Some(change_type) = classify_change(
            &current,
            &entry.original,
            manifest.git.as_ref(),
            &entry.path,
        )? else {
            continue;
        };
        let original_content = read_original_content(
            &entry.original,
            manifest.git.as_ref(),
            &entry.path,
        )?;
        let current_content = read_current_content(&current)?;
        let (content, is_binary) = build_unified_diff(
            &entry.path,
            original_content.as_deref(),
            current_content.as_deref(),
        );
        diffs.push(CheckpointFileDiff {
            path: entry.path,
            change_type,
            content,
            is_binary,
        });
    }
    diffs.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(diffs)
}

fn read_original_content(
    original: &OriginalState,
    baseline: Option<&GitBaseline>,
    relative: &str,
) -> Result<Option<Vec<u8>>> {
    match original {
        OriginalState::Missing => Ok(None),
        OriginalState::Object { object_id } => {
            let object = checkpoint_root()?.join(OBJECT_DIR_NAME).join(object_id);
            fs::read(&object).map(Some).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to read checkpoint object '{}': {error}",
                    object.display()
                ))
            })
        }
        OriginalState::Git => {
            let baseline = baseline.ok_or_else(|| {
                Error::from_reason("Checkpoint Git baseline is missing")
            })?;
            read_git_object(baseline, relative)
        }
    }
}

fn read_current_content(path: &Path) -> Result<Option<Vec<u8>>> {
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_file() {
        return Err(Error::from_reason(format!(
            "Checkpoint path is not a regular file: {}",
            path.display()
        )));
    }
    fs::read(path).map(Some).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read current checkpoint file '{}': {error}",
            path.display()
        ))
    })
}

fn build_unified_diff(
    relative: &str,
    original: Option<&[u8]>,
    current: Option<&[u8]>,
) -> (String, bool) {
    let original_bytes = original.unwrap_or_default();
    let current_bytes = current.unwrap_or_default();
    let Ok(original_text) = std::str::from_utf8(original_bytes) else {
        return (String::new(), true);
    };
    let Ok(current_text) = std::str::from_utf8(current_bytes) else {
        return (String::new(), true);
    };
    if original_bytes.contains(&0) || current_bytes.contains(&0) {
        return (String::new(), true);
    }

    let original_header = original
        .map(|_| format!("a/{relative}"))
        .unwrap_or_else(|| "/dev/null".to_string());
    let current_header = current
        .map(|_| format!("b/{relative}"))
        .unwrap_or_else(|| "/dev/null".to_string());
    let content = TextDiff::from_lines(original_text, current_text)
        .unified_diff()
        .context_radius(3)
        .header(&original_header, &current_header)
        .to_string();
    (content, false)
}

fn classify_change(
    current: &Path,
    original: &OriginalState,
    baseline: Option<&GitBaseline>,
    relative: &str,
) -> Result<Option<String>> {
    match original {
        OriginalState::Missing => Ok(current.exists().then(|| "added".to_string())),
        OriginalState::Object { object_id } => {
            if !current.exists() {
                return Ok(Some("deleted".to_string()));
            }
            let object = checkpoint_root()?.join(OBJECT_DIR_NAME).join(object_id);
            Ok(files_are_different(current, &object).then(|| "modified".to_string()))
        }
        OriginalState::Git => {
            let baseline = baseline.ok_or_else(|| {
                Error::from_reason("Checkpoint Git baseline is missing")
            })?;
            let Some(content) = read_git_object(baseline, relative)? else {
                return Ok(current.exists().then(|| "added".to_string()));
            };
            if !current.exists() {
                return Ok(Some("deleted".to_string()));
            }
            Ok(file_differs_from_bytes(current, &content).then(|| "modified".to_string()))
        }
    }
}

fn file_differs_from_bytes(path: &Path, expected: &[u8]) -> bool {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return true,
    };
    if metadata.len() != expected.len() as u64 {
        return true;
    }
    fs::read(path).map(|content| content != expected).unwrap_or(true)
}

/// Compare two files by size first, then by content. Returns true if they
/// differ (or if either file cannot be read).
fn files_are_different(a: &Path, b: &Path) -> bool {
    let meta_a = match fs::metadata(a) {
        Ok(m) => m,
        Err(_) => return true,
    };
    let meta_b = match fs::metadata(b) {
        Ok(m) => m,
        Err(_) => return true,
    };

    if meta_a.len() != meta_b.len() {
        return true;
    }

    // Same size — compare content byte-by-byte.
    let content_a = match fs::read(a) {
        Ok(c) => c,
        Err(_) => return true,
    };
    let content_b = match fs::read(b) {
        Ok(c) => c,
        Err(_) => return true,
    };

    content_a != content_b
}
