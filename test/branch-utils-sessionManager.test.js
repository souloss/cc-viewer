/**
 * branch coverage 补强：src/utils/sessionManager.js
 *
 * 专攻 single-run 口径下未覆盖的分支：
 *   - extractTextContent 数组 content 无 text block / block.text 缺失 → return ''（157-158）
 *   - _bumpFb trace 路径（__CCV_SESSIONMERGE_TRACE__=true）的 console.warn + 内嵌三元（326-334）
 *   - buildSessionIndex 的 sortedGroupKeys[i] / entryTimestamp / groupMap.get fallback 链
 *   - mergeSessionIndices sort 比较器 null 臂
 *   - applyInPlaceLastMsgReplace 末位 _timestamp 赋值分支 / appliedCount cap 分支
 *
 * 规则：仅用 _shims/register.mjs + 动态 import 加载目标模块（Vite 风格无扩展名 import）。
 * mock 的 console.warn / globalThis flag 在 after() 还原。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './_shims/register.mjs';

let SM;
before(async () => {
  SM = await import('../src/utils/sessionManager.js');
});

// ─── extractTextContent 间接覆盖（通过 buildSessionIndex preview）─────────────

describe('buildSessionIndex preview / extractTextContent 分支', () => {
  function entryOf(sid, ts) {
    return { _sessionId: sid, timestamp: ts, url: 'x' };
  }

  it('数组 content 但无 text block → preview 为空（覆盖 return "" 兜底）', () => {
    const sid = '2025-03-01T00:00:00Z';
    const entries = [entryOf(sid, sid)];
    const sessions = [{
      userId: 'u',
      // user msg 的 content 数组里只有非 text block → extractTextContent 走完循环返回 ''
      messages: [
        { role: 'user', content: [{ type: 'image', source: {} }, { type: 'tool_result', content: 'x' }] },
        { role: 'assistant', content: 'resp' },
      ],
      response: {},
      entryTimestamp: sid,
    }];
    const index = SM.buildSessionIndex(entries, sessions);
    assert.equal(index[0].preview, '', '无 text block 时 preview 为空字符串');
  });

  it('数组 content 中 text block 但 text 为空串 → 该 block 不命中，preview 空', () => {
    const sid = '2025-03-02T00:00:00Z';
    const entries = [entryOf(sid, sid)];
    const sessions = [{
      userId: 'u',
      // block.type==='text' 但 block.text 为 '' → `block.text` falsy，不 return
      messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }],
      response: {},
      entryTimestamp: sid,
    }];
    const index = SM.buildSessionIndex(entries, sessions);
    assert.equal(index[0].preview, '', 'text 为空串时不命中，preview 仍为空');
  });

  it('user msg content 为 string → 直接走 typeof string 分支', () => {
    const sid = '2025-03-03T00:00:00Z';
    const entries = [entryOf(sid, sid)];
    const sessions = [{
      userId: 'u',
      messages: [{ role: 'user', content: 'plain string content' }],
      response: {},
      entryTimestamp: sid,
    }];
    const index = SM.buildSessionIndex(entries, sessions);
    assert.equal(index[0].preview, 'plain string content');
  });

  it('user msg content 既非 string 也非数组（null/number）→ 返回空，preview 空', () => {
    const sid = '2025-03-04T00:00:00Z';
    const entries = [entryOf(sid, sid)];
    const sessions = [{
      userId: 'u',
      messages: [
        { role: 'user', content: null },
        { role: 'user', content: 12345 },
      ],
      response: {},
      entryTimestamp: sid,
    }];
    const index = SM.buildSessionIndex(entries, sessions);
    assert.equal(index[0].preview, '', 'content 非法类型 → extractTextContent 返回 "" → 不 break，最终 preview 空');
  });

  it('session.messages 无任何 user role → preview 保持空（循环不命中 break）', () => {
    const sid = '2025-03-05T00:00:00Z';
    const entries = [entryOf(sid, sid)];
    const sessions = [{
      userId: 'u',
      messages: [
        { role: 'assistant', content: 'a' },
        { role: 'system', content: 's' },
      ],
      response: {},
      entryTimestamp: sid,
    }];
    const index = SM.buildSessionIndex(entries, sessions);
    assert.equal(index[0].preview, '');
  });

  it('session 为 null → msgCount/preview/userId 默认值（覆盖 if (session) false 臂）', () => {
    const sid = '2025-03-06T00:00:00Z';
    const entries = [entryOf(sid, sid)];
    // mainAgentSessions 含一个 null session
    const index = SM.buildSessionIndex(entries, [null]);
    assert.equal(index.length, 1);
    assert.equal(index[0].msgCount, 0);
    assert.equal(index[0].preview, '');
    assert.equal(index[0].userId, null);
    // sessionId: sortedGroupKeys[0]=sid（来自 entry 分组）
    assert.equal(index[0].sessionId, sid);
  });

  it('session 无 messages 字段 → msgCount=0，跳过 preview 循环', () => {
    const sid = '2025-03-07T00:00:00Z';
    const entries = [entryOf(sid, sid)];
    const sessions = [{ userId: 'u', response: {}, entryTimestamp: sid }]; // 无 messages
    const index = SM.buildSessionIndex(entries, sessions);
    assert.equal(index[0].msgCount, 0);
    assert.equal(index[0].preview, '');
    assert.equal(index[0].userId, 'u');
  });

  it('session 缺 userId → userId fallback null（覆盖 session.userId || null）', () => {
    const sid = '2025-03-08T00:00:00Z';
    const entries = [entryOf(sid, sid)];
    const sessions = [{ messages: [{ role: 'user', content: 'hi' }], response: {}, entryTimestamp: sid }];
    const index = SM.buildSessionIndex(entries, sessions);
    assert.equal(index[0].userId, null);
  });

  it('session 比 group key 多：sortedGroupKeys[i] undefined 且 session.entryTimestamp 存在 → sessionId 用 entryTimestamp', () => {
    const sid0 = '2025-03-09T00:00:00Z';
    const entries = [entryOf(sid0, sid0)];
    // 2 个 session，但只有 1 个 group key → 第二个 session 走 session?.entryTimestamp
    const sessions = [
      { messages: [{ role: 'user', content: 'a' }], response: {}, entryTimestamp: sid0 },
      { messages: [{ role: 'user', content: 'b' }], response: {}, entryTimestamp: '2025-03-09T05:00:00Z' },
    ];
    const index = SM.buildSessionIndex(entries, sessions);
    assert.equal(index.length, 2);
    assert.equal(index[1].sessionId, '2025-03-09T05:00:00Z', 'sortedGroupKeys[1]=undefined → fallback entryTimestamp');
    // groupMap.get(undefinedKey 不存在的 sid) → 用默认 {firstTs:null...}
    assert.equal(index[1].entryCount, 0);
    assert.equal(index[1].firstTs, null);
  });

  it('session 多于 group key 且无 entryTimestamp → sessionId=null（覆盖 || null 末臂）', () => {
    const sid0 = '2025-03-10T00:00:00Z';
    const entries = [entryOf(sid0, sid0)];
    const sessions = [
      { messages: [{ role: 'user', content: 'a' }], response: {}, entryTimestamp: sid0 },
      { messages: [{ role: 'user', content: 'b' }], response: {} }, // 无 entryTimestamp
    ];
    const index = SM.buildSessionIndex(entries, sessions);
    assert.equal(index.length, 2);
    assert.equal(index[1].sessionId, null, 'sortedGroupKeys[1]=undefined && entryTimestamp 缺 → null');
    // sessionId 为 null → g 走 { firstTs:null,... } 默认对象（覆盖 sessionId ? ... : ... 的 false 臂）
    assert.equal(index[1].entryCount, 0);
    assert.equal(index[1].lastTs, null, 'lastTs: g.lastTs(null) || entryTimestamp(undefined) || null');
  });
});

// ─── mergeSessionIndices sort 比较器 null 臂 ────────────────────────────────

describe('mergeSessionIndices sort 比较器分支', () => {
  function idx(sessionId, preview) {
    return { sessionId, preview, firstTs: null, lastTs: null, entryCount: 0, msgCount: 0, userId: null };
  }

  it('相等 sessionId → 比较器返回 0（a.sessionId === b.sessionId 臂）', () => {
    // old 与 new 含相同 sessionId（new 覆盖），但排序时也可能比较到相等的对
    const old = [idx('ts-x', 'old-x'), idx('ts-y', 'old-y')];
    const nw = [idx('ts-x', 'new-x')];
    const result = SM.mergeSessionIndices(old, nw);
    // old 中 ts-x 被 new 覆盖剔除；剩 old-y + new-x → 排序
    assert.equal(result.length, 2);
    const map = Object.fromEntries(result.map(r => [r.sessionId, r.preview]));
    assert.equal(map['ts-x'], 'new-x');
    assert.equal(map['ts-y'], 'old-y');
  });

  it('a.sessionId == null → 比较器返回 -1（null 排前）', () => {
    const old = [idx(null, 'old-null')];
    const nw = [idx('ts-z', 'new-z')];
    const result = SM.mergeSessionIndices(old, nw);
    assert.equal(result.length, 2);
    assert.equal(result[0].sessionId, null, 'null sessionId 排在最前');
    assert.equal(result[1].sessionId, 'ts-z');
  });

  it('b.sessionId == null → 比较器返回 1（null 排前 / 非 null 排后）', () => {
    // 让 new 含 null，old 含非 null，迫使比较中 b 为 null 的路径
    const old = [idx('ts-a', 'old-a')];
    const nw = [idx(null, 'new-null'), idx('ts-b', 'new-b')];
    const result = SM.mergeSessionIndices(old, nw);
    assert.equal(result.length, 3);
    assert.equal(result[0].sessionId, null, 'null 排最前');
  });
});

// ─── applyInPlaceLastMsgReplace 末位 _timestamp / appliedCount 分支 ──────────

describe('applyInPlaceLastMsgReplace 末位时间戳 & 计数 cap 分支', () => {
  function makeMsg(role, text, ts) {
    const m = { role, content: [{ type: 'text', text }] };
    if (ts) m._timestamp = ts;
    return m;
  }
  function makeSessionLocal(messages) {
    return { userId: 'u1', messages, response: { status: 200, body: {} }, entryTimestamp: 'T0' };
  }

  it('末位 newLastMsg 无 _timestamp → 赋 timestamp 参数（覆盖 if (...!_timestamp) true 臂）', () => {
    const m0 = makeMsg('user', 'hi', 'TA');
    const m1_old = makeMsg('assistant', 'old', 'TB');
    const session = makeSessionLocal([m0, m1_old]);
    const m1_new = makeMsg('assistant', 'new'); // 故意不带 _timestamp
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: 'T-new',
      response: { status: 200, body: {} },
      body: { messages: [m0, m1_new] },
    };
    const result = SM.applyInPlaceLastMsgReplace([session], entry, 'T-new', false);
    assert.equal(result.applied, true);
    assert.equal(result.sessions[0].messages[1]._timestamp, 'T-new', '末位 msg 无 _timestamp → 赋传入 timestamp');
  });

  it('末位 newLastMsg 已有 _timestamp → 不覆盖（覆盖 if (...!_timestamp) false 臂）', () => {
    const m0 = makeMsg('user', 'hi', 'TA');
    const m1_old = makeMsg('assistant', 'old', 'TB');
    const session = makeSessionLocal([m0, m1_old]);
    const m1_new = makeMsg('assistant', 'new', 'TEXISTING'); // 已带 _timestamp
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: 'T-new',
      response: { status: 200, body: {} },
      body: { messages: [m0, m1_new] },
    };
    const result = SM.applyInPlaceLastMsgReplace([session], entry, 'T-new', false);
    assert.equal(result.applied, true);
    assert.equal(result.sessions[0].messages[1]._timestamp, 'TEXISTING', '已有 _timestamp 不被覆盖');
  });

  it('appliedCount 已达 cap(9999) → 不再自增（覆盖 if (appliedCount < 9999) false 臂）', () => {
    const saved = SM.applyInPlaceLastMsgReplace.appliedCount;
    try {
      SM.applyInPlaceLastMsgReplace.appliedCount = 9999;
      const m0 = makeMsg('user', 'hi', 'TA');
      const m1_old = makeMsg('assistant', 'old', 'TB');
      const session = makeSessionLocal([m0, m1_old]);
      const m1_new = makeMsg('assistant', 'new', 'TC');
      const entry = {
        _isCheckpoint: true,
        _inPlaceReplaceDetected: true,
        timestamp: 'T-new',
        response: { status: 200, body: {} },
        body: { messages: [m0, m1_new] },
      };
      const result = SM.applyInPlaceLastMsgReplace([session], entry, 'T-new', false);
      assert.equal(result.applied, true);
      assert.equal(SM.applyInPlaceLastMsgReplace.appliedCount, 9999, 'cap 命中后计数不再增长');
    } finally {
      SM.applyInPlaceLastMsgReplace.appliedCount = saved;
    }
  });

  it('fallbackCount 某 reason 已达 cap(9999) → 不再自增（覆盖 if (cur < 9999) false 臂）', () => {
    const savedFb = SM.applyInPlaceLastMsgReplace.fallbackCount;
    try {
      const fb = Object.create(null);
      fb['length-mismatch'] = 9999;
      SM.applyInPlaceLastMsgReplace.fallbackCount = fb;
      const m0 = makeMsg('user', 'hi', 'TA');
      const session = makeSessionLocal([m0]);
      // 触发 length-mismatch（messages 长度 != session.messages 长度）
      const entry = {
        _isCheckpoint: true,
        _inPlaceReplaceDetected: true,
        timestamp: 'T-new',
        response: { status: 200, body: {} },
        body: { messages: [m0, makeMsg('assistant', 'a', 'TB'), makeMsg('user', 'b', 'TC')] },
      };
      const result = SM.applyInPlaceLastMsgReplace([session], entry, 'T-new', false);
      assert.equal(result.applied, false);
      assert.equal(fb['length-mismatch'], 9999, 'cap 命中后 fallback 计数不再增长');
    } finally {
      SM.applyInPlaceLastMsgReplace.fallbackCount = savedFb;
    }
  });
});

// ─── _bumpFb trace 路径（__CCV_SESSIONMERGE_TRACE__=true）────────────────────

describe('applyInPlaceLastMsgReplace trace 路径（console.warn + 内嵌三元）', () => {
  let savedWarn;
  let savedFlag;
  let warnCalls;

  before(() => {
    savedWarn = console.warn;
    savedFlag = globalThis.__CCV_SESSIONMERGE_TRACE__;
    warnCalls = [];
    // eslint-disable-next-line no-console
    console.warn = (...args) => { warnCalls.push(args); };
    globalThis.__CCV_SESSIONMERGE_TRACE__ = true;
  });

  after(() => {
    // eslint-disable-next-line no-console
    console.warn = savedWarn;
    if (savedFlag === undefined) {
      delete globalThis.__CCV_SESSIONMERGE_TRACE__;
    } else {
      globalThis.__CCV_SESSIONMERGE_TRACE__ = savedFlag;
    }
  });

  function makeMsg(role, text, ts) {
    const m = { role, content: [{ type: 'text', text }] };
    if (ts) m._timestamp = ts;
    return m;
  }
  function makeSessionLocal(messages) {
    return { userId: 'u1', messages, response: { status: 200, body: {} }, entryTimestamp: 'T0' };
  }

  it('trace ON + 守卫拒绝（length-mismatch）→ console.warn 被调用，含 body.messages 数组臂', () => {
    warnCalls.length = 0;
    const m0 = makeMsg('user', 'hi', 'TA');
    const session = makeSessionLocal([m0]);
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: 'TS-trace',
      response: { status: 200, body: {} },
      // body.messages 是数组 → 覆盖 msgLen 三元的 true 臂；长度 2 != 1 触发 length-mismatch
      body: { messages: [m0, makeMsg('assistant', 'a', 'TB')] },
    };
    const result = SM.applyInPlaceLastMsgReplace([session], entry, 'TS-trace', false);
    assert.equal(result.applied, false);
    assert.equal(warnCalls.length, 1, 'trace ON 时 fallback 应触发 console.warn');
    const [msg, payload] = warnCalls[0];
    assert.match(msg, /length-mismatch/, 'warn 消息含 reason');
    assert.equal(payload.ts, 'TS-trace');
    assert.equal(payload.hasSignal, true);
    assert.equal(payload.isCheckpoint, true);
    assert.equal(payload.msgLen, 2, 'body.messages 为数组 → msgLen 三元 true 臂取 .length');
    assert.equal(payload.lastSessionLen, 1, 'prevSessions 末 session messages 为数组 → lastSessionLen 取长度');
  });

  it('trace ON + body.messages 非数组 → msgLen 三元 false 臂取 null', () => {
    warnCalls.length = 0;
    const m0 = makeMsg('user', 'hi', 'TA');
    const m1 = makeMsg('assistant', 'old', 'TB');
    const session = makeSessionLocal([m0, m1]);
    // body.messages 非数组（但仍命中信号），守卫在 messages-too-short 处拒绝
    // 注意：entry.body.messages 用于 helper 内 messages 计算时 Array.isArray 判定，
    // 这里给个非数组让主逻辑得到 messages=null → messages-too-short
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: 'TS-trace2',
      response: { status: 200, body: {} },
      body: { messages: 'not-an-array' },
    };
    const result = SM.applyInPlaceLastMsgReplace([session], entry, 'TS-trace2', false);
    assert.equal(result.applied, false);
    assert.equal(warnCalls.length, 1);
    const payload = warnCalls[0][1];
    assert.equal(payload.msgLen, null, 'body.messages 非数组 → msgLen 三元 false 臂为 null');
    assert.equal(payload.lastSessionLen, 2);
  });

  it('trace ON + prevSessions 为空 → lastSessionLen 三元 false 臂取 null', () => {
    warnCalls.length = 0;
    const m0 = makeMsg('user', 'hi', 'TA');
    const m1 = makeMsg('assistant', 'a', 'TB');
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: 'TS-trace3',
      response: { status: 200, body: {} },
      body: { messages: [m0, m1] },
    };
    // prevSessions=[] → no-prev-sessions fallback；lastSessionLen 三元短路为 null
    const result = SM.applyInPlaceLastMsgReplace([], entry, 'TS-trace3', false);
    assert.equal(result.applied, false);
    assert.equal(warnCalls.length, 1);
    const [msg, payload] = warnCalls[0];
    assert.match(msg, /no-prev-sessions/);
    assert.equal(payload.lastSessionLen, null, 'prevSessions 空 → lastSessionLen null');
    assert.equal(payload.msgLen, 2);
  });

  it('trace ON + last session messages 非数组 → lastSessionLen 三元 false 臂取 null', () => {
    warnCalls.length = 0;
    const m0 = makeMsg('user', 'hi', 'TA');
    const m1 = makeMsg('assistant', 'a', 'TB');
    // 末 session.messages 非数组 → no-last-session-messages fallback
    const badSession = { userId: 'u', messages: null, response: {}, entryTimestamp: 'T0' };
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: 'TS-trace4',
      response: { status: 200, body: {} },
      body: { messages: [m0, m1] },
    };
    const result = SM.applyInPlaceLastMsgReplace([badSession], entry, 'TS-trace4', false);
    assert.equal(result.applied, false);
    assert.equal(warnCalls.length, 1);
    const [msg, payload] = warnCalls[0];
    assert.match(msg, /no-last-session-messages/);
    assert.equal(payload.lastSessionLen, null, '末 session messages 非数组 → lastSessionLen null');
  });

  it('trace ON + isNewSession 拒绝 → new-session reason 也触发 warn', () => {
    warnCalls.length = 0;
    const m0 = makeMsg('user', 'hi', 'TA');
    const m1 = makeMsg('assistant', 'a', 'TB');
    const session = makeSessionLocal([m0, m1]);
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: 'TS-trace5',
      response: { status: 200, body: {} },
      body: { messages: [m0, m1] },
    };
    const result = SM.applyInPlaceLastMsgReplace([session], entry, 'TS-trace5', /*isNewSession*/ true);
    assert.equal(result.applied, false);
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0][0], /new-session/);
  });
});

// ─── assignMessageTimestamps 守卫分支补强 ──────────────────────────────────

describe('assignMessageTimestamps 元素级守卫分支', () => {
  it('messages 含 null/undefined 元素 → continue 跳过（覆盖 if (!m) continue）', () => {
    const messages = [null, { role: 'user', content: 'a' }, undefined];
    const result = SM.assignMessageTimestamps(messages, [], false, 0, 'T1', null);
    assert.equal(result[1]._timestamp, 'T1');
    assert.equal(result[0], null);
    assert.equal(result[2], undefined);
  });

  it('i < prevCount 但 prevMessages[i] 缺失 → 走新增分支而非继承', () => {
    // prevCount=2 但 prevMessages 只有 1 个有效元素（[i] 为 null）
    const prev = [{ role: 'user', content: 'x', _timestamp: 'TP' }, null];
    const m0 = { role: 'user', content: 'a' };
    const m1 = { role: 'assistant', content: 'b' };
    const messages = [m0, m1];
    SM.assignMessageTimestamps(messages, prev, false, 2, 'TNOW', 'TPREV');
    // i=0: 继承 prev[0]._timestamp
    assert.equal(m0._timestamp, 'TP');
    // i=1: prevMessages[1]=null → 条件 false → 新增分支 → currentTs；assistant + prevMainAgentTs → _generatedTs
    assert.equal(m1._timestamp, 'TNOW');
    assert.equal(m1._generatedTs, 'TPREV');
  });

  it('i < prevCount 且 prevMessages[i] 存在但无 _timestamp → 走新增分支', () => {
    const prev = [{ role: 'user', content: 'x' }]; // 无 _timestamp
    const m0 = { role: 'user', content: 'a' };
    const messages = [m0];
    SM.assignMessageTimestamps(messages, prev, false, 1, 'TNOW', null);
    assert.equal(m0._timestamp, 'TNOW', 'prev[i] 无 _timestamp → 不继承，赋 currentTs');
  });

  it('历史继承分支：prev 有 _generatedTs → 继承（覆盖 if (prevMessages[i]._generatedTs) true 臂）', () => {
    const prev = [{ role: 'assistant', content: 'x', _timestamp: 'TP', _generatedTs: 'TG' }];
    const m0 = { role: 'assistant', content: 'a' };
    SM.assignMessageTimestamps([m0], prev, false, 1, 'TNOW', 'TPREV');
    assert.equal(m0._timestamp, 'TP');
    assert.equal(m0._generatedTs, 'TG', '继承 prev 的 _generatedTs');
  });

  it('历史继承分支：prev 无 _generatedTs → 不赋（覆盖 if (prevMessages[i]._generatedTs) false 臂）', () => {
    const prev = [{ role: 'assistant', content: 'x', _timestamp: 'TP' }]; // 无 _generatedTs
    const m0 = { role: 'assistant', content: 'a' };
    SM.assignMessageTimestamps([m0], prev, false, 1, 'TNOW', 'TPREV');
    assert.equal(m0._timestamp, 'TP');
    assert.equal(m0._generatedTs, undefined, 'prev 无 _generatedTs → 不补');
  });

  it('新增 assistant 但 prevMainAgentTs=null → 不赋 _generatedTs（覆盖 && prevMainAgentTs false 臂）', () => {
    const m0 = { role: 'assistant', content: 'a' };
    SM.assignMessageTimestamps([m0], [], false, 0, 'TNOW', null);
    assert.equal(m0._timestamp, 'TNOW');
    assert.equal(m0._generatedTs, undefined);
  });

  it('已有 _timestamp 的 assistant 但 prevMainAgentTs=null → 不补 _generatedTs（覆盖最后 elif && 末臂）', () => {
    const m0 = { role: 'assistant', content: 'a', _timestamp: 'TEXIST' };
    SM.assignMessageTimestamps([m0], [], false, 0, 'TNOW', null);
    assert.equal(m0._timestamp, 'TEXIST', '不覆盖');
    assert.equal(m0._generatedTs, undefined, 'prevMainAgentTs=null → 不补 _generatedTs');
  });

  it('已有 _timestamp 且已有 _generatedTs 的 assistant → 不重复补（覆盖 !m._generatedTs false 臂）', () => {
    const m0 = { role: 'assistant', content: 'a', _timestamp: 'TEXIST', _generatedTs: 'TGEXIST' };
    SM.assignMessageTimestamps([m0], [], false, 0, 'TNOW', 'TPREV');
    assert.equal(m0._generatedTs, 'TGEXIST', '已有 _generatedTs 不被改');
  });

  it('已有 _timestamp 的 user msg（非 assistant）→ 不进入末 elif', () => {
    const m0 = { role: 'user', content: 'a', _timestamp: 'TEXIST' };
    SM.assignMessageTimestamps([m0], [], false, 0, 'TNOW', 'TPREV');
    assert.equal(m0._timestamp, 'TEXIST');
    assert.equal(m0._generatedTs, undefined);
  });
});

// ─── resolveBubbleProducerTs 兜底分支 ──────────────────────────────────────

describe('resolveBubbleProducerTs 兜底分支', () => {
  it('assistant 无 _generatedTs 无 _timestamp → null（覆盖 || || null 末臂）', () => {
    assert.equal(SM.resolveBubbleProducerTs({ role: 'assistant' }), null);
  });
  it('assistant 有 _generatedTs → 直接返回（短路第一臂）', () => {
    assert.equal(SM.resolveBubbleProducerTs({ role: 'assistant', _generatedTs: 'TG', _timestamp: 'TT' }), 'TG');
  });
  it('非 assistant 无 _timestamp → null（覆盖 _timestamp || null 末臂）', () => {
    assert.equal(SM.resolveBubbleProducerTs({ role: 'user' }), null);
  });
});

// ─── splitHotCold 占位符分支补强 ───────────────────────────────────────────

describe('splitHotCold meta/sessionId 守卫分支', () => {
  function makeEntry(sid, ts) {
    return { _sessionId: sid, timestamp: ts, url: 'x' };
  }
  function makeSessionL(n, sid) {
    const messages = [];
    for (let i = 0; i < n; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    return { userId: 'u', messages, response: {}, entryTimestamp: sid };
  }

  it('sessionIndex meta.sessionId 为 null/undefined → 不替换占位（覆盖 if (sid && !hot) sid falsy 臂）', () => {
    // 构造 totalSessions > hotCount 但某个 meta.sessionId 为 null
    const sessions = [];
    const sessionIndex = [];
    const entries = [];
    for (let s = 0; s < 4; s++) {
      const sid = `2025-04-0${s + 1}T00:00:00Z`;
      entries.push(makeEntry(sid, sid));
      sessions.push(makeSessionL(2, sid));
      // 第 0 个 meta.sessionId 设 null（模拟坏 meta）
      sessionIndex.push({ sessionId: s === 0 ? null : sid, firstTs: sid, lastTs: sid, entryCount: 1, msgCount: 2, preview: `s${s}`, userId: 'u' });
    }
    const result = SM.splitHotCold(entries, sessions, sessionIndex, 2);
    // hotCount=2，最新 2 个 hot；前 2 个本应 cold，但 idx0 sid=null → if(sid && ...) false → 保留原 session（不变占位）
    assert.equal(result.allSessions[0]._cold, undefined, 'sid 为 null 的 session 不被替换为占位');
    assert.ok(Array.isArray(result.allSessions[0].messages), '保留原 messages');
  });

  it('totalSessions == hotCount 边界 → 全热（覆盖 <= 的等号臂）', () => {
    const sessions = [];
    const sessionIndex = [];
    const entries = [];
    for (let s = 0; s < 3; s++) {
      const sid = `2025-05-0${s + 1}T00:00:00Z`;
      entries.push(makeEntry(sid, sid));
      sessions.push(makeSessionL(2, sid));
      sessionIndex.push({ sessionId: sid, firstTs: sid, lastTs: sid, entryCount: 1, msgCount: 2, preview: `s${s}`, userId: 'u' });
    }
    const result = SM.splitHotCold(entries, sessions, sessionIndex, 3);
    assert.equal(result.hotEntries, entries, 'totalSessions==hotCount → 直接全热返回');
    assert.equal(result.coldGroups.size, 0);
  });

  it('pinned 数量已 >= hotCount → remaining<=0，热 slot 不再扩展', () => {
    const sessions = [];
    const sessionIndex = [];
    const entries = [];
    const sids = [];
    for (let s = 0; s < 5; s++) {
      const sid = `2025-06-0${s + 1}T00:00:00Z`;
      sids.push(sid);
      entries.push(makeEntry(sid, sid));
      sessions.push(makeSessionL(2, sid));
      sessionIndex.push({ sessionId: sid, firstTs: sid, lastTs: sid, entryCount: 1, msgCount: 2, preview: `s${s}`, userId: 'u' });
    }
    // pin 前 2 个，hotCount=2 → remaining=0，末尾填充循环 remaining>0 立即不进
    const pinned = new Set([sids[0], sids[1]]);
    const result = SM.splitHotCold(entries, sessions, sessionIndex, 2, pinned);
    // 热的只有 pinned 的 2 个；其余 3 个 cold
    assert.equal(result.allSessions[0]._cold, undefined);
    assert.equal(result.allSessions[1]._cold, undefined);
    assert.equal(result.allSessions[2]._cold, true);
    assert.equal(result.coldGroups.size, 3);
  });
});
