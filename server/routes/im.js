// Generic multi-IM bridge config API. Mirrors server/routes/dingtalk.js but is platform-parametric:
//
//   GET  /api/im/:platform/status — public; remote callers get only enabled+hasSecret+connection,
//                                   the local (admin) caller additionally gets plaintext secrets.
//   POST /api/im/:platform/config — loopback-only (!isLocal → 403); save creds, reload bridge.
//   POST /api/im/:platform/test   — loopback-only; validate creds (fetch an access token).
//
// :platform must be a known descriptor (im-config.js) — unknown → 404. The DingTalk surface keeps
// its own /api/dingtalk/* routes (back-compat); new platforms (feishu, …) use these generic ones.
import { getDescriptor, loadConfig, loadState, saveConfig } from '../lib/im-config.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const IM_RE = /^\/api\/im\/([a-z0-9_-]+)\/(status|config|test)$/;

/** Resolve a known platform id from the URL, or null (→ 404) for an unknown one. */
function platformOf(url) {
  const m = IM_RE.exec(url);
  if (!m) return null;
  return getDescriptor(m[1]) ? m[1] : null;
}

function imPredicate(verb, method) {
  return (url, m) => {
    if (m !== method) return false;
    const x = IM_RE.exec(url);
    return !!x && x[2] === verb;
  };
}

function notFound(res) {
  res.writeHead(404, JSON_HEADERS);
  res.end(JSON.stringify({ error: 'Unknown IM platform' }));
}

function secretKeys(id) {
  return getDescriptor(id).fields.filter((f) => f.type === 'secret').map((f) => f.key);
}

function readBody(req, deps, cb) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > deps.MAX_POST_BODY) req.destroy();
  });
  req.on('end', () => cb(body));
}

function imStatus(req, res, parsedUrl, isLocal, deps) {
  const id = platformOf(parsedUrl.pathname);
  if (!id) { notFound(res); return; }
  const conn = deps.im.getBridgeStatus(id);
  const state = loadState(id);
  res.writeHead(200, JSON_HEADERS);
  if (!isLocal) {
    // Loopback gate: a token-authorized LAN client must not see cred fields, the allowlist, the
    // bound conversation id, or raw error strings. Expose only what the header status chip needs.
    res.end(JSON.stringify({
      enabled: state.enabled,
      hasSecret: state.hasSecret,
      connection: { running: conn.running, connected: conn.connected },
    }));
    return;
  }
  // 本机(127.0.0.1)= admin：附带明文密钥供本人查阅/复制（镜像 DingTalk 的策略）。
  const cfg = loadConfig(id);
  const secrets = {};
  for (const k of secretKeys(id)) secrets[k] = cfg[k];
  res.end(JSON.stringify({ ...state, ...secrets, connection: conn }));
}

function imConfigPost(req, res, parsedUrl, isLocal, deps) {
  const id = platformOf(parsedUrl.pathname);
  if (!id) { notFound(res); return; }
  // Loopback-only: a secret must never be settable over the LAN even with a valid token.
  if (!isLocal) {
    res.writeHead(403, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'Loopback only' }));
    return;
  }
  readBody(req, deps, (body) => {
    let incoming;
    try { incoming = JSON.parse(body); }
    catch {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    // saveConfig normalizes to the descriptor's fields and preserves a stored secret when empty.
    saveConfig(id, incoming);
    // Apply immediately: stop the old connection and (re)start with the new config.
    Promise.resolve(deps.im.reloadBridge(id)).catch(() => {});
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ ...loadState(id), connection: deps.im.getBridgeStatus(id) }));
  });
}

function imTestPost(req, res, parsedUrl, isLocal, deps) {
  const id = platformOf(parsedUrl.pathname);
  if (!id) { notFound(res); return; }
  if (!isLocal) {
    res.writeHead(403, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'Loopback only' }));
    return;
  }
  readBody(req, deps, async (body) => {
    let incoming = {};
    try { incoming = body ? JSON.parse(body) : {}; } catch { /* fall back to stored */ }
    // Merge incoming over stored per descriptor field (empty secret → use the stored one).
    const stored = loadConfig(id);
    const cfg = {};
    for (const f of getDescriptor(id).fields) cfg[f.key] = incoming[f.key] || stored[f.key];
    // Validate the credential fields are present BEFORE hitting the network, so an empty form
    // yields "missing appId/botToken" instead of a cryptic adapter/transport error (mirrors the
    // DingTalk route). cred + secret are the credential field types; everything else is optional.
    const missing = getDescriptor(id).fields
      .filter((f) => (f.type === 'cred' || f.type === 'secret') && !cfg[f.key])
      .map((f) => f.key);
    if (missing.length) {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, detail: `missing ${missing.join('/')}` }));
      return;
    }
    const result = await deps.im.testConnection(id, cfg);
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(result));
  });
}

export const imRoutes = [
  { predicate: imPredicate('status', 'GET'), handler: imStatus },
  { predicate: imPredicate('config', 'POST'), handler: imConfigPost },
  { predicate: imPredicate('test', 'POST'), handler: imTestPost },
];
