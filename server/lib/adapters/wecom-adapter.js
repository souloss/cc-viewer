// 企业微信 (WeCom) adapter — the platform-specific half of the WeCom bridge. The generic
// orchestration (dedup, access control, queue, inject, chunk, turn-end reply) lives in
// server/lib/im-bridge-core.js; this module only knows WeCom's smart-robot long-connection client,
// inbound frame shape, and outbound send.
//
// Uses the 企业微信智能机器人长连接 (Smart Robot long-connection) mode via @wecom/aibot-node-sdk:
// an OUTBOUND WebSocket (wss://openws.work.weixin.qq.com) authed with botId + secret — so it works
// on loopback with no public URL, no trusted-IP whitelist, and no WXBizMsgCrypt in our code (the
// SDK handles auth/heartbeat/reconnect). Replies use the proactive sendMessage (our reply lands
// ~10s after the turn, well past the 5s synchronous reply window; the 24h proactive window covers it).
//
// Console prerequisite (no code equivalent — surfaced in the UI help/README): create a 智能机器人,
// set its API 接收模式 to 长连接, copy the botId + secret, and add the bot to a chat.
import { registerAdapter } from '../im-bridge-core.js';

// ─── test seam: a fake SDK factory (zero real SDK / socket) ───
let sdkFactory = null;
export function __setClientFactory(fn) { sdkFactory = fn; }

async function loadSdk() {
  if (sdkFactory) return sdkFactory();
  return import('@wecom/aibot-node-sdk');
}
function resolveWSClient(mod) {
  const ns = mod.default ?? mod;
  return ns.WSClient ?? mod.WSClient;
}

const CONNECT_PROBE_MS = 12_000; // internal connect guard (< core CONNECT_TIMEOUT_MS) to avoid a leaked reconnect loop
const TEST_PROBE_MS = 8_000;

/** Normalize a WeCom `message.text` WsFrame into the core's inbound shape. Returns null for an
 *  unusable frame (the core skips it). */
function normalizeInbound(frame) {
  const b = frame?.body;
  if (!b) return null;
  const isGroup = b.chattype === 'group';
  const senderId = b.from?.userid || '';
  const receiveId = isGroup ? b.chatid : senderId; // group → chatid, single → sender userid
  // A group frame missing chatid (chatid is optional in the SDK types) has no reply target — drop
  // it rather than bind/send to undefined.
  if (!receiveId) return null;
  return {
    text: b.text?.content ?? '',
    conversationId: receiveId,
    isGroup,
    senderId,
    msgId: b.msgid,
    target: { conversationId: receiveId, receiveId },
  };
}

const wecomAdapter = {
  id: 'wecom',
  i18nNs: 'server.wecom',
  allowListField: 'allowUserIds',
  capabilities: { inboundAck: false },
  // WeCom proactive-push limit is 30/min·1000/hr per conversation; cap conservatively.
  rateLimit: { max: 30, windowMs: 60_000 },

  hasCreds(cfg) { return !!(cfg.botId && cfg.secret); },
  statusFields(cfg) { return { botIdTail: cfg?.botId?.slice(-4) || '' }; },

  async connect(cfg, hooks, ctx) {
    const mod = await loadSdk();
    const WSClient = resolveWSClient(mod);
    const client = new WSClient({ botId: cfg.botId, secret: cfg.secret });
    ctx.store.client = client; // single client for inbound + outbound (sendOne reads it)
    client.on('message.text', (frame) => hooks.onInbound(normalizeInbound(frame), null));
    // connect() is synchronous; resolve once the WS handshake authenticates so the core's
    // `connected` flag and CONNECT_TIMEOUT_MS race are meaningful (bad creds → lastError, not a
    // false "connected"). Reject (and tear down) on error or an internal timeout.
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { client.disconnect(); } catch { /* best-effort */ }
        reject(new Error('connect timeout'));
      }, CONNECT_PROBE_MS);
      if (typeof timer.unref === 'function') timer.unref();
      client.on('authenticated', () => { if (settled) return; settled = true; clearTimeout(timer); resolve(client); });
      client.on('error', (e) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        // Tear down before rejecting — else the SDK keeps auto-reconnecting/retrying auth in the
        // background even though the bridge reports not-running.
        try { client.disconnect(); } catch { /* best-effort */ }
        reject(new Error(String(e?.message || e)));
      });
      client.connect();
    });
  },

  async disconnect(client, ctx) {
    try { client?.removeAllListeners?.(); } catch { /* best-effort */ }
    try { client?.disconnect?.(); } catch { /* best-effort */ }
    if (ctx?.store) ctx.store.client = null;
  },

  // Long-connection has no app-level inbound ACK (the SDK handles transport); rely on msgid dedup.
  ack() { /* no-op */ },

  async sendOne(cfg, target, content, ctx) {
    const client = ctx.store.client;
    if (!client) throw new Error('wecom client not connected');
    const res = await client.sendMessage(target.receiveId, { msgtype: 'markdown', markdown: { content } });
    if (res && typeof res.errcode === 'number' && res.errcode !== 0) {
      throw new Error(`send ${res.errcode}: ${res.errmsg || 'failed'}`);
    }
  },

  async testConnection(cfg) {
    // No REST validate endpoint exists for the smart-robot mode — auth is in the WS handshake. Open
    // a throwaway probe and wait for 'authenticated'. NOTE: WeCom allows one connection per bot, so
    // testing while the live bridge is connected to the same bot briefly kicks it (the bridge then
    // auto-reconnects). maxReconnectAttempts:0 keeps the probe from spinning a backoff loop.
    let client;
    try {
      const mod = await loadSdk();
      const WSClient = resolveWSClient(mod);
      client = new WSClient({ botId: cfg.botId, secret: cfg.secret, maxReconnectAttempts: 0 });
    } catch (e) {
      return { ok: false, detail: String(e?.message || e) };
    }
    return await new Promise((resolve) => {
      let settled = false;
      const done = (res) => {
        if (settled) return;
        settled = true;
        try { client.removeAllListeners?.(); } catch { /* best-effort */ }
        try { client.disconnect?.(); } catch { /* best-effort */ }
        resolve(res);
      };
      const timer = setTimeout(() => done({ ok: false, detail: 'timeout' }), TEST_PROBE_MS);
      if (typeof timer.unref === 'function') timer.unref();
      client.on('authenticated', () => { clearTimeout(timer); done({ ok: true }); });
      client.on('error', (e) => { clearTimeout(timer); done({ ok: false, detail: String(e?.message || e) }); });
      try { client.connect(); } catch (e) { clearTimeout(timer); done({ ok: false, detail: String(e?.message || e) }); }
    });
  },
};

registerAdapter(wecomAdapter);

export default wecomAdapter;
