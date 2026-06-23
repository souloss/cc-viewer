// Server-side "current session" pin — replaces the old per-browser localStorage pin so a
// project's "仅展示当前会话" pointer is shared across every device hitting THIS ccv process,
// and (with `--pid`) isolated between processes. View state only → no loopback gating.
//   - GET  /api/session-pin                                  → { pinnedSessionId, instanceId }
//   - POST /api/session-pin {pinnedSessionId: string|null}   → persist + SSE-broadcast
// `_logDir` is the live per-project dir ('' = no active project → GET null / POST no-op).
import { _logDir } from '../interceptor.js';
import { readPin, writePin } from '../lib/session-pin-store.js';
import { sendEventToClients } from '../lib/log-watcher.js';

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function getHandler(req, res, parsedUrl, isLocal, deps) {
  const instanceId = deps.instanceId || null;
  sendJson(res, 200, { pinnedSessionId: readPin(_logDir, instanceId), instanceId });
}

function postHandler(req, res, parsedUrl, isLocal, deps) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > deps.MAX_POST_BODY) req.destroy(); });
  req.on('end', () => {
    let incoming;
    try { incoming = body ? JSON.parse(body) : {}; }
    catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
    const raw = incoming.pinnedSessionId;
    const pinnedSessionId = (typeof raw === 'string' && raw) ? raw : null;
    writePin(_logDir, deps.instanceId || null, pinnedSessionId);
    // Broadcast to THIS process's SSE clients so every device on this instance stays in sync.
    sendEventToClients(deps.clients, 'session_pin', { pinnedSessionId });
    sendJson(res, 200, { ok: true, pinnedSessionId });
  });
  req.on('error', () => { try { sendJson(res, 400, { error: 'read-error' }); } catch {} });
}

export const sessionPinRoutes = [
  { method: 'GET', match: 'exact', path: '/api/session-pin', handler: getHandler },
  { method: 'POST', match: 'exact', path: '/api/session-pin', handler: postHandler },
];
