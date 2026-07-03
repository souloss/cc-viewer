// ████ 文件内显式隔离(第六层闸) — ESM 静态 import 会被提升(hoist) ████
// LOG_DIR 在 ../findcc.js 加载时即固化:projectDir=join(LOG_DIR,...) 会被 mkdirSync/rmSync。
// 若先静态 import findcc 再赋 env,LOG_DIR 落到真实 ~/.claude/cc-viewer,误伤用户数据
// (2026-06-06 事故同源)。必须:node: 内置静态 import → 隔离段锁 env → 动态 import 项目模块。
// 私有端口窗 19750-19759 避免与默认窗 / 其它 server-* 测试跨进程抢端口。禁止改回静态 import。
import { describe, it, before, after } from 'node:test';
import { describeCli } from './_helpers/cli-tier.mjs';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── 隔离段:务必早于任何项目模块 import ──
const __isoDir = mkdtempSync(join(tmpdir(), 'ccv-srvlogs-'));
process.env.CCV_LOG_DIR = __isoDir;
process.env.CLAUDE_CONFIG_DIR = __isoDir;
// 清掉可能从 `ccv --pid <id>` 父会话继承来的实例 id，确保 server 以默认实例(null)启动，
// 否则 /api/local-logs 会按继承的 pid 过滤掉本测试的无标签夹具（与运行环境耦合）。
delete process.env.CCV_INSTANCE_ID;
process.env.CCV_START_PORT = '19750';
process.env.CCV_MAX_PORT = '19759';
process.env.CCV_WORKSPACE_MODE = '1';
process.env.CCV_CLI_MODE = '0';

// 隔离段之后才动态 import(此时 LOG_DIR 已固化到 __isoDir)
const { LOG_DIR } = await import('../findcc.js');

function httpRequest(port, path, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          json() { return JSON.parse(data); },
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

describeCli('server local logs endpoints', { concurrency: false }, () => {
  let startViewer, stopViewer, getPort;
  let port;
  const projectName = `projX_${Date.now()}`;
  const fileName = `${projectName}_20260101_120000.jsonl`;
  const fileRel = `${projectName}/${fileName}`;
  const projectDir = join(LOG_DIR, projectName);

  before(async () => {
    mkdirSync(projectDir, { recursive: true });
    // 写入多条条目用于分页测试
    const entries = [];
    for (let i = 0; i < 10; i++) {
      const ts = `2026-01-01T12:${String(i).padStart(2, '0')}:00Z`;
      entries.push(JSON.stringify({
        timestamp: ts,
        url: '/v1/messages',
        mainAgent: true,
        body: { model: 'claude-opus-4-6', messages: [{ role: 'user', content: `q${i}` }] },
        response: { status: 200, body: { content: [{ type: 'text', text: `a${i}` }] } },
      }));
    }
    writeFileSync(join(projectDir, fileName), entries.join('\n---\n') + '\n---\n');
    writeFileSync(join(projectDir, `${projectName}.json`), JSON.stringify({ files: { [fileName]: { summary: { sessionCount: 3 } } } }));

    const mod = await import('../server/server.js');
    startViewer = mod.startViewer;
    stopViewer = mod.stopViewer;
    getPort = mod.getPort;
    const srv = await startViewer();
    assert.ok(srv);
    port = getPort();
  });

  after(() => {
    stopViewer();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('GET /api/local-logs returns grouped logs with stats', async () => {
    const res = await httpRequest(port, '/api/local-logs');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(typeof data._currentProject, 'string');
    assert.ok(Array.isArray(data[projectName]));
    assert.equal(data[projectName].length, 1);
    assert.equal(data[projectName][0].file, fileRel);
    assert.equal(data[projectName][0].turns, 3);
    assert.equal(data[projectName][0].timestamp, '20260101_120000');
  });

  it('GET /api/local-logs filters by instance; ?all=1 reveals pid-tagged logs newest-first', async () => {
    // 同项目目录放一个更新的 pid 标签日志：默认实例(server 以 CCV_INSTANCE_ID= 空启动)不应看到它。
    const pidFile = `999__${projectName}_20260105_120000.jsonl`;
    writeFileSync(
      join(projectDir, pidFile),
      JSON.stringify({ timestamp: '2026-01-05T12:00:00Z', url: '/v1/messages', mainAgent: true, body: { model: 'm' } }) + '\n---\n',
    );
    try {
      // 默认：只列无标签日志，排除 999__ 文件（HTTP 层确认 deps.instanceId=null 的硬隔离）。
      const def = (await httpRequest(port, '/api/local-logs')).json();
      assert.equal(def[projectName].length, 1, 'default hides pid-tagged log');
      assert.equal(def[projectName][0].file, fileRel);
      assert.equal(def[projectName][0].instanceId, null);
      // ?all=1：确认 query 被解析并透传为 showAll=true → 两条都在，最新的 pid 日志排最前且带 instanceId。
      const all = (await httpRequest(port, '/api/local-logs?all=1')).json();
      assert.equal(all[projectName].length, 2, '?all=1 reveals all instances');
      assert.equal(all[projectName][0].file, `${projectName}/${pidFile}`, 'newest (pid) first');
      assert.equal(all[projectName][0].instanceId, '999');
      assert.equal(all[projectName][1].instanceId, null);
    } finally {
      rmSync(join(projectDir, pidFile), { force: true });
    }
  });

  it('GET /api/download-log rejects invalid file name', async () => {
    const res = await httpRequest(port, '/api/download-log?file=../../etc/passwd');
    assert.equal(res.status, 400);
    assert.ok(res.json().error.includes('Invalid file name'));
  });

  it('GET /api/download-log rejects invalid file type', async () => {
    const res = await httpRequest(port, '/api/download-log?file=projX/20260101.txt');
    assert.equal(res.status, 400);
    assert.ok(res.json().error.includes('Invalid file type'));
  });

  it('GET /api/download-log returns 404 when file not found', async () => {
    const res = await httpRequest(port, '/api/download-log?file=projX/not-exist.jsonl');
    assert.equal(res.status, 404);
  });

  it('GET /api/download-log returns file content for existing log', async () => {
    const res = await httpRequest(port, `/api/download-log?file=${encodeURIComponent(fileRel)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.ok(res.body.includes('2026-01-01T12:00:00Z'));
  });

  it('GET /api/local-log returns SSE event stream with entries', async () => {
    const res = await httpRequest(port, `/api/local-log?file=${encodeURIComponent(fileRel)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    // 验证 SSE 流包含 load_start, load_chunk, load_end 事件
    assert.ok(res.body.includes('event: load_start'), 'Should contain load_start event');
    assert.ok(res.body.includes('event: load_chunk'), 'Should contain load_chunk event');
    assert.ok(res.body.includes('event: load_end'), 'Should contain load_end event');
    assert.ok(res.body.includes('2026-01-01T12:00:00Z'), 'Should contain entry data');
  });

  // /api/entries/page 分页端点测试
  it('GET /api/entries/page returns valid JSON structure', async () => {
    // LOG_FILE 在测试环境可能为空，验证端点结构和参数处理
    const res = await httpRequest(port, `/api/entries/page?before=2099-01-01T00:00:00Z&limit=5`);
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(Array.isArray(data.entries), 'entries should be an array');
    assert.equal(typeof data.hasMore, 'boolean');
    assert.equal(typeof data.oldestTimestamp, 'string');
    assert.equal(typeof data.count, 'number');
    assert.equal(data.count, data.entries.length, 'count should match entries.length');
    // entries 如果有内容，应该是已解析的对象
    for (const entry of data.entries) {
      assert.equal(typeof entry, 'object', 'Each entry should be a parsed object');
    }
  });

  it('GET /api/entries/page returns 400 without before param', async () => {
    const res = await httpRequest(port, '/api/entries/page?limit=10');
    assert.equal(res.status, 400);
    const data = res.json();
    assert.ok(data.error.includes('before'), 'Error should mention "before" parameter');
  });

  it('GET /api/entries/page returns 400 with invalid before', async () => {
    const res = await httpRequest(port, '/api/entries/page?before=not-a-date&limit=10');
    assert.equal(res.status, 400);
  });

  it('GET /api/entries/page accepts request without limit (defaults to 100)', async () => {
    const res = await httpRequest(port, `/api/entries/page?before=2099-01-01T00:00:00Z`);
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(Array.isArray(data.entries));
    assert.equal(typeof data.hasMore, 'boolean');
  });

  it('GET /api/entries/page with early before returns empty', async () => {
    const res = await httpRequest(port, `/api/entries/page?before=1970-01-01T00:00:00Z&limit=10`);
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.entries.length, 0);
    assert.equal(data.hasMore, false);
    assert.equal(data.count, 0);
  });
});
