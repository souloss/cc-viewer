// Wire Format v2 — on-disk layout contract (docs/refactor/WIRE_FORMAT_V2.md §2/§3).
//
// Single owner of every v2 path: nothing outside this module joins path segments
// into a session directory. All directory creation is SYNCHRONOUS on purpose —
// an async mkdir would lose the race against AsyncWriteQueue's microtask drain
// and the swallowed ENOENT would silently drop v2 lines (plan risk F2).

import { mkdirSync, writeFileSync, renameSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';

// Path-component whitelist (spec §2): anything outside [a-zA-Z0-9._-] is replaced
// with '_'; empty / dot-only results are rejected to '_'. Guards convKey /
// sessionId derived from wire content against path injection (plan risk F14).
export function sanitizePathComponent(name) {
  const cleaned = String(name == null ? '' : name).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (cleaned === '' || /^\.+$/.test(cleaned)) return '_';
  return cleaned;
}

/** All absolute paths of one session directory, derived once and passed around. */
export function sessionPaths(logDir, project, sessionId) {
  const dir = join(logDir, sanitizePathComponent(project), 'sessions', sanitizePathComponent(sessionId));
  return {
    dir,
    metaPath: join(dir, 'meta.json'),
    journalPath: join(dir, 'journal.jsonl'),
    responsesPath: join(dir, 'responses.jsonl'),
    conversationsDir: join(dir, 'conversations'),
    blobsDir: join(dir, 'blobs'),
  };
}

export function convEpochPath(paths, convKey, epoch) {
  return join(paths.conversationsDir, sanitizePathComponent(convKey), `e${epoch}.jsonl`);
}

export function convDir(paths, convKey) {
  return join(paths.conversationsDir, sanitizePathComponent(convKey));
}

export function blobPath(paths, ref) {
  // ref is produced by blob-store ('sha256-<hex16>') but sanitize anyway — the
  // reader side may feed refs parsed back from journal lines.
  return join(paths.blobsDir, `${sanitizePathComponent(ref)}.json`);
}

/**
 * Atomic small-file write: tmp → fsync → rename. Used for meta.json and blobs —
 * the two file kinds whose partial content must never be observable (spec §3/§7).
 * fsync is deliberate: blobs are the durability barrier of the write-order
 * protocol (blob → conversation → journal), see spec §1.3.
 */
export function writeFileAtomicSync(finalPath, data) {
  const tmp = `${finalPath}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, finalPath);
}

/**
 * Create the session directory skeleton + meta.json + the journal self-describing
 * first line, idempotently. Must be called (synchronously) before any enqueue
 * targeting this session. Returns the paths object.
 *
 * meta: { wireFormat:2, sessionId, project, instanceId, pid, startTs, userIdRaw,
 *         userIdEncoding, leader?, im? } — spec §3. Existing meta is never
 * rewritten here (later additive updates go through updateMetaSync).
 */
export function ensureSessionDirSync(logDir, project, sessionId, meta = {}) {
  const paths = sessionPaths(logDir, project, sessionId);
  mkdirSync(paths.conversationsDir, { recursive: true });
  mkdirSync(paths.blobsDir, { recursive: true });
  if (!existsSync(paths.metaPath)) {
    // `...meta` first: identity fields below must win even if a caller ever
    // passes overlapping keys (defensive — current callers pass none of them).
    const record = {
      ...meta,
      wireFormat: 2,
      sessionId,
      project,
      startTs: meta.startTs || new Date().toISOString(),
    };
    writeFileAtomicSync(paths.metaPath, JSON.stringify(record, null, 2) + '\n');
  }
  if (!existsSync(paths.journalPath)) {
    // Journal sentinel first frame — must exist atomically at creation (same
    // hazard as the v1 rotation sentinel: a watcher may read the file the
    // instant it appears). 'wx' create-exclusive keeps a concurrent creator
    // from double-writing the sentinel.
    const sentinel = JSON.stringify({ ph: 'meta', wireFormat: 2, sessionId }) + '\n';
    try {
      writeFileSync(paths.journalPath, sentinel, { flag: 'wx' });
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
    }
  }
  return paths;
}

/** Ensure a conversation subdirectory exists (before first enqueue to it). */
export function ensureConvDirSync(paths, convKey) {
  const dir = convDir(paths, convKey);
  mkdirSync(dir, { recursive: true });
  return dir;
}
