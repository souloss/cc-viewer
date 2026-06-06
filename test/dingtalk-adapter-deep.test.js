// Direct adapter-level coverage for the DingTalk platform half. The bridge-level
// suite (dingtalk-bridge.test.js) drives the happy paths through im-bridge-core;
// this file calls the adapter methods directly with a fake ctx to hit the error
// arms and the ack-card create/deliver/update branches the bridge never exercises.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.CCV_LOG_DIR = mkdtempSync(join(tmpdir(), 'ccv-dtadapter-'));

const { default: adapter, __setClientFactory } = await import('../server/lib/adapters/dingtalk-adapter.js');

// A ctx carrying a recording fetch + a store (the token cache lives on store.tokenCache).
function makeCtx(fetchImpl) {
  const calls = [];
  return {
    calls,
    store: {},
    fetch: async (url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers, method: init?.method });
      return fetchImpl(url, init);
    },
  };
}

const okToken = (url) => url.includes('accessToken')
  ? { ok: true, json: async () => ({ accessToken: 'tok', expireIn: 7200 }) }
  : { ok: true, json: async () => ({}) };

const cfg = { appKey: 'ak', appSecret: 'sec', cardTemplateId: 'tmpl1' };

describe('getAccessToken (token fetch + cache)', () => {
  it('caches the token and reuses it within the expiry window', async () => {
    const ctx = makeCtx(okToken);
    await adapter.testConnection(cfg, ctx);            // forces tokenCache=null then a fetch
    const firstFetches = ctx.calls.filter((c) => c.url.includes('accessToken')).length;
    // sendOne reuses the cached token (expiresAt far in the future) → no second token fetch
    await adapter.sendOne(cfg, { conversationType: '1', robotCode: 'r', senderStaffId: 'u' }, 'hi', ctx);
    const total = ctx.calls.filter((c) => c.url.includes('accessToken')).length;
    assert.equal(firstFetches, 1);
    assert.equal(total, 1, 'cached token reused — no second accessToken fetch');
  });

  it('throws a descriptive error when the token endpoint returns !ok', async () => {
    const ctx = makeCtx(() => ({ ok: false, status: 401, json: async () => ({ message: 'bad creds' }) }));
    await assert.rejects(
      () => adapter.testConnection(cfg, ctx).then((r) => { if (!r.ok) throw new Error(r.detail); }),
      /401.*bad creds/,
    );
  });

  it('throws when the token endpoint is ok but omits accessToken', async () => {
    const ctx = makeCtx((url) => url.includes('accessToken')
      ? { ok: true, status: 200, json: async () => ({ code: 'NoToken' }) }
      : { ok: true, json: async () => ({}) });
    const r = await adapter.testConnection(cfg, ctx);
    assert.equal(r.ok, false);
    assert.match(r.detail, /NoToken|failed/);
  });
});

describe('testConnection', () => {
  it('returns ok:true when the token fetch succeeds', async () => {
    const ctx = makeCtx(okToken);
    const r = await adapter.testConnection(cfg, ctx);
    assert.deepEqual(r, { ok: true });
  });

  it('returns ok:false with a detail string when the token fetch fails', async () => {
    const ctx = makeCtx(() => ({ ok: false, status: 500, json: async () => ({ code: 'Server' }) }));
    const r = await adapter.testConnection(cfg, ctx);
    assert.equal(r.ok, false);
    assert.match(r.detail, /500/);
  });
});

describe('sendOne', () => {
  it('1:1 message posts to oToMessages with userIds', async () => {
    const ctx = makeCtx(okToken);
    await adapter.sendOne(cfg, { conversationType: '1', robotCode: 'r', senderStaffId: 'u' }, 'body', ctx);
    const send = ctx.calls.find((c) => c.url.includes('oToMessages/batchSend'));
    assert.ok(send);
    assert.deepEqual(send.body.userIds, ['u']);
    assert.equal(send.headers['x-acs-dingtalk-access-token'], 'tok');
  });

  it('group message (type=2) posts to groupMessages with openConversationId and no userIds', async () => {
    const ctx = makeCtx(okToken);
    await adapter.sendOne(cfg, { conversationType: '2', robotCode: 'r', conversationId: 'grp' }, 'body', ctx);
    const send = ctx.calls.find((c) => c.url.includes('groupMessages/send'));
    assert.ok(send);
    assert.equal(send.body.openConversationId, 'grp');
    assert.ok(!('userIds' in send.body));
  });

  it('throws when the send endpoint returns !ok (error arm)', async () => {
    const ctx = makeCtx((url) => url.includes('accessToken')
      ? { ok: true, json: async () => ({ accessToken: 'tok', expireIn: 7200 }) }
      : { ok: false, status: 403, json: async () => ({ message: 'forbidden' }) });
    await assert.rejects(
      () => adapter.sendOne(cfg, { conversationType: '1', robotCode: 'r', senderStaffId: 'u' }, 'body', ctx),
      /send 403.*forbidden/,
    );
  });

  it('send error arm tolerates a non-JSON error body', async () => {
    const ctx = makeCtx((url) => url.includes('accessToken')
      ? { ok: true, json: async () => ({ accessToken: 'tok', expireIn: 7200 }) }
      : { ok: false, status: 500, json: async () => { throw new Error('not json'); } });
    await assert.rejects(
      () => adapter.sendOne(cfg, { conversationType: '1', robotCode: 'r', senderStaffId: 'u' }, 'body', ctx),
      /send 500: failed/,
    );
  });
});

describe('sendAckCard', () => {
  it('returns null without a cardTemplateId (no network)', async () => {
    const ctx = makeCtx(okToken);
    const r = await adapter.sendAckCard({ appKey: 'ak', appSecret: 'sec' }, { conversationType: '1' }, 'status', ctx);
    assert.equal(r, null);
    assert.equal(ctx.calls.length, 0, 'no fetch when card disabled');
  });

  it('1:1 card creates then delivers via IM_ROBOT openSpaceId and returns the outTrackId', async () => {
    const ctx = makeCtx(okToken);
    const r = await adapter.sendAckCard(cfg, { conversationType: '1', robotCode: 'r', senderStaffId: 'u9' }, 'thinking', ctx);
    const create = ctx.calls.find((c) => c.url.endsWith('/card/instances'));
    const deliver = ctx.calls.find((c) => c.url.includes('/card/instances/deliver'));
    assert.ok(create && deliver);
    assert.equal(create.body.cardTemplateId, 'tmpl1');
    assert.match(deliver.body.openSpaceId, /IM_ROBOT\.u9/);
    assert.equal(deliver.body.imRobotOpenDeliverModel.robotCode, 'r');
    assert.equal(r.outTrackId, create.body.outTrackId);
  });

  it('group card delivers via IM_GROUP openSpaceId', async () => {
    const ctx = makeCtx(okToken);
    await adapter.sendAckCard(cfg, { conversationType: '2', robotCode: 'r', conversationId: 'g7' }, 'thinking', ctx);
    const deliver = ctx.calls.find((c) => c.url.includes('/card/instances/deliver'));
    assert.match(deliver.body.openSpaceId, /IM_GROUP\.g7/);
    assert.equal(deliver.body.imGroupOpenDeliverModel.robotCode, 'r');
  });

  it('throws when card create returns !ok', async () => {
    const ctx = makeCtx((url) => {
      if (url.includes('accessToken')) return { ok: true, json: async () => ({ accessToken: 'tok', expireIn: 7200 }) };
      if (url.endsWith('/card/instances')) return { ok: false, status: 400, json: async () => ({ message: 'bad tmpl' }) };
      return { ok: true, json: async () => ({}) };
    });
    await assert.rejects(
      () => adapter.sendAckCard(cfg, { conversationType: '1', robotCode: 'r', senderStaffId: 'u' }, 's', ctx),
      /card create 400.*bad tmpl/,
    );
  });

  it('throws when card deliver returns !ok', async () => {
    const ctx = makeCtx((url) => {
      if (url.includes('accessToken')) return { ok: true, json: async () => ({ accessToken: 'tok', expireIn: 7200 }) };
      if (url.includes('/card/instances/deliver')) return { ok: false, status: 422, json: async () => ({ code: 'DeliverFail' }) };
      return { ok: true, json: async () => ({}) };
    });
    await assert.rejects(
      () => adapter.sendAckCard(cfg, { conversationType: '1', robotCode: 'r', senderStaffId: 'u' }, 's', ctx),
      /card deliver 422.*DeliverFail/,
    );
  });
});

describe('updateAckCard', () => {
  it('PUTs the card update and returns true on ok', async () => {
    const ctx = makeCtx(okToken);
    const ok = await adapter.updateAckCard(cfg, {}, { outTrackId: 'ot1' }, 'new content', 'done', ctx);
    assert.equal(ok, true);
    const put = ctx.calls.find((c) => c.method === 'PUT');
    assert.ok(put);
    assert.equal(put.body.outTrackId, 'ot1');
    assert.equal(put.body.cardData.cardParamMap.content, 'new content');
  });

  it('returns false when the update fetch reports !ok', async () => {
    const ctx = makeCtx((url) => url.includes('accessToken')
      ? { ok: true, json: async () => ({ accessToken: 'tok', expireIn: 7200 }) }
      : { ok: false, status: 500, json: async () => ({}) });
    const ok = await adapter.updateAckCard(cfg, {}, { outTrackId: 'ot1' }, 'c', 's', ctx);
    assert.equal(ok, false);
  });

  it('returns false (swallows) when the token fetch throws', async () => {
    const ctx = makeCtx(() => { throw new Error('network down'); });
    const ok = await adapter.updateAckCard(cfg, {}, { outTrackId: 'ot1' }, 'c', 's', ctx);
    assert.equal(ok, false);
  });
});

describe('connect / ack via fake client factory', () => {
  beforeEach(() => __setClientFactory(null));

  it('connect uses the injected factory and wires onInbound through normalizeInbound', async () => {
    let registered = null;
    let connected = false;
    __setClientFactory((opts) => ({
      _opts: opts,
      registerCallbackListener(_topic, handler) { registered = handler; },
      connect() { connected = true; },
    }));
    const inboundSeen = [];
    const client = await adapter.connect({ appKey: 'ak', appSecret: 'sec' }, { onInbound: (norm, raw) => inboundSeen.push({ norm, raw }) });
    assert.ok(connected);
    assert.equal(typeof registered, 'function');
    // Drive a raw TOPIC_ROBOT payload through the registered listener.
    const raw = { headers: { messageId: 'mid1' }, data: JSON.stringify({ text: { content: 'hi' }, conversationId: 'c1', conversationType: '2', senderStaffId: 'u1', senderNick: 'Alice', robotCode: 'rc' }) };
    registered(raw);
    assert.equal(inboundSeen.length, 1);
    const n = inboundSeen[0].norm;
    assert.equal(n.text, 'hi');
    assert.equal(n.isGroup, true);
    assert.equal(n.senderName, 'Alice');
    assert.equal(n.msgId, 'mid1');
    assert.equal(n.target.robotCode, 'rc');
    // disconnect best-effort
    await adapter.disconnect(client);
  });

  it('normalizeInbound returns null for an unparseable payload', async () => {
    let registered = null;
    __setClientFactory(() => ({ registerCallbackListener(_t, h) { registered = h; }, connect() {} }));
    const seen = [];
    await adapter.connect({ appKey: 'ak', appSecret: 'sec' }, { onInbound: (norm) => seen.push(norm) });
    registered({ headers: { messageId: 'x' }, data: '{not json' });
    assert.equal(seen[0], null);
  });

  it('ack uses socketCallBackResponse when present', () => {
    const acks = [];
    adapter.ack({ headers: { messageId: 'a1' } }, { socketCallBackResponse: (id, p) => acks.push({ id, p }) });
    assert.deepEqual(acks, [{ id: 'a1', p: { success: true } }]);
  });

  it('ack falls back to client.send when socketCallBackResponse is absent', () => {
    const sent = [];
    adapter.ack({ headers: { messageId: 'a2' } }, { send: (id, payload) => sent.push({ id, payload }) });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'a2');
    assert.match(sent[0].payload, /SUCCESS/);
  });

  it('ack is a no-op (no throw) without a messageId or client', () => {
    assert.doesNotThrow(() => adapter.ack({ headers: {} }, { send() { throw new Error('should not be called'); } }));
    assert.doesNotThrow(() => adapter.ack({ headers: { messageId: 'x' } }, null));
  });

  it('disconnect swallows a throwing client', async () => {
    await assert.doesNotReject(() => adapter.disconnect({ disconnect() { throw new Error('boom'); } }));
    await assert.doesNotReject(() => adapter.disconnect(null));
  });
});

describe('static descriptors', () => {
  it('hasCreds requires both appKey and appSecret', () => {
    assert.equal(adapter.hasCreds({ appKey: 'a', appSecret: 'b' }), true);
    assert.equal(adapter.hasCreds({ appKey: 'a' }), false);
    assert.equal(adapter.hasCreds({}), false);
  });

  it('statusFields exposes the appKey tail', () => {
    assert.equal(adapter.statusFields({ appKey: 'abcd1234' }).appKeyTail, '1234');
    assert.equal(adapter.statusFields({}).appKeyTail, '');
  });
});
