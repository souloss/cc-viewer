import { existsSync, realpathSync, unlinkSync, readdirSync } from 'node:fs';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join, sep, dirname, basename } from 'node:path';
import { reconstructEntries } from './delta-reconstructor.js';
import { logFileMatcher } from './interceptor-core.js';
import { sanitizePathComponent } from './v2/layout.js';
import { listV2Sessions } from './v2/adapter.js';

// wire-v2 S5 addressing (spec §12): 'v2:<project>/<session_id>' in every
// existing ?file= parameter slot. Components must survive the same whitelist
// the writer used to create them — anything else (.., separators, empty) is
// rejected before a single path join happens.
export const V2_REF_RE = /^v2:([^/]+)\/([^/]+)$/;

/** Parse a v2 addressing string → { project, sessionId } or null. */
export function parseV2Ref(file) {
  const m = typeof file === 'string' ? file.match(V2_REF_RE) : null;
  if (!m) return null;
  if (m[1] !== sanitizePathComponent(m[1]) || m[2] !== sanitizePathComponent(m[2])) return null;
  return { project: m[1], sessionId: m[2] };
}

export function validateLogPath(logDir, file) {
  // v2 branch: strip the prefix, then the realpath must land inside
  // LOG_DIR/<project>/sessions/<session_id>/ (spec §12). Returns the absolute
  // session DIRECTORY — log-stream's generators dispatch on it.
  if (typeof file === 'string' && file.startsWith('v2:')) {
    const ref = parseV2Ref(file);
    if (!ref) {
      const err = new Error('Invalid v2 log reference');
      err.code = 'ACCESS_DENIED';
      throw err;
    }
    const dir = join(logDir, ref.project, 'sessions', ref.sessionId);
    if (!existsSync(join(dir, 'journal.jsonl'))) {
      const err = new Error('File not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const realPath = realpathSync(dir);
    const realLogDir = realpathSync(logDir);
    if (!realPath.startsWith(realLogDir + sep)) {
      const err = new Error('Access denied');
      err.code = 'ACCESS_DENIED';
      throw err;
    }
    return realPath;
  }
  const filePath = join(logDir, file);
  if (!existsSync(filePath)) {
    const err = new Error('File not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const realPath = realpathSync(filePath);
  const realLogDir = realpathSync(logDir);
  if (realPath !== realLogDir && !realPath.startsWith(realLogDir + sep)) {
    const err = new Error('Access denied');
    err.code = 'ACCESS_DENIED';
    throw err;
  }
  return realPath;
}

export function isLogFileName(name) {
  return name.endsWith('.jsonl');
}

// 解析日志文件名里的时间戳 `YYYYMMDD_HHMMSS`（带不带 `<pid>__` 前缀都适用）。
// 用于「按时间排序 / 判最新」——文件名整串排序会把 `<pid>__` 前缀（'1' < 'c'）的最新文件排到最底，
// 必须按时间戳排。无法解析时返回 ''（排到最后）。listLocalLogs / v2 convert 共用，防漂移。
export function parseLogTs(name) {
  const m = name.match(/_(\d{8}_\d{6})\.jsonl$/);
  return m ? m[1] : '';
}

// instanceId / showAll 为可选项（默认 null / false = 现状的反面：硬隔离）：
//  - instanceId 非空：只列本实例 `<pid>__<project>_…` 的日志；
//  - instanceId 空：只列无标签 `<project>_…` 日志（排除任何 `<pid>__` 文件）；
//  - showAll=true：越过上面的归属过滤，列出目录下全部日志（顶部「显示全部」开关用）。
// 复用 interceptor-core 的 logFileMatcher（与写入端共用，防命名漂移）。第 3 参可选 → 旧 2 参调用零改动。
export async function listLocalLogs(logDir, currentProjectName, { instanceId = null, showAll = false } = {}) {
  const grouped = {};
  if (!existsSync(logDir)) return { ...grouped, _currentProject: currentProjectName || '' };

  const entries = await readdir(logDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = entry.name;
    const projectDir = join(logDir, project);
    // 单个项目目录读失败（权限 / 被并发删除 / EMFILE 等）只跳过该项目，不拖垮整个列表。
    try {
      const owns = logFileMatcher(project, instanceId);
      const files = (await readdir(projectDir)).filter(isLogFileName);
      let statsFiles = null;
      try {
        const statsFile = join(projectDir, `${project}.json`);
        if (existsSync(statsFile)) {
          statsFiles = JSON.parse(await readFile(statsFile, 'utf-8')).files;
        }
      } catch { }
      for (const f of files) {
        if (!showAll && !owns(f)) continue;
        const match = f.match(/^(.+?)_(\d{8}_\d{6})\.jsonl$/);
        if (!match) continue;
        const ts = match[2];
        // 从前缀解析归属实例 id 用于行内 badge：`<pid>__<project>` → pid；`<project>` → 无（null）。
        // 项目名自身可含下划线，故用 endsWith('__'+project) 精确剥离，而非按 '__' split。
        const g1 = match[1];
        const fileInstanceId = (g1 !== project && g1.endsWith('__' + project))
          ? g1.slice(0, -(project.length + 2))
          : null;
        const filePath = join(projectDir, f);
        let size;
        try { size = (await stat(filePath)).size; } catch { continue; }
        if (size === 0) continue;
        const stats = statsFiles?.[f] || null;
        const turns = stats?.summary?.sessionCount || 0;
        if (!grouped[project]) grouped[project] = [];
        grouped[project].push({ file: `${project}/${f}`, timestamp: ts, size, turns, preview: stats?.preview || [], instanceId: fileInstanceId });
      }
      // 按时间戳降序（文件名降序兜底，处理同秒 tie，保证确定性）。
      // 不能再依赖文件名整串排序：`<pid>__` 前缀会把最新日志排到最底。
      if (grouped[project]) {
        grouped[project].sort((a, b) =>
          b.timestamp.localeCompare(a.timestamp) || b.file.localeCompare(a.file));
      }
    } catch (err) {
      console.error(`[CC Viewer] listLocalLogs: 跳过无法读取的项目 ${project}:`, err?.message || err);
      continue;
    }
  }
  return { ...grouped, _currentProject: currentProjectName || '' };
}

// meta.startTs (ISO) → the v1 list's compact local-time stamp 'YYYYMMDD_HHMMSS'
// so formatTimestamp / the desc sort work on v2 items unchanged.
function compactLocalTs(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * wire-v2 S5: the v2 counterpart of listLocalLogs — one item per session dir,
 * addressed as `v2:<project>/<sid>` (spec §12), same grouped output shape so
 * the frontend log table renders it unchanged. Ownership filtering uses
 * meta.instanceId (the successor of the v1 `<pid>__` filename prefix): the
 * default instance (null) owns untagged sessions, a --pid instance owns its
 * own — exact parity with logFileMatcher semantics. Teammate sessions
 * (meta.leader present) are NOT listed: the adapter re-joins them into their
 * leader's stream, so a separate row would double-show that traffic.
 */
export function listV2Logs(logDir, currentProjectName, { instanceId = null, showAll = false } = {}) {
  const grouped = {};
  if (!existsSync(logDir)) return { ...grouped, _currentProject: currentProjectName || '' };
  for (const entry of readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const project = entry.name;
    try {
      for (const s of listV2Sessions(join(logDir, project))) {
        if (s.leader) continue;
        if (!showAll && (s.instanceId ?? null) !== (instanceId ?? null)) continue;
        if (s.size === 0) continue;
        if (!grouped[project]) grouped[project] = [];
        grouped[project].push({
          file: `v2:${project}/${s.sid}`,
          kind: 'v2',
          timestamp: compactLocalTs(s.startTs),
          size: s.size,
          turns: s.turns,
          preview: s.preview ? [s.preview] : [],
          instanceId: s.instanceId,
        });
      }
      if (grouped[project]) {
        grouped[project].sort((a, b) =>
          b.timestamp.localeCompare(a.timestamp) || b.file.localeCompare(a.file));
      }
    } catch (err) {
      console.error(`[CC Viewer] listV2Logs: 跳过无法读取的项目 ${project}:`, err?.message || err);
      continue;
    }
  }
  return { ...grouped, _currentProject: currentProjectName || '' };
}

/**
 * Locate the log segment immediately preceding currentFile in the same
 * directory, for the post-rotation teammate backfill. Ownership is enforced
 * via logFileMatcher(projectName, instanceId) — a naive "older file in the
 * same dir" scan would cross --pid instances and return another
 * conversation's log. Returns the
 * absolute path, or null when there is no strictly-older owned segment.
 */
export function findPreviousSegment(currentFile, projectName, instanceId = null) {
  try {
    if (!currentFile || !projectName) return null;
    const dir = dirname(currentFile);
    const currentTs = parseLogTs(basename(currentFile));
    if (!currentTs || !existsSync(dir)) return null;
    const owns = logFileMatcher(projectName, instanceId);
    let best = null;
    let bestTs = '';
    for (const f of readdirSync(dir)) {
      if (!isLogFileName(f) || !owns(f)) continue;
      const ts = parseLogTs(f);
      if (!ts || ts >= currentTs) continue;
      if (ts > bestTs || (ts === bestTs && best !== null && f > basename(best))) {
        best = join(dir, f);
        bestTs = ts;
      }
    }
    return best;
  } catch {
    return null;
  }
}

// v1 `.jsonl` ONLY — a `v2:` ref would validate but then mis-join below;
// v2 reads go through log-stream's session-dir dispatch, never this helper.
export async function readLocalLog(logDir, file) {
  const realPath = validateLogPath(logDir, file);
  if (file.startsWith('v2:')) {
    const err = new Error('readLocalLog does not support v2 refs');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  const filePath = realPath;
  const content = await readFile(filePath, 'utf-8');
  const parsed = content.split('\n---\n').filter(line => line.trim()).map(entry => {
    try { return JSON.parse(entry); } catch { return null; }
  }).filter(Boolean);
  const map = new Map();
  for (const entry of parsed) {
    const key = `${entry.timestamp}|${entry.url}`;
    map.set(key, entry);
  }
  return reconstructEntries(Array.from(map.values()));
}

export function deleteLogFiles(logDir, files) {
  const results = [];
  for (const file of files) {
    if (!file || file.includes('..') || !isLogFileName(file)) {
      results.push({ file, error: 'Invalid file name' });
      continue;
    }
    const filePath = join(logDir, file);
    try {
      if (!existsSync(filePath)) {
        results.push({ file, error: 'Not found' });
        continue;
      }
      const realPath = realpathSync(filePath);
      const realLogDir = realpathSync(logDir);
      if (realPath !== realLogDir && !realPath.startsWith(realLogDir + sep)) {
        results.push({ file, error: 'Access denied' });
        continue;
      }
      unlinkSync(realPath);
      results.push({ file, ok: true });
    } catch (err) {
      results.push({ file, error: err.message });
    }
  }
  return results;
}
