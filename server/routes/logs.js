// Local log management routes (moved verbatim from server.js handleRequest).
import { existsSync, realpathSync, statSync, createReadStream } from 'node:fs';
import { join, basename } from 'node:path';
import { LOG_DIR } from '../../findcc.js';
import { _projectName, _v2Writer } from '../interceptor.js';
import { listV2Logs, listLocalLogs, countListedV1Files, deleteLogFiles, validateLogPath } from '../lib/log-management.js';
import { countLogEntries, streamRawEntriesAsync, readTailEntries } from '../lib/log-stream.js';
import { startConvert, stopConvert, convertStatus } from '../lib/v2/convert-manager.js';
import { migrationStatus } from '../lib/v2/migrate-prompt.js';

async function localLogs(req, res, parsedUrl, isLocal, deps) {
  try {
    // 1.7.0: the DEFAULT list is v2 sessions, unconditionally. `?view=v1`
    // serves the legacy-file list for the modal's v1 view (list + migrate +
    // open + delete for leftovers the converter never removes).
    if (parsedUrl?.searchParams?.get('view') === 'v1') {
      const v1 = await listLocalLogs(LOG_DIR, _projectName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(v1));
      return;
    }
    const result = listV2Logs(LOG_DIR, _projectName);
    // Legacy v1 files are not in this list — surface two distinct signals:
    //  - _v1FileCount: v1 files ON DISK (gates the v1-view entry link; the
    //    converter never deletes sources, so this outlives a finished migration)
    //  - _unmigratedV1Count/Bytes: files still AWAITING migration (gates the
    //    migrate button + hint inside the v1 view and the startup prompt)
    const mig = migrationStatus(LOG_DIR, _projectName || '');
    result._unmigratedV1Count = mig.files;
    result._unmigratedV1Bytes = mig.totalBytes;
    result._v1FileCount = _projectName ? countListedV1Files(join(LOG_DIR, _projectName)) : 0;
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

  // 验证文件类型：v2 寻址（spec §12）；直连 .jsonl 保留为未迁移日志的逃生舱
  // （代码与转换器共享，UI 无入口——1.7.0 决策）。
  const isV2Ref = file.startsWith('v2:');
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
      const results = deleteLogFiles(LOG_DIR, files, { liveSessionDir: _v2Writer.currentSessionDir() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
}

// wire-v2 S8: one-click v1→v2 migration of the CURRENT project, run by the
// resident convert-manager worker. GET = status snapshot for the modal's
// polling; POST {action:'start'|'stop'} controls the task. Local/LAN exposure
// via the existing auth middleware (same posture as delete-logs).
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
  { method: 'GET', match: 'exact', path: '/api/wire-v2-convert', handler: getWireV2Convert },
  { method: 'POST', match: 'exact', path: '/api/wire-v2-convert', handler: postWireV2Convert },
  { method: 'GET', match: 'exact', path: '/api/download-log', handler: downloadLog },
  { method: 'GET', match: 'exact', path: '/api/local-log', handler: localLog },
  { method: 'POST', match: 'exact', path: '/api/delete-logs', handler: deleteLogs },
];
