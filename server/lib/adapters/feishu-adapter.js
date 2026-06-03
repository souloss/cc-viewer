// Feishu/Lark adapter — the platform-specific half of the Feishu bridge. The generic
// orchestration (dedup, access control, queue, inject, chunk, turn-end reply) lives in
// server/lib/im-bridge-core.js; this module only knows Feishu's WebSocket long-connection event
// client, inbound payload shape, and outbound send.
//
// Inbound uses the official SDK's WSClient long-connection (NOT a webhook) so it works on
// loopback with no public URL — mirroring how DingTalk uses dingtalk-stream. The SDK's
// Lark.Client auto-acquires & caches the tenant_access_token for outbound, so (unlike DingTalk)
// we never hand-roll an outbound token; testConnection is the only place that fetches one by hand.
//
// Console prerequisite (no code equivalent — surfaced to the user in the UI/README): the custom
// app must set Event Subscription to "long connection", subscribe `im.message.receive_v1`, grant
// the `im:message` send scope, and be published.
import { registerAdapter } from '../im-bridge-core.js';

// ─── test seam: a fake SDK factory ({ Client, WSClient, EventDispatcher, Domain, LoggerLevel })
// so unit tests never import the real SDK or open a socket. ───
let sdkFactory = null;
export function __setClientFactory(fn) { sdkFactory = fn; }

const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
function tokenHost(region) {
  return region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

async function loadSdk() {
  if (sdkFactory) return sdkFactory();
  return import('@larksuiteoapi/node-sdk');
}

/** Normalize an `im.message.receive_v1` event into the core's inbound shape. Returns null when
 *  the payload is unusable (the core skips it). */
function normalizeInbound(data) {
  const msg = data?.message;
  if (!msg) return null;
  let text = '';
  if (msg.message_type === 'text') {
    let content;
    try { content = JSON.parse(msg.content || '{}'); } catch { content = {}; }
    // Strip Feishu @-mention placeholders (`@_user_1`) the platform injects into group text.
    text = String(content.text || '').replace(/@_user_\d+/g, '').trim();
  }
  const isGroup = msg.chat_type === 'group';
  const sid = data.sender?.sender_id || {};
  const senderId = sid.open_id || sid.user_id || sid.union_id || '';
  return {
    text,
    conversationId: msg.chat_id,
    isGroup,
    senderId,
    msgId: msg.message_id,
    // In a group, reply to the chat; in a p2p, reply to the sender. receive_id_type tells the
    // send API which id space `receiveId` is in.
    target: isGroup
      ? { conversationId: msg.chat_id, receiveId: msg.chat_id, receiveIdType: 'chat_id' }
      : { conversationId: msg.chat_id, receiveId: senderId, receiveIdType: 'open_id' },
  };
}

const feishuAdapter = {
  id: 'feishu',
  i18nNs: 'server.feishu',
  allowListField: 'allowUserIds',
  capabilities: { inboundAck: false, sdkManagesToken: true },
  // Feishu IM send limits are generous (≈1000/min/app); cap conservatively.
  rateLimit: { max: 50, windowMs: 60_000 },

  hasCreds(cfg) { return !!(cfg.appId && cfg.appSecret); },
  statusFields(cfg) { return { appKeyTail: cfg?.appId?.slice(-4) || '' }; },

  async connect(cfg, hooks, ctx) {
    const Lark = await loadSdk();
    const domain = cfg.region === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
    const base = { appId: cfg.appId, appSecret: cfg.appSecret, domain };
    // Outbound client (auto-manages the tenant_access_token cache).
    ctx.store.sendClient = new Lark.Client(base);
    // Inbound long-connection event client. wsConfig is REQUIRED — omitting PingInterval/PingTimeout
    // makes start() throw or hang on some SDK builds.
    const ws = new Lark.WSClient({
      ...base,
      loggerLevel: Lark.LoggerLevel ? Lark.LoggerLevel.warn : undefined, // warn: avoid noisy info-level stdout
      wsConfig: { PingInterval: 30, PingTimeout: 5 },
    });
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => hooks.onInbound(normalizeInbound(data), null),
    });
    await ws.start({ eventDispatcher: dispatcher });
    return ws;
  },

  async disconnect(ws) {
    // Branch on method presence, not return value — a void-returning stop() must not also call close().
    try {
      if (typeof ws?.stop === 'function') await ws.stop();
      else if (typeof ws?.close === 'function') await ws.close();
    } catch { /* best-effort */ }
  },

  // Feishu long-connection has no app-level inbound ACK (the SDK handles transport acking).
  ack() { /* no-op */ },

  // 解析发送者姓名 + 头像（供「对话记录」展示）。事件只带 open_id，姓名/头像需查通讯录：
  // 复用已建好的 sendClient（自带 tenant_access_token 缓存）调 contact.v3.user.get。
  // 需应用具备「读取通讯录」相关 scope；无权限/外部用户/失败 → null，由 bridge 静默降级。
  async resolveSender(cfg, senderId, ctx) {
    if (!senderId) return null;
    const client = ctx.store.sendClient;
    if (!client?.contact?.v3?.user?.get) return null;
    try {
      const r = await client.contact.v3.user.get({
        path: { user_id: senderId },
        params: { user_id_type: 'open_id' },
      });
      if (r && typeof r.code === 'number' && r.code !== 0) return null;
      const u = r?.data?.user || {};
      const avatar = u.avatar?.avatar_240 || u.avatar?.avatar_72 || u.avatar?.avatar_origin || null;
      return { name: u.name || null, avatar };
    } catch { return null; }
  },

  async sendOne(cfg, target, content, ctx) {
    const client = ctx.store.sendClient;
    if (!client) throw new Error('feishu send client not initialized');
    const r = await client.im.v1.message.create({
      params: { receive_id_type: target.receiveIdType },
      data: { receive_id: target.receiveId, msg_type: 'text', content: JSON.stringify({ text: content }) },
    });
    if (r && typeof r.code === 'number' && r.code !== 0) {
      throw new Error(`send ${r.code}: ${r.msg || 'failed'}`);
    }
  },

  async testConnection(cfg, ctx) {
    try {
      const r = await ctx.fetch(tokenHost(cfg.region) + TOKEN_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
      });
      const j = await r.json().catch(() => ({}));
      // Feishu returns HTTP 200 with a non-zero `code` on bad creds — check the body code.
      if (!r.ok || j.code !== 0) return { ok: false, detail: j.msg || `token ${r.status}: ${j.code ?? 'failed'}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: String(e?.message || e) };
    }
  },
};

registerAdapter(feishuAdapter);

export default feishuAdapter;
