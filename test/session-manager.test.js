/**
 * Unit tests for src/utils/sessionManager.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOT_SESSION_COUNT,
  buildSessionIndex,
  splitHotCold,
  mergeSessionIndices,
  applyInPlaceLastMsgReplace,
  getSessionStableId,
  resolveDisplaySessions,
  getSessionActivityTs,
  getLatestSessionByActivity,
  resolveHydratedPin,
  runPinHydration,
  applyBatchEntryTimestamps,
} from '../src/utils/sessionManager.js';

// ─── Test helpers ─────────────────────────────────────────────────��───────────

function makeEntry(sessionId, ts, opts = {}) {
  return {
    _sessionId: sessionId,
    timestamp: ts,
    url: opts.url || 'https://api.anthropic.com/v1/messages',
    ...opts,
  };
}

function makeSession(msgCount, opts = {}) {
  const messages = [];
  for (let i = 0; i < msgCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const content = opts.userText && role === 'user' && i === 0
      ? opts.userText
      : `msg-${i}`;
    messages.push({ role, content });
  }
  return {
    userId: opts.userId || 'user-1',
    messages,
    response: { status: 200, body: {} },
    entryTimestamp: opts.entryTimestamp || null,
  };
}

// ─── HOT_SESSION_COUNT ───────────────────────────────────────────────────────

describe('HOT_SESSION_COUNT', () => {
  it('should be 8', () => {
    assert.equal(HOT_SESSION_COUNT, 8);
  });
});

// ─── buildSessionIndex ───────────────────────────────────────────────────────

describe('buildSessionIndex', () => {
  it('should build index from entries and sessions', () => {
    const sid0 = '2025-01-01T00:00:00Z';
    const sid1 = '2025-01-01T01:00:00Z';
    const entries = [
      makeEntry(sid0, '2025-01-01T00:00:00Z'),
      makeEntry(sid0, '2025-01-01T00:01:00Z'),
      makeEntry(sid1, '2025-01-01T01:00:00Z'),
      makeEntry(sid1, '2025-01-01T01:05:00Z'),
      makeEntry(sid1, '2025-01-01T01:10:00Z'),
    ];
    const sessions = [
      makeSession(4, { userId: 'alice', userText: 'Hello world', entryTimestamp: sid0 }),
      makeSession(6, { userId: 'bob', userText: 'Second session question', entryTimestamp: sid1 }),
    ];

    const index = buildSessionIndex(entries, sessions);

    assert.equal(index.length, 2);

    // Session 0
    assert.equal(index[0].sessionId, sid0);
    assert.equal(index[0].firstTs, '2025-01-01T00:00:00Z');
    assert.equal(index[0].lastTs, '2025-01-01T00:01:00Z');
    assert.equal(index[0].entryCount, 2);
    assert.equal(index[0].msgCount, 4);
    assert.equal(index[0].preview, 'Hello world');
    assert.equal(index[0].userId, 'alice');

    // Session 1
    assert.equal(index[1].sessionId, sid1);
    assert.equal(index[1].firstTs, '2025-01-01T01:00:00Z');
    assert.equal(index[1].lastTs, '2025-01-01T01:10:00Z');
    assert.equal(index[1].entryCount, 3);
    assert.equal(index[1].msgCount, 6);
    assert.equal(index[1].preview, 'Second session question');
    assert.equal(index[1].userId, 'bob');
  });

  it('should handle empty entries', () => {
    const index = buildSessionIndex([], []);
    assert.equal(index.length, 0);
  });

  it('should extract preview from array content blocks', () => {
    const sid = '2025-01-01T00:00:00Z';
    const entries = [makeEntry(sid, '2025-01-01T00:00:00Z')];
    const sessions = [{
      userId: 'u1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Array content preview' }] },
        { role: 'assistant', content: 'response' },
      ],
      response: {},
      entryTimestamp: sid,
    }];

    const index = buildSessionIndex(entries, sessions);
    assert.equal(index[0].preview, 'Array content preview');
  });

  it('should truncate preview to 80 characters', () => {
    const longText = 'A'.repeat(120);
    const sid = '2025-01-01T00:00:00Z';
    const entries = [makeEntry(sid, '2025-01-01T00:00:00Z')];
    const sessions = [makeSession(2, { userText: longText, entryTimestamp: sid })];

    const index = buildSessionIndex(entries, sessions);
    assert.equal(index[0].preview.length, 80);
  });

  it('should skip entries with null _sessionId', () => {
    const sid0 = '2025-01-01T00:00:00Z';
    const sid1 = '2025-01-01T01:00:00Z';
    const entries = [
      makeEntry(sid0, '2025-01-01T00:00:00Z'),
      { timestamp: '2025-01-01T00:30:00Z', url: 'x', _sessionId: undefined },
      makeEntry(sid1, '2025-01-01T01:00:00Z'),
    ];
    const sessions = [
      makeSession(2, { entryTimestamp: sid0 }),
      makeSession(2, { entryTimestamp: sid1 }),
    ];

    const index = buildSessionIndex(entries, sessions);
    assert.equal(index[0].entryCount, 1);
    assert.equal(index[1].entryCount, 1);
  });

  it('should handle sessions without matching entry groups', () => {
    const sid0 = '2025-01-01T00:00:00Z';
    const sid1 = '2025-01-01T01:00:00Z';
    const entries = [makeEntry(sid0, '2025-01-01T00:00:00Z')];
    const sessions = [
      makeSession(2, { entryTimestamp: sid0 }),
      makeSession(3, { entryTimestamp: sid1 }),
    ];

    const index = buildSessionIndex(entries, sessions);
    assert.equal(index.length, 2);
    assert.equal(index[0].entryCount, 1);
    assert.equal(index[1].entryCount, 0); // no entries for session 1
    assert.equal(index[1].msgCount, 3);
  });

  it('should use entryTimestamp as fallback for lastTs', () => {
    const sid = '2025-06-01T00:00:00Z';
    const entries = [{ _sessionId: sid, url: 'x' }]; // no timestamp
    const sessions = [makeSession(2, { entryTimestamp: sid })];

    const index = buildSessionIndex(entries, sessions);
    // firstTs/lastTs from entries are null, lastTs falls back to entryTimestamp
    assert.equal(index[0].lastTs, '2025-06-01T00:00:00Z');
  });
});

// ─── splitHotCold ────────────────────────────────────────────────────────────

describe('splitHotCold', () => {
  function makeScenario(sessionCount) {
    const entries = [];
    const sessions = [];
    const sessionIndex = [];
    for (let s = 0; s < sessionCount; s++) {
      const ts = `2025-01-${String(s + 1).padStart(2, '0')}T00:00:00Z`;
      entries.push(makeEntry(ts, ts));
      entries.push(makeEntry(ts, ts));
      sessions.push(makeSession(4, { userId: `user-${s}`, userText: `Session ${s}`, entryTimestamp: ts }));
      sessionIndex.push({
        sessionId: ts,
        firstTs: ts,
        lastTs: ts,
        entryCount: 2,
        msgCount: 4,
        preview: `Session ${s}`,
        userId: `user-${s}`,
      });
    }
    return { entries, sessions, sessionIndex };
  }

  it('should return all entries as hot when sessions <= hotCount', () => {
    const { entries, sessions, sessionIndex } = makeScenario(5);
    const result = splitHotCold(entries, sessions, sessionIndex, 8);

    assert.equal(result.hotEntries, entries); // same reference
    assert.equal(result.allSessions, sessions);
    assert.equal(result.coldGroups.size, 0);
  });

  it('should split hot and cold when sessions > hotCount', () => {
    const { entries, sessions, sessionIndex } = makeScenario(12);
    const result = splitHotCold(entries, sessions, sessionIndex, 8);

    // 12 sessions, hot = last 8 (idx 4-11), cold = first 4 (idx 0-3)
    assert.equal(result.hotEntries.length, 16); // 8 sessions * 2 entries each
    assert.equal(result.coldGroups.size, 4);
    assert.equal(result.allSessions.length, 12);

    // Verify cold sessions are placeholders
    for (let i = 0; i < 4; i++) {
      assert.equal(result.allSessions[i]._cold, true);
      assert.equal(result.allSessions[i].messages, null);
      assert.equal(result.allSessions[i].response, null);
      assert.equal(result.allSessions[i].sessionId, sessionIndex[i].sessionId);
      assert.equal(result.allSessions[i].preview, `Session ${i}`);
      assert.equal(result.allSessions[i].userId, `user-${i}`);
    }

    // Verify hot sessions are unchanged
    for (let i = 4; i < 12; i++) {
      assert.equal(result.allSessions[i]._cold, undefined);
      assert.ok(Array.isArray(result.allSessions[i].messages));
    }

    // Verify cold groups contain correct entries
    for (let i = 0; i < 4; i++) {
      const sid = sessionIndex[i].sessionId;
      const group = result.coldGroups.get(sid);
      assert.ok(group);
      assert.equal(group.length, 2);
      assert.equal(group[0]._sessionId, sid);
    }

    // Verify hot entries all have sessionId in hot range
    const hotSids = new Set(sessionIndex.slice(4).map(s => s.sessionId));
    for (const e of result.hotEntries) {
      assert.ok(hotSids.has(e._sessionId));
    }
  });

  it('should handle exact hotCount match', () => {
    const { entries, sessions, sessionIndex } = makeScenario(8);
    const result = splitHotCold(entries, sessions, sessionIndex, 8);

    assert.equal(result.hotEntries, entries);
    assert.equal(result.coldGroups.size, 0);
  });

  it('should handle hotCount of 1', () => {
    const { entries, sessions, sessionIndex } = makeScenario(3);
    const result = splitHotCold(entries, sessions, sessionIndex, 1);

    // Only the last session is hot
    assert.equal(result.hotEntries.length, 2);
    assert.equal(result.coldGroups.size, 2);
    assert.equal(result.allSessions[0]._cold, true);
    assert.equal(result.allSessions[1]._cold, true);
    assert.equal(result.allSessions[2]._cold, undefined);
  });

  it('should pin sessions to prevent eviction', () => {
    const { entries, sessions, sessionIndex } = makeScenario(12);
    // Pin session 0 (cold by default) — it should stay hot
    const pinnedId = sessionIndex[0].sessionId;
    const result = splitHotCold(entries, sessions, sessionIndex, 8, new Set([pinnedId]));

    // Session 0 is pinned, so it should be hot (not cold)
    assert.equal(result.allSessions[0]._cold, undefined);
    assert.ok(Array.isArray(result.allSessions[0].messages));

    // Pinned session's entries should be in hotEntries
    const pinnedEntries = result.hotEntries.filter(e => e._sessionId === pinnedId);
    assert.equal(pinnedEntries.length, 2);

    // One additional session should become cold to make room for the pinned one
    // Total cold should be 4 (12 - 8), with 1 pinned, means 4 cold sessions
    assert.equal(result.coldGroups.size, 4);
    assert.ok(!result.coldGroups.has(pinnedId));
  });
});

// ─── mergeSessionIndices ─────────────────────────────────────────────────────

describe('mergeSessionIndices', () => {
  function idx(sessionId, preview) {
    return { sessionId, preview, firstTs: null, lastTs: null, entryCount: 0, msgCount: 0, userId: null };
  }

  it('should return newIndex when oldIndex is empty', () => {
    const result = mergeSessionIndices([], [idx('ts-a', 'a'), idx('ts-b', 'b')]);
    assert.equal(result.length, 2);
    assert.equal(result[0].preview, 'a');
  });

  it('should return oldIndex when newIndex is empty', () => {
    const result = mergeSessionIndices([idx('ts-a', 'a')], []);
    assert.equal(result.length, 1);
    assert.equal(result[0].preview, 'a');
  });

  it('should return newIndex when oldIndex is null', () => {
    const result = mergeSessionIndices(null, [idx('ts-a', 'a')]);
    assert.equal(result.length, 1);
  });

  it('should return empty array when both are null', () => {
    const result = mergeSessionIndices(null, null);
    assert.equal(result.length, 0);
  });

  it('should merge non-overlapping indices', () => {
    const old = [idx('2025-01-01T00:00:00Z', 'old-0'), idx('2025-01-01T01:00:00Z', 'old-1')];
    const nw = [idx('2025-01-01T02:00:00Z', 'new-2'), idx('2025-01-01T03:00:00Z', 'new-3')];
    const result = mergeSessionIndices(old, nw);

    assert.equal(result.length, 4);
    assert.equal(result[0].preview, 'old-0');
    assert.equal(result[1].preview, 'old-1');
    assert.equal(result[2].preview, 'new-2');
    assert.equal(result[3].preview, 'new-3');
  });

  it('should overwrite overlapping indices with new values', () => {
    const old = [idx('ts-0', 'old-0'), idx('ts-1', 'old-1'), idx('ts-2', 'old-2')];
    const nw = [idx('ts-1', 'new-1'), idx('ts-2', 'new-2'), idx('ts-3', 'new-3')];
    const result = mergeSessionIndices(old, nw);

    assert.equal(result.length, 4);
    assert.equal(result[0].preview, 'old-0');  // kept from old
    assert.equal(result[1].preview, 'new-1');  // overwritten by new
    assert.equal(result[2].preview, 'new-2');  // overwritten by new
    assert.equal(result[3].preview, 'new-3');  // from new
  });

  it('should sort result by sessionId', () => {
    const old = [idx('ts-c', 'old-c')];
    const nw = [idx('ts-a', 'new-a'), idx('ts-b', 'new-b')];
    const result = mergeSessionIndices(old, nw);

    assert.equal(result.length, 3);
    assert.equal(result[0].sessionId, 'ts-a');
    assert.equal(result[1].sessionId, 'ts-b');
    assert.equal(result[2].sessionId, 'ts-c');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyInPlaceLastMsgReplace — 信号驱动短路（消费服务端 _inPlaceReplaceDetected）
// 防 SUGGESTION MODE → 用户真实输入替换末位时 sessionMerge prefix-overlap 翻倍
// （实证 cc-viewer 自身复现：jsonl 中 _inPlaceReplaceDetected:true 与 BUG 1:1 对应）
// ─────────────────────────────────────────────────────────────────────────────

describe('applyInPlaceLastMsgReplace', () => {
  function makeMsg(role, text) {
    return { role, content: [{ type: 'text', text }], _timestamp: '2026-05-09T10:00:00Z' };
  }
  function makeSessionLocal(messages, userId = 'u1') {
    return { userId, messages, response: { status: 200, body: {} }, entryTimestamp: '2026-05-09T10:00:00Z' };
  }

  it('命中信号 → in-place 替换末位（前 N-1 引用稳定，长度不翻倍）', () => {
    const m0 = makeMsg('user', 'hi');
    const m1 = makeMsg('assistant', 'hello');
    const m2_old = makeMsg('user', '[SUGGESTION MODE: ...]');
    const session = makeSessionLocal([m0, m1, m2_old]);
    const prevSessions = [session];

    const m2_new = makeMsg('user', '继续关闭 @hunter-D');
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      response: { status: 200, body: { content: [] } },
      body: { messages: [m0, m1, m2_new] },  // length 3，跟 prev 一致
    };

    // 前置 invariant assert（防 fixture 漂移）：触发短路要求两边长度完全一致
    assert.equal(entry.body.messages.length, session.messages.length, 'fixture invariant: entry/session 长度必须相等');

    const result = applyInPlaceLastMsgReplace(prevSessions, entry, '2026-05-09T11:10:03Z', false);

    assert.equal(result.applied, true, '应该命中短路');
    assert.equal(result.sessions.length, 1, 'sessions 数组长度不变');
    const newLast = result.sessions[0];
    assert.equal(newLast.messages.length, 3, '末位 in-place 替换后长度仍 = 3（不翻倍）');
    assert.strictEqual(newLast.messages[0], m0, '前 N-1 条 message[0] 引用复用');
    assert.strictEqual(newLast.messages[1], m1, '前 N-1 条 message[1] 引用复用');
    assert.strictEqual(newLast.messages[2], m2_new, '末位用 entry.body.messages[N-1] 新引用');
    assert.notStrictEqual(newLast, session, 'lastSession 引用变化（让 ChatView _sessionItemCache 失效触发重渲染）');
  });

  it('未命中信号（无 _inPlaceReplaceDetected）→ applied=false 让 fallback 到 mergeMainAgentSessions', () => {
    const m0 = makeMsg('user', 'hi');
    const m1 = makeMsg('assistant', 'hello');
    const session = makeSessionLocal([m0, m1]);
    const entry = {
      _isCheckpoint: true,
      // _inPlaceReplaceDetected: undefined ← 故意不设
      timestamp: '2026-05-09T11:10:03Z',
      body: { messages: [m0, m1] },
    };

    const result = applyInPlaceLastMsgReplace([session], entry, '2026-05-09T11:10:03Z', false);
    assert.equal(result.applied, false, '无信号字段时不应短路');
  });

  it('isNewSession=true → applied=false（不破坏新 session 起点语义）', () => {
    const m0 = makeMsg('user', 'fresh');
    const session = makeSessionLocal([m0]);
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      body: { messages: [m0] },
    };
    const result = applyInPlaceLastMsgReplace([session], entry, '2026-05-09T11:10:03Z', /*isNewSession*/ true);
    assert.equal(result.applied, false, 'isNewSession=true 时不应短路（让 mergeMainAgentSessions 处理新 session 起点）');
  });

  it('messages.length 不一致 → applied=false（防误吃增量 push 场景）', () => {
    const m0 = makeMsg('user', 'hi');
    const session = makeSessionLocal([m0]);
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      body: { messages: [m0, makeMsg('assistant', 'new')] },  // length 2 ≠ session.messages.length 1
    };
    const result = applyInPlaceLastMsgReplace([session], entry, '2026-05-09T11:10:03Z', false);
    assert.equal(result.applied, false, '长度不一致时不应短路（普通 push 走 mergeMainAgentSessions 即可）');
  });

  it('空 prevSessions → applied=false（首条 entry 走 mergeMainAgentSessions 创建初始 session）', () => {
    const m0 = makeMsg('user', 'hi');
    const m1 = makeMsg('assistant', 'a');
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      response: { status: 200, body: {} },
      body: { messages: [m0, m1] },
    };
    const result = applyInPlaceLastMsgReplace([], entry, '2026-05-09T11:10:03Z', false);
    assert.equal(result.applied, false);
  });

  // 新增防御性 case（reviewer 采纳建议）：
  it('messages.length > currentLen → applied=false（防意外消费信号导致丢消息）', () => {
    const m0 = makeMsg('user', 'hi');
    const session = makeSessionLocal([m0]);
    const m1 = makeMsg('assistant', 'a');
    const m2 = makeMsg('user', 'q');
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      response: { status: 200, body: {} },
      body: { messages: [m0, m1, m2] },  // length 3 > session.messages.length 1
    };
    const result = applyInPlaceLastMsgReplace([session], entry, '2026-05-09T11:10:03Z', false);
    assert.equal(result.applied, false, '长度不一致（>）应 fallback 让 mergeMainAgentSessions 走增量 push');
  });

  it('entry.response 缺失（inProgress 异常）→ applied=false 防 ChatView Last Response 污染', () => {
    const m0 = makeMsg('user', 'hi');
    const m1 = makeMsg('assistant', 'a');
    const m2_old = makeMsg('user', 'old');
    const session = makeSessionLocal([m0, m1, m2_old]);
    const m2_new = makeMsg('user', 'new');
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      // response: undefined ← 故意省略
      body: { messages: [m0, m1, m2_new] },
    };
    const result = applyInPlaceLastMsgReplace([session], entry, '2026-05-09T11:10:03Z', false);
    assert.equal(result.applied, false, '无 response 时不应短路（防 newLastSession.response=undefined 污染下游）');
  });

  it('messages.length < 2 → applied=false（单消息退化为完全替换不安全，让原路径处理）', () => {
    const m0_old = makeMsg('user', 'old');
    const session = makeSessionLocal([m0_old]);
    const m0_new = makeMsg('user', 'new');
    const entry = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      response: { status: 200, body: {} },
      body: { messages: [m0_new] },  // length 1
    };
    const result = applyInPlaceLastMsgReplace([session], entry, '2026-05-09T11:10:03Z', false);
    assert.equal(result.applied, false, 'N=1 时不应走 in-place 短路（前 N-1 退化为空 = 完全替换，不符合 helper 语义）');
  });

  // 新增（review R3 任务 2 缺口）：_inPlaceReplaceDetected:true 但 _isCheckpoint 缺失/false
  it('_inPlaceReplaceDetected=true 但 _isCheckpoint 缺失 → applied=false（双信号必须齐发）', () => {
    const m0 = makeMsg('user', 'hi');
    const m1 = makeMsg('assistant', 'old');
    const session = makeSessionLocal([m0, m1]);
    const m1_new = makeMsg('assistant', 'new');
    const entry = {
      _inPlaceReplaceDetected: true,
      // _isCheckpoint: undefined ← 故意省略，模拟服务端协议变更或漏写
      timestamp: '2026-05-09T11:10:03Z',
      response: { status: 200, body: {} },
      body: { messages: [m0, m1_new] },
    };
    const result = applyInPlaceLastMsgReplace([session], entry, '2026-05-09T11:10:03Z', false);
    assert.equal(result.applied, false, '双信号未齐发不应短路（防服务端协议变更下 in-place 误触发污染下游）');
  });

  // 新增（D 块）：fallback 计数器机制 — 信号到达但守卫拒绝时计数应增加
  it('fallback 计数器：信号到达但守卫拒绝时累加分类计数', () => {
    // 重置计数防本次 case 之前累积干扰
    applyInPlaceLastMsgReplace.fallbackCount = Object.create(null);
    applyInPlaceLastMsgReplace.appliedCount = 0;

    const m0 = makeMsg('user', 'hi');
    const session = makeSessionLocal([m0]);

    // 触发 length-mismatch 路径
    const entry1 = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      response: { status: 200, body: {} },
      body: { messages: [m0, makeMsg('assistant', 'a'), makeMsg('user', 'b')] },
    };
    applyInPlaceLastMsgReplace([session], entry1, '2026-05-09T11:10:03Z', false);
    assert.equal(applyInPlaceLastMsgReplace.fallbackCount['length-mismatch'], 1, 'length-mismatch 应计数');

    // 触发 response-missing 路径
    const session2 = makeSessionLocal([m0, makeMsg('assistant', 'a'), makeMsg('user', 'b')]);
    const entry2 = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      // response 缺失
      body: { messages: [m0, makeMsg('assistant', 'a'), makeMsg('user', 'c')] },
    };
    applyInPlaceLastMsgReplace([session2], entry2, '2026-05-09T11:10:03Z', false);
    assert.equal(applyInPlaceLastMsgReplace.fallbackCount['response-missing'], 1, 'response-missing 应计数');

    // 触发 messages-too-short 路径
    const entry3 = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      response: { status: 200, body: {} },
      body: { messages: [m0] },
    };
    applyInPlaceLastMsgReplace([session], entry3, '2026-05-09T11:10:03Z', false);
    assert.equal(applyInPlaceLastMsgReplace.fallbackCount['messages-too-short'], 1, 'messages-too-short 应计数');

    // 无信号路径不计数（防 SSE 高频流量淹没）
    const entry4 = {
      timestamp: '2026-05-09T11:10:03Z',
      body: { messages: [m0] },
    };
    applyInPlaceLastMsgReplace([session], entry4, '2026-05-09T11:10:03Z', false);
    assert.equal(applyInPlaceLastMsgReplace.fallbackCount['no-signal'], undefined, '无信号路径不应计入 fallbackCount');

    // applied 路径累加 appliedCount
    const session3 = makeSessionLocal([m0, makeMsg('assistant', 'old')]);
    const entry5 = {
      _isCheckpoint: true,
      _inPlaceReplaceDetected: true,
      timestamp: '2026-05-09T11:10:03Z',
      response: { status: 200, body: {} },
      body: { messages: [m0, makeMsg('assistant', 'new')] },
    };
    const result = applyInPlaceLastMsgReplace([session3], entry5, '2026-05-09T11:10:03Z', false);
    assert.equal(result.applied, true);
    assert.equal(applyInPlaceLastMsgReplace.appliedCount, 1, 'applied 路径应累加 appliedCount');
  });
});

// ─── getSessionStableId ──────────────────────────────────────────────────────

// 构造一个带 messages[0]._timestamp 的热 session
function pinnedSession(startTs, msgCount = 2) {
  const messages = [];
  for (let i = 0; i < msgCount; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, _timestamp: i === 0 ? startTs : `${startTs}#${i}` });
  }
  // entryTimestamp 故意设成「漂移后的最新 ts」，确保 stable id 不取它
  return { userId: 'u1', messages, response: { status: 200, body: {} }, entryTimestamp: `${startTs}#drifted` };
}

describe('getSessionStableId', () => {
  it('热 session 取 messages[0]._timestamp（而非漂移的 entryTimestamp）', () => {
    const s = pinnedSession('2025-01-01T00:00:00Z');
    assert.equal(getSessionStableId(s), '2025-01-01T00:00:00Z');
  });

  it('冷 session 取 sessionId', () => {
    const cold = { _cold: true, sessionId: '2025-01-01T02:00:00Z', messages: null, entryTimestamp: '2025-01-01T02:30:00Z' };
    assert.equal(getSessionStableId(cold), '2025-01-01T02:00:00Z');
  });

  it('null / 空 session 返回 null', () => {
    assert.equal(getSessionStableId(null), null);
    assert.equal(getSessionStableId({ messages: [] }), null);
  });
});

// ─── resolveDisplaySessions ──────────────────────────────────────────────────

describe('resolveDisplaySessions', () => {
  const s0 = pinnedSession('2025-01-01T00:00:00Z');
  const s1 = pinnedSession('2025-01-01T01:00:00Z');
  const s2 = pinnedSession('2025-01-01T02:00:00Z');
  const sessions = [s0, s1, s2];

  it('未开「仅展示当前会话」→ 原样返回，无上界', () => {
    const r = resolveDisplaySessions(sessions, '2025-01-01T00:00:00Z', false);
    assert.equal(r.sessions, sessions);
    assert.equal(r.upperBoundTs, null);
  });

  it('无 pin → 原样返回', () => {
    const r = resolveDisplaySessions(sessions, null, true);
    assert.equal(r.sessions, sessions);
    assert.equal(r.upperBoundTs, null);
  });

  it('pin == 最新会话 → 原样返回（与今天行为一致，不切片）', () => {
    const r = resolveDisplaySessions(sessions, '2025-01-01T02:00:00Z', true);
    assert.equal(r.sessions, sessions);
    assert.equal(r.upperBoundTs, null);
  });

  it('pin 在中段 → 切到以 pin 会话结尾，上界 = 下一会话起点', () => {
    const r = resolveDisplaySessions(sessions, '2025-01-01T01:00:00Z', true);
    assert.deepEqual(r.sessions, [s0, s1]);
    assert.equal(r.sessions.length, 2);
    assert.equal(r.upperBoundTs, '2025-01-01T02:00:00Z');
  });

  it('mid-list pin that IS the latest-by-activity → sliced but NO upper bound (it is the current session)', () => {
    // Multi-terminal case: the pinned session sits mid-list by insertion order
    // but carries the newest activity. A non-null bound would suppress the live
    // streaming overlay and truncate trailing sub-agents on the current session.
    const mid = pinnedSession('2025-01-01T01:00:00Z');
    mid.entryTimestamp = '2025-01-01T09:00:00Z'; // newest activity
    const tail = pinnedSession('2025-01-01T02:00:00Z');
    tail.entryTimestamp = '2025-01-01T03:00:00Z';
    const list = [s0, mid, tail];
    const r = resolveDisplaySessions(list, '2025-01-01T01:00:00Z', true);
    assert.deepEqual(r.sessions, [s0, mid], 'still sliced to end at the pin');
    assert.equal(r.upperBoundTs, null, 'no strictly-newer session to bound against');
  });

  it('pin 是首个会话且有更晚会话 → 仅含该会话，上界 = 第二个会话起点', () => {
    const r = resolveDisplaySessions(sessions, '2025-01-01T00:00:00Z', true);
    assert.deepEqual(r.sessions, [s0]);
    assert.equal(r.upperBoundTs, '2025-01-01T01:00:00Z');
  });

  it('pin 已失效（不在列表）→ 回退原样（展示最新）', () => {
    const r = resolveDisplaySessions(sessions, '1999-01-01T00:00:00Z', true);
    assert.equal(r.sessions, sessions);
    assert.equal(r.upperBoundTs, null);
  });

  it('pin 命中冷 session（按 sessionId 匹配）→ 切片 + 上界', () => {
    const cold = { _cold: true, sessionId: '2025-01-01T00:00:00Z', messages: null };
    const r = resolveDisplaySessions([cold, s1, s2], '2025-01-01T00:00:00Z', true);
    assert.deepEqual(r.sessions, [cold]);
    assert.equal(r.upperBoundTs, '2025-01-01T01:00:00Z');
  });

  it('空列表 → 原样返回', () => {
    const r = resolveDisplaySessions([], '2025-01-01T00:00:00Z', true);
    assert.deepEqual(r.sessions, []);
    assert.equal(r.upperBoundTs, null);
  });
});

// ─── getSessionActivityTs ────────────────────────────────────────────────────

function hotSession(startTs, activityTs, opts = {}) {
  const s = makeSession(opts.msgCount || 4, { userId: opts.userId || 'user-1', entryTimestamp: activityTs });
  s.messages[0]._timestamp = startTs;
  return s;
}

function coldSession(sessionId, lastTs) {
  return { _cold: true, sessionId, lastTs, entryTimestamp: lastTs, messages: null, response: null, userId: 'user-1' };
}

describe('getSessionActivityTs', () => {
  it('hot session → entryTimestamp (drifts to newest merged entry by design)', () => {
    const s = hotSession('2026-07-01T00:00:00.000Z', '2026-07-01T05:00:00.000Z');
    assert.equal(getSessionActivityTs(s), '2026-07-01T05:00:00.000Z');
  });

  it('hot session without entryTimestamp → last message _timestamp', () => {
    const s = makeSession(3, { entryTimestamp: null });
    s.messages[2]._timestamp = '2026-07-01T02:00:00.000Z';
    assert.equal(getSessionActivityTs(s), '2026-07-01T02:00:00.000Z');
  });

  it('cold placeholder → lastTs', () => {
    const s = coldSession('2026-07-01T00:00:00.000Z', '2026-07-01T03:00:00.000Z');
    assert.equal(getSessionActivityTs(s), '2026-07-01T03:00:00.000Z');
  });

  it('cold without lastTs → entryTimestamp, then sessionId', () => {
    const viaEntryTs = { _cold: true, sessionId: 'sid-1', lastTs: null, entryTimestamp: '2026-07-01T04:00:00.000Z', messages: null };
    assert.equal(getSessionActivityTs(viaEntryTs), '2026-07-01T04:00:00.000Z');
    const viaSessionId = { _cold: true, sessionId: 'sid-2', lastTs: null, entryTimestamp: null, messages: null };
    assert.equal(getSessionActivityTs(viaSessionId), 'sid-2');
  });

  it('hot without entryTimestamp and without message ts → stable id fallback', () => {
    const s = makeSession(2, { entryTimestamp: null });
    s.messages[0]._timestamp = '2026-07-01T01:00:00.000Z'; // stable id, last msg unstamped
    assert.equal(getSessionActivityTs(s), '2026-07-01T01:00:00.000Z');
  });

  it('null session → null', () => {
    assert.equal(getSessionActivityTs(null), null);
  });
});

// ─── getLatestSessionByActivity ──────────────────────────────────────────────

describe('getLatestSessionByActivity', () => {
  it('Defect-1 regression: mid-list session with newer activity beats last-positioned older one', () => {
    // Interleaved multi-terminal merge order: session B was inserted last, but
    // session A received the most recent entry. "Last element" is the bug.
    const a = hotSession('2026-07-01T00:00:00.000Z', '2026-07-01T09:00:00.000Z');
    const b = hotSession('2026-07-01T01:00:00.000Z', '2026-07-01T08:00:00.000Z');
    assert.equal(getLatestSessionByActivity([a, b]), a);
  });

  it('suffix-truncated replay still resolves the true latest (not list tail)', () => {
    // Reconnect replays only the last N entries; whatever order the rebuilt list
    // has, the max-activity session must win. Simulate a 40-session interleave
    // where an early-positioned session carries the newest activity, then take a
    // suffix slice like the replay window does.
    const sessions = [];
    for (let i = 0; i < 40; i++) {
      sessions.push(hotSession(
        `2026-07-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        `2026-07-01T10:${String(39 - i).padStart(2, '0')}:00.000Z`, // reverse: earliest position = newest activity
      ));
    }
    const windowed = sessions.slice(-25);
    assert.equal(getLatestSessionByActivity(windowed), windowed[0]);
  });

  it('cold placeholder with the max activity ts is skipped — best hot session wins', () => {
    // A cold winner would pin the view to a "loading" placeholder and hide the
    // live conversation; cold lastTs can also be misaligned (positional index).
    const cold = coldSession('2026-07-01T00:00:00.000Z', '2026-07-01T23:00:00.000Z');
    const hot = hotSession('2026-07-01T01:00:00.000Z', '2026-07-01T09:00:00.000Z');
    assert.equal(getLatestSessionByActivity([cold, hot]), hot);
  });

  it('all-cold list → null (never pin to a "loading" placeholder; caller fallback takes over)', () => {
    const c1 = coldSession('s1', '2026-07-01T05:00:00.000Z');
    const c2 = coldSession('s2', '2026-07-01T01:00:00.000Z');
    assert.equal(getLatestSessionByActivity([c1, c2]), null);
  });

  it('null-activity session never hijacks the pick from a genuinely newer one', () => {
    // Regression: the old loop let a ts===null candidate always replace `best`
    // without advancing bestTs, so a timestamp-less session sitting after the
    // true latest would win — the exact wrong-anchor class this helper fixes.
    const a = hotSession('2026-07-01T00:00:00.000Z', '2026-07-01T09:00:00.000Z');
    const b = makeSession(2, { entryTimestamp: null }); // no usable ts anywhere
    const c = hotSession('2026-07-01T01:00:00.000Z', '2026-07-01T05:00:00.000Z');
    assert.equal(getLatestSessionByActivity([a, b]), a);
    assert.equal(getLatestSessionByActivity([a, b, c]), a);
  });

  it('all-null activity ts degrades to the last element (behavior preservation)', () => {
    const s1 = makeSession(2, { entryTimestamp: null });
    const s2 = makeSession(2, { entryTimestamp: null });
    assert.equal(getLatestSessionByActivity([s1, s2]), s2);
  });

  it('tie resolves to the later list position', () => {
    const ts = '2026-07-01T07:00:00.000Z';
    const s1 = hotSession('2026-07-01T00:00:00.000Z', ts);
    const s2 = hotSession('2026-07-01T01:00:00.000Z', ts);
    assert.equal(getLatestSessionByActivity([s1, s2]), s2);
  });

  it('empty / non-array → null', () => {
    assert.equal(getLatestSessionByActivity([]), null);
    assert.equal(getLatestSessionByActivity(null), null);
    assert.equal(getLatestSessionByActivity(undefined), null);
  });
});

// ─── resolveHydratedPin ──────────────────────────────────────────────────────

describe('resolveHydratedPin', () => {
  it('toggle off → adopt remote string as-is', () => {
    assert.deepEqual(resolveHydratedPin('t1', 't9', false), { adopt: true, value: 't1' });
  });

  it('toggle off → adopt remote null (and normalizes non-strings)', () => {
    assert.deepEqual(resolveHydratedPin(null, 't9', false), { adopt: true, value: null });
    assert.deepEqual(resolveHydratedPin(undefined, 't9', false), { adopt: true, value: null });
    assert.deepEqual(resolveHydratedPin('', 't9', false), { adopt: true, value: null });
    assert.deepEqual(resolveHydratedPin(42, 't9', false), { adopt: true, value: null });
  });

  it('toggle on + no derived latest (sessions not loaded) → adopt remote', () => {
    assert.deepEqual(resolveHydratedPin('t1', null, true), { adopt: true, value: 't1' });
  });

  it('toggle on + remote === derived → adopt', () => {
    assert.deepEqual(resolveHydratedPin('t9', 't9', true), { adopt: true, value: 't9' });
  });

  it('toggle on + stale remote → reject, value = derived latest', () => {
    assert.deepEqual(resolveHydratedPin('t1', 't9', true), { adopt: false, value: 't9' });
  });

  it('toggle on + remote null + derived exists → reject (derive locally)', () => {
    assert.deepEqual(resolveHydratedPin(null, 't9', true), { adopt: false, value: 't9' });
  });
});

// ─── runPinHydration ─────────────────────────────────────────────────────────

describe('runPinHydration', () => {
  function makeHarness({ remote, derived, effOnly = true, localPin = null, current = () => true }) {
    const calls = [];
    let resolveFetch;
    const fetchPromise = new Promise((res) => { resolveFetch = res; });
    const run = runPinHydration({
      fetchPin: () => fetchPromise,
      isCurrent: current,
      getDerived: () => derived,
      effOnly: () => effOnly,
      getLocalPin: () => localPin,
      adopt: (v) => calls.push(['adopt', v]),
      persistLocal: () => calls.push(['persist']),
      clearGate: () => calls.push(['clearGate']),
      selfHeal: () => calls.push(['selfHeal']),
    });
    return { calls, run, resolve: () => resolveFetch(remote) };
  }

  it('adopt path: remote differs from local → adopt(remote), then clearGate before selfHeal', async () => {
    const h = makeHarness({ remote: 't9', derived: 't9', localPin: 't1' });
    h.resolve();
    await h.run;
    assert.deepEqual(h.calls, [['adopt', 't9'], ['clearGate'], ['selfHeal']]);
  });

  it('adopt path: remote equals local → no adopt call (no redundant setState)', async () => {
    const h = makeHarness({ remote: 't9', derived: 't9', localPin: 't9' });
    h.resolve();
    await h.run;
    assert.deepEqual(h.calls, [['clearGate'], ['selfHeal']]);
  });

  it('gate is cleared BEFORE self-heal (inverted order would silently no-op follow-latest)', async () => {
    const h = makeHarness({ remote: 't1', derived: 't9', localPin: 't1' });
    h.resolve();
    await h.run;
    const gateIdx = h.calls.findIndex(c => c[0] === 'clearGate');
    const healIdx = h.calls.findIndex(c => c[0] === 'selfHeal');
    assert.ok(gateIdx !== -1 && healIdx !== -1 && gateIdx < healIdx,
      `clearGate must precede selfHeal, got ${JSON.stringify(h.calls)}`);
  });

  it('rejected stale remote + local already at derived → persistLocal (heals poisoned server pin)', async () => {
    const h = makeHarness({ remote: 't1', derived: 't9', localPin: 't9' });
    h.resolve();
    await h.run;
    assert.deepEqual(h.calls, [['persist'], ['clearGate'], ['selfHeal']]);
  });

  it('rejected stale remote + local NOT at derived → no persist here (selfHeal advances + persists)', async () => {
    const h = makeHarness({ remote: 't1', derived: 't9', localPin: 't5' });
    h.resolve();
    await h.run;
    assert.deepEqual(h.calls, [['clearGate'], ['selfHeal']]);
  });

  it('superseded GET is fully discarded — no adopt, no gate touch (newer round owns it)', async () => {
    const h = makeHarness({ remote: 't1', derived: 't9', localPin: 't9', current: () => false });
    h.resolve();
    await h.run;
    assert.deepEqual(h.calls, []);
  });

  it('supersession that happens between resolve and finally does not clear the newer gate', async () => {
    let currentFlag = true;
    const calls = [];
    let resolveFetch;
    const run = runPinHydration({
      fetchPin: () => new Promise((res) => { resolveFetch = res; }),
      isCurrent: () => currentFlag,
      getDerived: () => 't9',
      effOnly: () => true,
      getLocalPin: () => 't1',
      adopt: (v) => { calls.push(['adopt', v]); currentFlag = false; }, // superseded mid-flight
      persistLocal: () => calls.push(['persist']),
      clearGate: () => calls.push(['clearGate']),
      selfHeal: () => calls.push(['selfHeal']),
    });
    resolveFetch('t9');
    await run;
    assert.deepEqual(calls, [['adopt', 't9']]);
  });

  it('fetch rejection still clears the gate and self-heals', async () => {
    const calls = [];
    await runPinHydration({
      fetchPin: () => Promise.reject(new Error('network')),
      isCurrent: () => true,
      getDerived: () => 't9',
      effOnly: () => true,
      getLocalPin: () => 't1',
      adopt: () => calls.push(['adopt']),
      persistLocal: () => calls.push(['persist']),
      clearGate: () => calls.push(['clearGate']),
      selfHeal: () => calls.push(['selfHeal']),
    });
    assert.deepEqual(calls, [['clearGate'], ['selfHeal']]);
  });

  it('toggle off → adopts remote verbatim even when derived differs', async () => {
    const h = makeHarness({ remote: 't1', derived: 't9', localPin: 't9', effOnly: false });
    h.resolve();
    await h.run;
    assert.deepEqual(h.calls, [['adopt', 't1'], ['clearGate'], ['selfHeal']]);
  });
});

// ─── applyBatchEntryTimestamps ───────────────────────────────────────────────

describe('applyBatchEntryTimestamps', () => {
  function freshSt() {
    return { timestamps: [], generatedTimestamps: [], currentSessionId: null, prevUserId: null, prevMainAgentTs: null };
  }

  function batchEntry(msgCount, ts, { userId = 'u1', firstText = 'hello', slimmed = false, compactFlag } = {}) {
    const messages = [];
    for (let i = 0; i < msgCount; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: i === 0 ? firstText : `m${i}` });
    }
    const e = {
      timestamp: ts,
      mainAgent: true,
      body: { messages: slimmed ? [] : messages, metadata: { user_id: userId } },
    };
    if (slimmed) { e._slimmed = true; e._messageCount = msgCount; }
    if (compactFlag !== undefined) e._compactContinuation = compactFlag;
    return e;
  }

  it('first entry seeds currentSessionId and stamps all positions with its ts', () => {
    const st = freshSt();
    const e = batchEntry(4, '2026-07-01T00:00:00.000Z');
    applyBatchEntryTimestamps(st, e);
    assert.equal(st.currentSessionId, '2026-07-01T00:00:00.000Z');
    assert.equal(st.timestamps.length, 4);
    assert.equal(e.body.messages[0]._timestamp, '2026-07-01T00:00:00.000Z');
  });

  it('same-session growth extends without resetting (positions keep first-seen ts)', () => {
    const st = freshSt();
    applyBatchEntryTimestamps(st, batchEntry(4, '2026-07-01T00:00:00.000Z'));
    const e2 = batchEntry(6, '2026-07-01T00:05:00.000Z');
    applyBatchEntryTimestamps(st, e2);
    assert.equal(st.currentSessionId, '2026-07-01T00:00:00.000Z');
    assert.equal(e2.body.messages[0]._timestamp, '2026-07-01T00:00:00.000Z');
    assert.equal(e2.body.messages[5]._timestamp, '2026-07-01T00:05:00.000Z');
  });

  it('new-terminal bigDrop (count > 4) resets: new session id = entry ts', () => {
    const st = freshSt();
    applyBatchEntryTimestamps(st, batchEntry(30, '2026-07-01T00:00:00.000Z'));
    const e2 = batchEntry(6, '2026-07-01T01:00:00.000Z', { firstText: 'new terminal prompt' });
    applyBatchEntryTimestamps(st, e2);
    assert.equal(st.currentSessionId, '2026-07-01T01:00:00.000Z');
    assert.equal(st.timestamps.length, 6);
    assert.equal(e2.body.messages[0]._timestamp, '2026-07-01T01:00:00.000Z');
  });

  it('transient short entry (<=4 msgs after long) does NOT reset', () => {
    const st = freshSt();
    applyBatchEntryTimestamps(st, batchEntry(30, '2026-07-01T00:00:00.000Z'));
    applyBatchEntryTimestamps(st, batchEntry(2, '2026-07-01T01:00:00.000Z', { firstText: 'quick q' }));
    assert.equal(st.currentSessionId, '2026-07-01T00:00:00.000Z');
    assert.equal(st.timestamps.length, 30);
  });

  it('slimmed compact continuation (_compactContinuation:true) does NOT reset and truncates accumulators', () => {
    // The P0 scenario: slim pass emptied the compact entry's messages before the
    // batch boundary check; the stamped flag must (a) prevent a session split and
    // (b) truncate positional ts so post-compact growth gets fresh timestamps.
    const st = freshSt();
    applyBatchEntryTimestamps(st, batchEntry(30, '2026-07-01T00:00:00.000Z'));
    const compact = batchEntry(10, '2026-07-01T02:00:00.000Z', { slimmed: true, compactFlag: true });
    applyBatchEntryTimestamps(st, compact);
    assert.equal(st.currentSessionId, '2026-07-01T00:00:00.000Z', 'compact must not split the session');
    assert.equal(st.timestamps.length, 10, 'accumulators truncated to compact length');
    const e3 = batchEntry(12, '2026-07-01T03:00:00.000Z');
    applyBatchEntryTimestamps(st, e3);
    assert.equal(e3.body.messages[0]._timestamp, '2026-07-01T00:00:00.000Z', 'stable id preserved');
    assert.equal(e3.body.messages[11]._timestamp, '2026-07-01T03:00:00.000Z', 'post-compact growth gets fresh ts');
  });

  it('user_id change with an established session resets (new session)', () => {
    const st = freshSt();
    applyBatchEntryTimestamps(st, batchEntry(20, '2026-07-01T00:00:00.000Z', { userId: 'u1' }));
    const e2 = batchEntry(25, '2026-07-01T01:00:00.000Z', { userId: 'u2' });
    applyBatchEntryTimestamps(st, e2);
    assert.equal(st.currentSessionId, '2026-07-01T01:00:00.000Z');
    assert.equal(e2.body.messages[0]._timestamp, '2026-07-01T01:00:00.000Z');
  });
});
