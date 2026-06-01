import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpDir = mkdtempSync(join(tmpdir(), 'ccv-feishu-bridge-test-'));
process.env.CCV_LOG_DIR = tmpDir;

const core = await import('../server/lib/im-bridge-core.js');
const feishu = await import('../server/lib/adapters/feishu-adapter.js');

// Fake SDK ({ Client, WSClient, EventDispatcher, Domain, LoggerLevel }) — zero real SDK / socket.
let rec;
function installFakeSdk() {
  feishu.__setClientFactory(() => ({
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { info: 3 },
    Client: class {
      constructor(opts) { rec.clientOpts = opts; this.im = { v1: { message: { create: async (args) => { rec.sends.push(args); return { code: 0 }; } } } }; }
    },
    WSClient: class {
      constructor(opts) { rec.wsOpts = opts; }
      async start({ eventDispatcher }) { rec.started = true; rec.dispatcher = eventDispatcher; }
      async stop() { rec.stopped = true; }
    },
    EventDispatcher: class {
      constructor() { this._h = {}; }
      register(map) { Object.assign(this._h, map); rec.handlers = this._h; return this; }
    },
  }));
}

const tick = () => new Promise((r) => setTimeout(r, 5));

let injects, cfg, streaming, ptyKind, ptyRunning, skipPerm, injectOk;
function deps() {
  return {
    writeToPty: () => {},
    writeToPtySequential: (chunks, cb) => { injects.push(chunks[0]); if (cb) cb(injectOk); },
    getPtyState: () => ({ running: ptyRunning, exitCode: null }),
    getPtyKind: () => ptyKind,
    getPtySkipPermissions: () => skipPerm,
    isStreaming: () => streaming,
    getConfig: () => cfg,
  };
}

// Feed an im.message.receive_v1 event through the registered handler.
function receive(over = {}) {
  const message = {
    chat_id: over.chatId ?? 'oc_chat',
    chat_type: over.chatType ?? 'p2p',
    message_type: over.messageType ?? 'text',
    message_id: over.msgId ?? 'om_' + Math.random(),
    content: over.content ?? JSON.stringify({ text: 'hello' }),
  };
  const sender = { sender_id: { open_id: over.openId ?? 'ou_sender' } };
  return rec.handlers['im.message.receive_v1']({ message, sender });
}

before(() => { rec = {}; installFakeSdk(); });

beforeEach(async () => {
  core.__resetForTests('feishu');
  rec = { sends: [] };
  installFakeSdk();
  injects = [];
  cfg = { enabled: true, appId: 'cli_x', appSecret: 'sec', region: 'feishu', allowUserIds: [], maxChunkChars: 3800 };
  streaming = false; ptyKind = 'claude'; ptyRunning = true; skipPerm = false; injectOk = true;
  await core.startBridge('feishu', deps());
});

describe('feishu connect / lifecycle', () => {
  it('starts the WSClient with wsConfig + a registered im.message.receive_v1 handler', () => {
    assert.equal(core.isBridgeRunning('feishu'), true);
    assert.equal(rec.started, true);
    assert.ok(rec.wsOpts.wsConfig && rec.wsOpts.wsConfig.PingInterval, 'wsConfig must be set (else start() hangs)');
    assert.equal(typeof rec.handlers['im.message.receive_v1'], 'function');
  });

  it('maps region=lark to Domain.Lark', async () => {
    core.__resetForTests('feishu');
    rec = { sends: [] }; installFakeSdk();
    cfg = { ...cfg, region: 'lark' };
    await core.startBridge('feishu', deps());
    assert.equal(rec.clientOpts.domain, 1, 'lark → Domain.Lark (1)');
  });
});

describe('feishu inbound normalization', () => {
  it('injects a p2p text message with the ⟦im:feishu⟧ marker', async () => {
    await receive({ msgId: 'om1', content: JSON.stringify({ text: 'look here' }) });
    assert.equal(injects[0], '\x1b[200~⟦im:feishu⟧look here\x1b[201~');
  });

  it('strips @_user_N mention placeholders from group text', async () => {
    await receive({ msgId: 'om1', chatType: 'group', content: JSON.stringify({ text: '@_user_1 do this' }) });
    assert.equal(injects[0], '\x1b[200~⟦im:feishu⟧do this\x1b[201~');
  });

  it('ignores a non-text message (no injection)', async () => {
    await receive({ msgId: 'om1', messageType: 'image', content: JSON.stringify({ image_key: 'x' }) });
    assert.equal(injects.length, 0);
  });

  it('tolerates garbage content JSON', async () => {
    await receive({ msgId: 'om1', content: 'not json{{' });
    assert.equal(injects.length, 0); // empty text → ignored, no throw
  });

  it('dedups a redelivered message_id', async () => {
    await receive({ msgId: 'dup', content: JSON.stringify({ text: 'x' }) });
    await receive({ msgId: 'dup', content: JSON.stringify({ text: 'x' }) });
    assert.equal(injects.length, 1);
  });
});

describe('feishu outbound', () => {
  function writeTranscript(text) {
    const p = join(tmpDir, 'tp-' + Math.random().toString(36).slice(2) + '.jsonl');
    writeFileSync(p, [
      JSON.stringify({ type: 'user', message: { content: 'q' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
    ].join('\n'));
    return p;
  }

  it('replies to a p2p turn via message.create with receive_id_type=open_id', async () => {
    await receive({ msgId: 'om1', openId: 'ou_alice', content: JSON.stringify({ text: 'hi' }) });
    await core.notifyTurnEnd('s', Date.now(), writeTranscript('the answer'));
    const send = rec.sends.at(-1);
    assert.equal(send.params.receive_id_type, 'open_id');
    assert.equal(send.data.receive_id, 'ou_alice');
    assert.match(JSON.parse(send.data.content).text, /the answer/);
  });

  it('replies to a group turn via message.create with receive_id_type=chat_id', async () => {
    await receive({ msgId: 'om1', chatType: 'group', chatId: 'oc_grp', content: JSON.stringify({ text: 'hi' }) });
    await core.notifyTurnEnd('s', Date.now(), writeTranscript('group answer'));
    const send = rec.sends.at(-1);
    assert.equal(send.params.receive_id_type, 'chat_id');
    assert.equal(send.data.receive_id, 'oc_grp');
  });
});

describe('feishu testConnection', () => {
  it('ok when the region-correct token host returns code 0', async () => {
    let hitUrl = null;
    core.__setFetchForTests(async (url) => { hitUrl = url; return { ok: true, json: async () => ({ code: 0, tenant_access_token: 't', expire: 7200 }) }; });
    const r = await core.testConnection('feishu', { appId: 'cli', appSecret: 'sec', region: 'feishu' });
    assert.equal(r.ok, true);
    assert.match(hitUrl, /open\.feishu\.cn/);
  });

  it('uses the larksuite host when region=lark', async () => {
    let hitUrl = null;
    core.__setFetchForTests(async (url) => { hitUrl = url; return { ok: true, json: async () => ({ code: 0 }) }; });
    await core.testConnection('feishu', { appId: 'cli', appSecret: 'sec', region: 'lark' });
    assert.match(hitUrl, /open\.larksuite\.com/);
  });

  it('fails on a non-zero body code even with HTTP 200', async () => {
    core.__setFetchForTests(async () => ({ ok: true, json: async () => ({ code: 99991663, msg: 'app not found' }) }));
    const r = await core.testConnection('feishu', { appId: 'bad', appSecret: 'bad', region: 'feishu' });
    assert.equal(r.ok, false);
    assert.match(r.detail, /app not found/);
  });
});

after(() => { rmSync(tmpDir, { recursive: true, force: true }); });
