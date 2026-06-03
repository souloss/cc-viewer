// DingTalk adapter — the platform-specific half of the DingTalk bridge. The generic
// orchestration (dedup, access control, queue, inject, chunk, turn-end reply) lives in
// server/lib/im-bridge-core.js; this module only knows DingTalk's Stream client, ACK protocol,
// inbound payload shape, access-token fetch, and proactive App API send endpoints.
import { registerAdapter } from '../im-bridge-core.js';
import { t } from '../../i18n.js';

// ─── test seam: a fake Stream client factory (zero dingtalk-stream / network) ───
let clientFactory = null;
export function __setClientFactory(fn) { clientFactory = fn; }

// ─── DingTalk App API (proactive send; the inbound sessionWebhook is expired by reply time) ───
const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const GROUP_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';
const OTO_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

async function getAccessToken(cfg, ctx) {
  const tc = ctx.store.tokenCache;
  if (tc && tc.appKey === cfg.appKey && tc.expiresAt > Date.now() + 300_000) {
    return tc.accessToken;
  }
  const r = await ctx.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: cfg.appKey, appSecret: cfg.appSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.accessToken) throw new Error(`token ${r.status}: ${j.message || j.code || 'failed'}`);
  ctx.store.tokenCache = { appKey: cfg.appKey, accessToken: j.accessToken, expiresAt: Date.now() + (j.expireIn || 7200) * 1000 };
  return j.accessToken;
}

/** Normalize a DingTalk TOPIC_ROBOT callback into the core's inbound shape. Returns null for
 *  an unparseable payload (the core skips it). */
function normalizeInbound(res) {
  let msg;
  try { msg = JSON.parse(res?.data ?? '{}'); } catch { return null; }
  const conversationId = msg.conversationId;
  const conversationType = msg.conversationType;
  const senderStaffId = msg.senderStaffId;
  const robotCode = msg.robotCode || msg.chatbotUserId;
  return {
    text: msg.text?.content ?? '',
    conversationId,
    isGroup: String(conversationType) === '2',
    senderId: senderStaffId,
    senderName: msg.senderNick || null, // 昵称回调里免费提供；头像不取（见下方 resolveSender 注释）
    msgId: res?.headers?.messageId,
    // opaque platform extras carried back to sendOne
    target: { conversationId, conversationType, robotCode, senderStaffId },
  };
}

const dingtalkAdapter = {
  id: 'dingtalk',
  i18nNs: 'server.dingtalk',
  allowListField: 'allowStaffIds',
  capabilities: { inboundAck: true, sdkManagesToken: false },
  rateLimit: { max: 18, windowMs: 60_000 }, // stay under DingTalk's 20/min

  hasCreds(cfg) { return !!(cfg.appKey && cfg.appSecret); },
  statusFields(cfg) { return { appKeyTail: cfg?.appKey?.slice(-4) || '' }; },

  async connect(cfg, hooks) {
    let client;
    if (clientFactory) {
      client = clientFactory({ clientId: cfg.appKey, clientSecret: cfg.appSecret });
      if (typeof client.registerCallbackListener === 'function') {
        client.registerCallbackListener('__test__', (res) => hooks.onInbound(normalizeInbound(res), res));
      }
    } else {
      const mod = await import('dingtalk-stream');
      const { DWClient, TOPIC_ROBOT } = mod;
      client = new DWClient({ clientId: cfg.appKey, clientSecret: cfg.appSecret });
      client.registerCallbackListener(TOPIC_ROBOT, (res) => hooks.onInbound(normalizeInbound(res), res));
    }
    await client.connect?.();
    return client;
  },

  async disconnect(client) {
    try { await client?.disconnect?.(); } catch { /* best-effort */ }
  },

  // ackCtx is the raw `res`; `client` is the live Stream client (passed by the core).
  ack(res, client) {
    try {
      const id = res?.headers?.messageId;
      if (!id || !client) return;
      if (typeof client.socketCallBackResponse === 'function') {
        client.socketCallBackResponse(id, { success: true });
      } else if (typeof client.send === 'function') {
        client.send(id, JSON.stringify({ status: 'SUCCESS', message: 'OK' }));
      }
    } catch { /* best-effort; ack failure only risks a redelivery, caught by dedup */ }
  },

  async sendOne(cfg, target, content, ctx) {
    const token = await getAccessToken(cfg, ctx);
    const msgParam = JSON.stringify({ title: t('server.dingtalk.replyChunkTitle'), text: content });
    const isGroup = String(target.conversationType) === '2';
    const url = isGroup ? GROUP_SEND_URL : OTO_SEND_URL;
    const body = isGroup
      ? { robotCode: target.robotCode, openConversationId: target.conversationId, msgKey: 'sampleMarkdown', msgParam }
      : { robotCode: target.robotCode, userIds: [target.senderStaffId].filter(Boolean), msgKey: 'sampleMarkdown', msgParam };
    const r = await ctx.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(`send ${r.status}: ${j.message || j.code || 'failed'}`);
    }
  },

  // 发送者姓名：回调里的 senderNick 已免费带出（见 normalizeInbound），「对话记录」直接用它。
  // 故意不实现 resolveSender —— 头像需查通讯录（topapi/v2/user/get），而机器人应用的 appKey/appSecret
  // 没有通讯录读取权限，调用必失败（errcode 60121/88）；且这些未授权调用会打到与消息发送同一个 appKey，
  // 触发钉钉风控/限流，反过来阻断模型回复的下发。故 DingTalk 发送者头像在「对话记录」里降级为默认头像
  // （名字仍是真实昵称，不报错、不抢占发送配额）。后续如引入具备通讯录 scope 的凭证再补 resolveSender。

  async testConnection(cfg, ctx) {
    try {
      ctx.store.tokenCache = null; // force a fresh fetch
      await getAccessToken(cfg, ctx);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: String(e?.message || e) };
    }
  },
};

registerAdapter(dingtalkAdapter);

export default dingtalkAdapter;
