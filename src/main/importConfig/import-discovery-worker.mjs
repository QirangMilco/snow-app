import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parentPort } from "node:worker_threads";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "sessions"]);
const MAX_FILES = 5_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 20;
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 128;
const cache = new Map();

const canonicalPath = (path) => {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

// Raised internally to stop a scan that exceeded the time budget while
// keeping the files collected so far. The scan limits are protective
// guards, not fatal conditions: a directory tree deeper or larger than the
// limit must never break the whole import discovery flow.
const SCAN_STOP = Symbol("scan-stop");

const scan = (root, maxDepth) => {
  const startedAt = Date.now();
  let fileCount = 0;
  let byteCount = 0;
  const files = [];
  const fingerprints = [];
  const fingerprint = (path, metadata) => ({
    path,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
    isDirectory: metadata.isDirectory(),
  });
  const checkTime = () => {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      throw SCAN_STOP;
    }
  };
  const addFile = (filePath, metadata) => {
    if (fileCount >= MAX_FILES || byteCount + metadata.size > MAX_BYTES) {
      // Skip files beyond the protective limits instead of failing the scan.
      return;
    }
    fileCount += 1;
    byteCount += metadata.size;
    files.push(filePath);
    fingerprints.push(fingerprint(filePath, metadata));
  };
  const visit = (current, depth) => {
    checkTime();
    if (depth > maxDepth) {
      // Skip branches deeper than the limit instead of failing the scan.
      return;
    }
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch {
      return;
    }
    if (metadata.isSymbolicLink()) return;
    if (metadata.isFile()) {
      addFile(current, metadata);
      return;
    }
    if (!metadata.isDirectory()) return;
    fingerprints.push(fingerprint(current, metadata));
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      visit(join(current, entry.name), depth + 1);
    }
  };
  try {
    if (existsSync(root)) visit(root, 0);
  } catch (error) {
    if (error !== SCAN_STOP) throw error;
  }
  return { files, fingerprints };
};

const cacheEntryIsCurrent = (entry) => entry.fingerprints.every((expected) => {
  try {
    const current = lstatSync(expected.path);
    return current.mtimeMs === expected.mtimeMs &&
      current.size === expected.size &&
      current.isDirectory() === expected.isDirectory;
  } catch {
    return false;
  }
});

const cached = (key, operation) => {
  const existing = cache.get(key);
  if (existing && existing.fingerprints.length > 0 &&
      Date.now() - existing.createdAt < CACHE_TTL_MS && cacheEntryIsCurrent(existing)) {
    return existing.value;
  }
  const { value, fingerprints } = operation();
  cache.set(key, { createdAt: Date.now(), value, fingerprints });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
};

const hashPath = (path) => {
  const root = canonicalPath(path);
  if (!existsSync(root)) {
    return {
      value: createHash("sha256").update(JSON.stringify({ missing: root })).digest("hex"),
      fingerprints: [],
    };
  }
  const hasher = createHash("sha256");
  const result = scan(root, MAX_DEPTH);
  for (const filePath of result.files) {
    hasher.update(relative(root, filePath));
    hasher.update(readFileSync(filePath));
  }
  return { value: hasher.digest("hex"), fingerprints: result.fingerprints };
};

const topLevelDirectories = (root) => {
  if (!existsSync(root)) return { value: [], fingerprints: [] };
  const rootMetadata = lstatSync(root);
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  return {
    value: entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .slice(0, MAX_FILES)
      .map((entry) => join(root, entry.name)),
    fingerprints: [{
      path: root,
      mtimeMs: rootMetadata.mtimeMs,
      size: rootMetadata.size,
      isDirectory: true,
    }],
  };
};

parentPort?.on("message", (request) => {
  try {
    if (request.operation === "clear") {
      cache.clear();
      parentPort?.postMessage({ id: request.id, value: "cleared" });
      return;
    }
    if (typeof request.path !== "string" || !request.path) {
      throw new Error("Import discovery worker requires a path");
    }
    const root = canonicalPath(request.path);
    const maxDepth = Math.min(Math.max(Number(request.maxDepth) || MAX_DEPTH, 0), MAX_DEPTH);
    const key = `${request.operation}:${root}:${maxDepth}`;
    const value = request.operation === "hash"
      ? cached(key, () => hashPath(root))
      : request.operation === "directories"
        ? cached(key, () => topLevelDirectories(root))
        : cached(key, () => {
          const result = scan(root, maxDepth);
          return { value: result.files, fingerprints: result.fingerprints };
        });
    parentPort?.postMessage({ id: request.id, value });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
