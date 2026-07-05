// Local log management routes (moved verbatim from server.js handleRequest).
import { existsSync, realpathSync, statSync, createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { LOG_DIR } from '../../findcc.js';
import { _projectName, LOG_FILE, getAgentSpawnRegistrySnapshot } from '../interceptor.js';
import { listLocalLogs, deleteLogFiles, mergeLogFiles, archiveLogFiles, validateLogPath, findPreviousSegment } from '../lib/log-management.js';
import { countLogEntries, streamRawEntriesAsync, readTailEntries, collectFilteredRawEntriesAsync } from '../lib/log-stream.js';
import { isTeammateLikeEntry } from '../lib/teammate-detect.js';

async function localLogs(req, res, parsedUrl, isLocal, deps) {
  try {
    // 按当前实例 pid 硬隔离日志列表；`?all=1` 越过过滤看全部实例（顶部「显示全部」开关）。
    const instanceId = (deps && deps.instanceId) || null;
    const showAll = parsedUrl?.searchParams?.get('all') === '1';
    const result = await listLocalLogs(LOG_DIR, _projectName, { instanceId, showAll });
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
  if (!file.endsWith('.jsonl') && !file.endsWith('.jsonl.zip')) {
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
    // 默认下载重建后的 .jsonl；raw 下载原始字节（.zip 或 .jsonl 视实际而定）
    const fileName = (format !== 'raw' && file.endsWith('.jsonl.zip'))
      ? basename(file).slice(0, -4)
      : basename(file);
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

  // 验证文件类型：允许 .jsonl 或 .jsonl.zip
  if (!file.endsWith('.jsonl') && !file.endsWith('.jsonl.zip')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid file type. Only .jsonl(.zip) files are allowed.' }));
    return;
  }

  try {
    // 独立 SSE 流：直接向请求方返回 event-stream，不走 /events 广播
    validateLogPath(LOG_DIR, file);
    const filePath = join(LOG_DIR, file);
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
    // 落 stderr 让用户在 ccv 终端能看到 .jsonl.zip 解压失败等具体原因（SSE onerror 在客户端
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

function mergeLogs(req, res, parsedUrl, isLocal, deps) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > deps.MAX_POST_BODY) req.destroy(); });
  req.on('end', async () => {
    try {
      const { files } = JSON.parse(body);
      const merged = await mergeLogFiles(LOG_DIR, files);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, merged }));
    } catch (err) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'INVALID_INPUT' ? 400 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function archiveLogs(req, res, parsedUrl, isLocal, deps) {
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
      if (files.length > 50) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many files (max 50 per request)' }));
        return;
      }
      const result = archiveLogFiles(LOG_DIR, files);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
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

export const logsRoutes = [
  { method: 'GET', match: 'exact', path: '/api/local-logs', handler: localLogs },
  { method: 'GET', match: 'exact', path: '/api/download-log', handler: downloadLog },
  { method: 'GET', match: 'exact', path: '/api/local-log', handler: localLog },
  { method: 'POST', match: 'exact', path: '/api/delete-logs', handler: deleteLogs },
  { method: 'POST', match: 'exact', path: '/api/merge-logs', handler: mergeLogs },
  { method: 'POST', match: 'exact', path: '/api/archive-logs', handler: archiveLogs },
  { method: 'GET', match: 'exact', path: '/api/prev-segment-teammates', handler: prevSegmentTeammates },
];
