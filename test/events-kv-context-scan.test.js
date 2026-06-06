/**
 * GET /events 的 kv-cache / context_window 扫描语义回归（onScan 记忆化 + 单次 parse）。
 *
 * 修复背景：旧 onScan 对全文件每条含 "mainAgent":true 的 raw 做完整 JSON.parse，
 * `-c` 大会话日志含多个巨型 checkpoint 时每次 SSE 连接阻塞 event loop 数秒。
 * 新逻辑只记忆最后一条真实 mainAgent raw（子串过滤 teammate），Pass 1 结束后单次 parse。
 * 本测试锁定语义不变量：发出的 context_window 帧反映"最后一条真实 mainAgent"，
 * 末尾的 teammate 伪 mainAgent 条目不得顶掉它。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// 环境隔离必须先于任何 findcc/interceptor 加载（同 api-proxy-profiles.test.js 模式）
const tmpDir = mkdtempSync(join(tmpdir(), 'ccv-events-scan-'));
process.env.CCV_LOG_DIR = tmpDir;
process.env.CLAUDE_CONFIG_DIR = tmpDir;
process.env.CCV_WORKSPACE_MODE = '1';
process.env.CCV_CLI_MODE = '0';
// 私有高位端口窗,避免与用户真实 ccv 服务(7008-7099)抢端口(2026-06-06 审计 port-clash)。
// server.js 顶层把 CCV_START_PORT/MAX_PORT 冻结为 const,故必须在 import server.js 之前设好(本文件 before() 内动态 import,此处即生效)。
process.env.CCV_START_PORT = '17930';
process.env.CCV_MAX_PORT = '17939';

function mainAgentEntry(ts, inputTokens, extra = {}) {
  return {
    timestamp: ts,
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    status: 200,
    mainAgent: true,
    body: {
      model: 'claude-opus-4-8',
      system: [{ type: 'text', text: 'You are Claude Code' }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    response: { body: { usage: { input_tokens: inputTokens, output_tokens: 10 } } },
    ...extra,
  };
}

/** 读 SSE 流并解析帧，收到 untilEvents 任一事件或超时即断开返回 */
function collectSSE(port, path, untilEvents, timeoutMs) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const req = request({
      hostname: '127.0.0.1', port, path,
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); resolve(frames); }, timeoutMs);
      res.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = { event: 'message', data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data += line.slice(6);
            else if (line.startsWith('data:')) ev.data += line.slice(5);
          }
          frames.push(ev);
          if (untilEvents.includes(ev.event)) {
            clearTimeout(timer);
            req.destroy();
            resolve(frames);
            return;
          }
        }
      });
      res.on('error', () => { clearTimeout(timer); resolve(frames); });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /events kv/context scan semantics', { concurrency: false }, () => {
  let port, stopViewer;

  before(async () => {
    // workspace 模式下 LOG_FILE 初始为 ''：先 initForWorkspace 生成路径，预写日志，再启动 server
    const interceptor = await import('../server/interceptor.js');
    interceptor.initForWorkspace(join(tmpDir, 'scanproj'), { forceNew: true });
    const logFile = interceptor.LOG_FILE;
    assert.ok(logFile, 'initForWorkspace 后 LOG_FILE 应已生成');
    mkdirSync(dirname(logFile), { recursive: true });
    const entries = [
      mainAgentEntry('2026-06-06T01:00:00.000Z', 111),
      mainAgentEntry('2026-06-06T01:01:00.000Z', 222),   // ← 最后一条真实 mainAgent
      // 末条伪 mainAgent（teammate 子进程也可能带 mainAgent:true）：必须不顶掉上面那条
      mainAgentEntry('2026-06-06T01:02:00.000Z', 999, { teammate: 'bob' }),
    ];
    writeFileSync(logFile, entries.map(e => JSON.stringify(e)).join('\n---\n') + '\n---\n');

    const mod = await import('../server/server.js');
    const srv = await mod.startViewer();
    assert.ok(srv, 'server should start');
    stopViewer = mod.stopViewer;
    port = mod.getPort();
    assert.ok(port > 0);
  });

  after(async () => {
    await new Promise((resolve) => {
      stopViewer();
      setTimeout(() => { rmSync(tmpDir, { recursive: true, force: true }); resolve(); }, 200);
    });
  });

  it('context_window 帧反映最后一条真实 mainAgent；teammate 伪条目被过滤', async () => {
    const frames = await collectSSE(port, '/events', ['context_window'], 10000);
    const cw = frames.find(f => f.event === 'context_window');
    assert.ok(cw, `必须收到 context_window 帧（实收事件：${frames.map(f => f.event).join(',')}）`);
    const data = JSON.parse(cw.data);
    assert.equal(data.total_input_tokens, 222,
      'context_window 应来自 input_tokens=222 的最后一条真实 mainAgent（999 是 teammate 伪条目）');
  });

  it('load_chunk 仍逐条透传全部 3 条原始条目（记忆化不影响数据流）', async () => {
    const frames = await collectSSE(port, '/events', ['load_end'], 10000);
    const chunks = frames.filter(f => f.event === 'load_chunk');
    assert.equal(chunks.length, 3, '3 条条目各占一个 load_chunk 帧');
    const tokens = chunks.map(c => JSON.parse(c.data)[0].response.body.usage.input_tokens);
    assert.deepEqual(tokens, [111, 222, 999]);
  });
});
