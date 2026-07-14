// Local log management routes (moved verbatim from server.js handleRequest).
import { existsSync, realpathSync, statSync, createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { LOG_DIR } from '../../findcc.js';
import { _projectName, LOG_FILE, getAgentSpawnRegistrySnapshot, _v2Writer, _wireV2ReadEnabled } from '../interceptor.js';
import { listLocalLogs, listV2Logs, deleteLogFiles, validateLogPath, findPreviousSegment } from '../lib/log-management.js';
import { countLogEntries, streamRawEntriesAsync, readTailEntries, collectFilteredRawEntriesAsync } from '../lib/log-stream.js';
import { isTeammateLikeEntry } from '../lib/teammate-detect.js';
import { resolveWireV2Mode, resolveWireV2ReadEnabled, readWireV2Config, writeWireV2Config, WIRE_V2_UNLOCKED } from '../lib/v2/mode.js';
import { startConvert, stopConvert, convertStatus } from '../lib/v2/convert-manager.js';

async function localLogs(req, res, parsedUrl, isLocal, deps) {
  try {
    // 按当前实例 pid 硬隔离日志列表；`?all=1` 越过过滤看全部实例（顶部「显示全部」开关）。
    // `?v2=1`（S5）：列 v2 会话目录而非 v1 文件——弹窗「v2 会话列表」开关驱动，受读开关门控。
    const instanceId = (deps && deps.instanceId) || null;
    const showAll = parsedUrl?.searchParams?.get('all') === '1';
    const wantV2 = parsedUrl?.searchParams?.get('v2') === '1';
    if (wantV2 && !_wireV2ReadEnabled) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'v2 read path is disabled (enable dual-read mode or CCV_WIRE_V2_READ=1 and restart)' }));
      return;
    }
    const result = wantV2
      ? listV2Logs(LOG_DIR, _projectName, { instanceId, showAll })
      : await listLocalLogs(LOG_DIR, _projectName, { instanceId, showAll });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function downloadLog(req, res, parsedUrl) {
  const file = parsedUrl.searchParams.get('file');
  if (!file || file.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid file name' }));
    return;
  }
  // wire-v2 S5: rebuilt download for v2 sessions — the adapter stream as a v1
  // `.jsonl`. `format=raw` (session-dir zip) is the S6a half of the S0 contract.
  if (file.startsWith('v2:')) {
    if (!_wireV2ReadEnabled) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'v2 read path is disabled' }));
      return;
    }
    if (parsedUrl.searchParams.get('format') === 'raw') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'raw (zip) download for v2 sessions is not available yet' }));
      return;
    }
    try {
      const sessionDir = validateLogPath(LOG_DIR, file);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(`${basename(sessionDir)}.v2-rebuilt.jsonl`)}"`,
        'Transfer-Encoding': 'chunked',
      });
      await streamRawEntriesAsync(sessionDir, (raw) => {
        res.write(raw);
        res.write('\n---\n');
      });
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'ACCESS_DENIED' ? 403 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.end();
      }
    }
    return;
  }
  if (!file.endsWith('.jsonl')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid file type' }));
    return;
  }
  const filePath = join(LOG_DIR, file);
  try {
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }
    const realPath = realpathSync(filePath);
    const realLogDir = realpathSync(LOG_DIR);
    if (!realPath.startsWith(realLogDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access denied' }));
      return;
    }
    const format = parsedUrl.searchParams.get('format');
    const fileName = basename(file);
    // Delta storage: format=raw 下载原始文件；默认下载重建后的全量格式
    if (format === 'raw') {
      const stat = statSync(realPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        'Content-Length': stat.size,
      });
      const stream = createReadStream(realPath);
      stream.pipe(res);
    } else {
      // 流式下载原始条目（不重建，保持 delta 格式），避免 OOM
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        'Transfer-Encoding': 'chunked',
      });
      await streamRawEntriesAsync(realPath, (raw) => {
        res.write(raw);
        res.write('\n---\n');
      });
      res.end();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function localLog(req, res, parsedUrl) {
  const file = parsedUrl.searchParams.get('file');
  if (!file || file.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid file name' }));
    return;
  }

  // 验证文件类型：允许 .jsonl；S5 起在读开关下允许 v2 寻址（spec §12）
  const isV2Ref = file.startsWith('v2:');
  if (isV2Ref && !_wireV2ReadEnabled) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'v2 read path is disabled (enable dual-read mode or CCV_WIRE_V2_READ=1 and restart)' }));
    return;
  }
  if (!isV2Ref && !file.endsWith('.jsonl')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid file type. Only .jsonl files are allowed.' }));
    return;
  }

  try {
    // 独立 SSE 流：直接向请求方返回 event-stream，不走 /events 广播
    // v2 寻址时 validateLogPath 返回 session 目录绝对路径，log-stream 据此分派适配器
    const filePath = validateLogPath(LOG_DIR, file);
    const limitVal = Math.min(parseInt(parsedUrl.searchParams.get('limit'), 10) || 0, 500);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    if (limitVal > 0) {
      // 尾部加载模式：跳过 countLogEntries，只读文件末尾
      const { entries, hasMore, oldestTimestamp, estimatedTotal } = await readTailEntries(filePath, { limit: limitVal });
      res.write(`event: load_start\ndata: ${JSON.stringify({ total: estimatedTotal, incremental: false, hasMore, oldestTs: oldestTimestamp })}\n\n`);
      for (const raw of entries) {
        res.write('event: load_chunk\ndata: [');
        res.write(raw.includes('\n') ? raw.replace(/\n/g, '') : raw);
        res.write(']\n\n');
      }
    } else {
      // 全量加载模式（向后兼容）
      const total = await countLogEntries(filePath);
      res.write(`event: load_start\ndata: ${JSON.stringify({ total, incremental: false })}\n\n`);
      await streamRawEntriesAsync(filePath, (raw) => {
        res.write('event: load_chunk\ndata: [');
        res.write(raw.includes('\n') ? raw.replace(/\n/g, '') : raw);
        res.write(']\n\n');
      });
    }
    res.write(`event: load_end\ndata: {}\n\n`);
    res.end();
  } catch (err) {
    // 如果 headers 未发送，返回 JSON 错误；否则关闭连接
    // 落 stderr 让用户在 ccv 终端能看到具体原因（SSE onerror 在客户端
    // 不携带错误明细，只能从服务端日志反查）
    console.error('[local-log]', file, err && err.stack || err);
    if (!res.headersSent) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'ACCESS_DENIED' ? 403 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } else {
      res.end();
    }
  }
}

function deleteLogs(req, res, parsedUrl, isLocal, deps) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > deps.MAX_POST_BODY) req.destroy(); });
  req.on('end', () => {
    try {
      const { files } = JSON.parse(body);
      if (!Array.isArray(files) || files.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No files specified' }));
        return;
      }
      const results = deleteLogFiles(LOG_DIR, files);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
}

// Bounded head read: returns the parsed first frame of a live log file when it
// is a rotation-context sentinel, else null. Never scans past the first frame.
function readHeadRotationContext(file) {
  try {
    if (!file || !existsSync(file)) return null;
    const fd = openSync(file, 'r');
    let head;
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf-8', 0, n);
    } finally {
      closeSync(fd);
    }
    const frameEnd = head.indexOf('\n---\n');
    if (frameEnd <= 0) return null;
    const entry = JSON.parse(head.slice(0, frameEnd));
    return entry && entry.ccvRotationContext ? entry : null;
  } catch {
    return null;
  }
}

// Cheap substring gate evaluated before JSON.parse: every teammate shape
// carries at least one of these markers in its raw JSON (external tag,
// proxy-mode system marker, native SDK prompt). Giant MainAgent checkpoint
// frames are skipped without parsing.
function teammateRawPrefilter(raw) {
  return raw.includes('"teammate"')
    || raw.includes('agent in a team')
    || raw.includes('Agent Teammate Communication')
    || raw.includes('You are a Claude agent');
}

// Single-flight + short-TTL cache for the previous-segment scan. A real
// predecessor is ~300MB and the parse pass transiently costs hundreds of MB of
// RSS; every non-incremental cold load triggers the route, so concurrent
// viewers / rapid refreshes must share one scan. Keyed by path+size+mtime —
// the old segment can still GROW (external teammates keep appending to it),
// which changes the key and forces a rescan.
const PREV_SCAN_TTL_MS = 60 * 1000;
let _prevScanCache = null; // { key, promise, expiresAt }

function collectPrevSegmentCached(prev, predicate, opts) {
  let st = null;
  try { st = statSync(prev); } catch { }
  const key = `${prev}|${st ? st.size : 0}|${st ? st.mtimeMs : 0}`;
  const now = Date.now();
  if (_prevScanCache && _prevScanCache.key === key && _prevScanCache.expiresAt > now) {
    return _prevScanCache.promise;
  }
  const promise = collectFilteredRawEntriesAsync(prev, predicate, opts);
  _prevScanCache = { key, promise, expiresAt: now + PREV_SCAN_TTL_MS };
  promise.catch(() => {
    if (_prevScanCache && _prevScanCache.promise === promise) _prevScanCache = null;
  });
  return promise;
}

/**
 * Post-rotation teammate backfill. Resolves the previous segment of the
 * server's OWN live LOG_FILE (no client-supplied filenames — no traversal
 * surface) and streams NDJSON:
 *   line 1: { rotationContext, teammateNames }  (context; teammateNames merges
 *           the head sentinel's carry-forward with the in-process spawn
 *           registry — the sentinel may sit outside the client's load window)
 *   lines:  one backfill entry per line (teammate-like, renderable only)
 *   last:   { done: true, truncated, prevSegment }
 */
async function prevSegmentTeammates(req, res, parsedUrl, isLocal, deps) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  try {
    const current = LOG_FILE;
    const sentinel = readHeadRotationContext(current);
    const names = new Map(sentinel?.teammateNames?.filter((p) => Array.isArray(p) && p[0]) || []);
    for (const [prefix, name] of getAgentSpawnRegistrySnapshot()) names.set(prefix, name);
    res.write(JSON.stringify({
      rotationContext: sentinel ? { from: sentinel.from || null } : null,
      teammateNames: [...names.entries()],
    }) + '\n');
    // No live file (workspace pre-select) or resume placeholder → context only.
    if (!current || current.endsWith('_temp.jsonl')) {
      res.end(JSON.stringify({ done: true, truncated: false, prevSegment: null }) + '\n');
      return;
    }
    const instanceId = (deps && deps.instanceId) || null;
    const prev = findPreviousSegment(current, _projectName, instanceId);
    if (!prev) {
      res.end(JSON.stringify({ done: true, truncated: false, prevSegment: null }) + '\n');
      return;
    }
    const { entries, truncated } = await collectPrevSegmentCached(prev, (entry) => (
      !entry.inProgress && !entry.isHeartbeat && !entry.isCountTokens
      && !entry.ccvRotationContext
      && !(entry._deltaFormat && entry.mainAgent && !entry.teammate)
      && !!entry.timestamp
      && Array.isArray(entry.response?.body?.content) && entry.response.body.content.length > 0
      && isTeammateLikeEntry(entry)
    ), { rawPrefilter: teammateRawPrefilter });
    for (const entry of entries) res.write(JSON.stringify(entry) + '\n');
    res.end(JSON.stringify({ done: true, truncated, prevSegment: basename(prev) }) + '\n');
  } catch (err) {
    // Headers already sent — terminate the NDJSON stream with an error line.
    try { res.end(JSON.stringify({ done: true, error: err?.message || 'internal error' }) + '\n'); } catch { }
  }
}

// wire-v2 S4: startup-only mode switch backing the logs-modal toggle.
// GET returns the persisted + effective state; POST persists a new mode.
// The running process is NEVER reconfigured — the mode is read once at
// interceptor boot (server/lib/v2/mode.js), so responses carry the current
// process's boot-time resolution for the UI to explain "restart to apply".
function getWireV2Mode(req, res) {
  const resolved = resolveWireV2Mode(LOG_DIR);
  const cfg = readWireV2Config(LOG_DIR);
  const readResolved = resolveWireV2ReadEnabled(LOG_DIR);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    configMode: cfg.mode,
    // What THIS running process is actually doing (its boot-time resolution) —
    // resolveWireV2Mode re-reads the file, so after a toggle it describes the
    // NEXT boot, not the current one; _v2Writer.enabled is the ground truth
    // the UI needs to say "currently: X, pending: Y" honestly (review P1).
    running: _v2Writer.enabled ? (_wireV2ReadEnabled ? 'dual-read' : 'dual') : 'off',
    effective: resolved, // {mode, source} a fresh boot would resolve right now
    envOverride: resolved.source === 'env',
    // Read-path state (S5): same honesty split — what this process booted with
    // vs what a fresh boot would resolve. Its own env override (CCV_WIRE_V2_READ)
    // is independent from the write one (plan F9).
    readRunning: _wireV2ReadEnabled,
    readEffective: readResolved, // {enabled, source}
    readEnvOverride: readResolved.source === 'env',
    unlocked: WIRE_V2_UNLOCKED,
  }));
}

function postWireV2Mode(req, res, parsedUrl, isLocal, deps) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > deps.MAX_POST_BODY) req.destroy(); });
  req.on('end', () => {
    try {
      const { mode } = JSON.parse(body);
      writeWireV2Config(LOG_DIR, mode);
      const resolved = resolveWireV2Mode(LOG_DIR);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode, envOverride: resolved.source === 'env' }));
    } catch (err) {
      const status = (err && (err.code === 'UNKNOWN_MODE' || err.code === 'LOCKED_MODE')) ? 400 : (err instanceof SyntaxError ? 400 : 500);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'internal error' }));
    }
  });
}

// wire-v2 S8: one-click v1→v2 migration of the CURRENT project, run by the
// resident convert-manager worker. GET = status snapshot for the modal's
// polling; POST {action:'start'|'stop'} controls the task. Same exposure
// posture as postWireV2Mode (local/LAN, existing auth middleware).
function getWireV2Convert(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(convertStatus(LOG_DIR, _projectName || '')));
}

function postWireV2Convert(req, res, parsedUrl, isLocal, deps) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > deps.MAX_POST_BODY) req.destroy(); });
  req.on('end', () => {
    try {
      const { action } = JSON.parse(body || '{}');
      if (action !== 'start' && action !== 'stop') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'action must be "start" or "stop"' }));
        return;
      }
      if (action === 'start' && !_projectName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no active project' }));
        return;
      }
      const result = action === 'start' ? startConvert(LOG_DIR, _projectName) : stopConvert();
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.ok ? { ok: true } : { error: result.error }));
    } catch (err) {
      const status = err instanceof SyntaxError ? 400 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'internal error' }));
    }
  });
}

export const logsRoutes = [
  { method: 'GET', match: 'exact', path: '/api/local-logs', handler: localLogs },
  { method: 'GET', match: 'exact', path: '/api/wire-v2-mode', handler: getWireV2Mode },
  { method: 'POST', match: 'exact', path: '/api/wire-v2-mode', handler: postWireV2Mode },
  { method: 'GET', match: 'exact', path: '/api/wire-v2-convert', handler: getWireV2Convert },
  { method: 'POST', match: 'exact', path: '/api/wire-v2-convert', handler: postWireV2Convert },
  { method: 'GET', match: 'exact', path: '/api/download-log', handler: downloadLog },
  { method: 'GET', match: 'exact', path: '/api/local-log', handler: localLog },
  { method: 'POST', match: 'exact', path: '/api/delete-logs', handler: deleteLogs },
  { method: 'GET', match: 'exact', path: '/api/prev-segment-teammates', handler: prevSegmentTeammates },
];
