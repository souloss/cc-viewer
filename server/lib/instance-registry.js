// Passive registry of instance ids (`--pid`) used per project — a memory aid only.
//
// On startup with `--pid X`, the server appends X to `{projectDir}/.instances.json` so the
// CLI banner can remind the user which ids they've used ("history: alpha, beta") next time.
// This is NOT a liveness / auto-numbering registry: entries are never probed or auto-assigned,
// just remembered (deduped, most-recent-last, capped). `logDir` is the per-project dir;
// '' (no active project) → record no-ops / list returns [].
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { renameSyncWithRetry } from './file-api.js';
import { withFileLockAsync } from './async-file-lock.js';
import { sanitizeInstanceId } from './session-pin-store.js';

const MAX_INSTANCES = 50; // cap the list; oldest entries drop off (memory aid, not an audit log)

function instancesFile(logDir) { return join(logDir, '.instances.json'); }

function readListRaw(logDir) {
  try {
    const file = instancesFile(logDir);
    if (!existsSync(file)) return [];
    const arr = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : [];
  } catch { return []; }
}

/** Previously-used instance ids for this project, oldest → newest. No project → []. */
export function listInstances(logDir) {
  if (!logDir) return [];
  return readListRaw(logDir);
}

/**
 * Record an instance id: dedupe (move-to-end so "most recent" wins), cap at MAX_INSTANCES.
 * Cross-process safe via the shared async file lock + atomic tmp→rename. No project /
 * empty id → no-op.
 */
export async function recordInstance(logDir, instanceId) {
  if (!logDir) return;
  const id = sanitizeInstanceId(instanceId);
  if (!id) return;
  await withFileLockAsync(join(logDir, '.instances.lock'), () => {
    const list = readListRaw(logDir).filter((x) => x !== id);
    list.push(id);
    while (list.length > MAX_INSTANCES) list.shift();
    const file = instancesFile(logDir);
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tmp, JSON.stringify(list));
      renameSyncWithRetry(tmp, file);
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      throw err;
    }
  }, { ensureDir: logDir });
}
