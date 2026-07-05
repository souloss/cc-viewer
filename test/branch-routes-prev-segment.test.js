// Route tests for /api/prev-segment-teammates (server/routes/logs.js) — the
// post-rotation teammate backfill. Cold-start isolation pattern follows
// branch-routes-events.test.js: env / cwd / pre-seeded logs are set BEFORE
// importing the interceptor; resolveResumeChoice('continue') then points
// LOG_FILE at the pre-seeded current segment, which also exercises the boot
// re-seed path on the sentinel head.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

// ── Cold-start isolation: env / cwd / logs BEFORE interceptor import ──
const tmpRoot = mkdtempSync(join(tmpdir(), 'ccv-prevseg-route-'));
const logRoot = join(tmpRoot, 'logs');
const projectCwd = join(tmpRoot, 'prevsegproj');
mkdirSync(logRoot, { recursive: true });
mkdirSync(projectCwd, { recursive: true });
process.env.CCV_LOG_DIR = logRoot;
process.env.CLAUDE_CONFIG_DIR = logRoot;
process.env.CCV_PROXY_MODE = '1';
delete process.env.CCV_WORKSPACE_MODE;
delete process.env.CCV_CLI_MODE;
delete process.env.CCV_IM_PLATFORM; // IM mode spins a platform worker — must stay off in-process
const origCwd = process.cwd();
process.chdir(projectCwd);

const projectName = basename(projectCwd).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
const projectLogDir = join(logRoot, projectName);
mkdirSync(projectLogDir, { recursive: true });

const SEP = '\n---\n';
const SDK_SYSTEM = 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.';

const nativeTeammateEntry = (ts, name) => ({
  timestamp: ts,
  url: 'https://api.anthropic.com/v1/messages',
  body: {
    system: SDK_SYSTEM,
    tools: [{ name: 'SendMessage' }],
    messages: [{ role: 'user', content: `You are ${name}. Do the assigned work now.` }],
    model: 'claude-sonnet-5',
  },
  response: { status: 200, body: { content: [{ type: 'text', text: `${name} report` }] } },
});
const mainAgentNoise = (ts) => ({
  timestamp: ts,
  url: 'https://api.anthropic.com/v1/messages',
  mainAgent: true,
  body: { system: 'You are Claude Code', tools: [], messages: [], model: 'claude-fable-5' },
  response: { status: 200, body: { content: [{ type: 'text', text: 'main reply' }] } },
});
const inProgressTeammate = (ts) => ({
  ...nativeTeammateEntry(ts, 'ghost'),
  inProgress: true,
});

// Previous segment: 2 renderable teammates + main noise + an in-flight teammate.
const prevFile = join(projectLogDir, `${projectName}_20260701_100000.jsonl`);
writeFileSync(prevFile, [
  mainAgentNoise('2026-07-01T10:00:01Z'),
  nativeTeammateEntry('2026-07-01T10:00:02Z', 'alice'),
  inProgressTeammate('2026-07-01T10:00:03Z'),
  nativeTeammateEntry('2026-07-01T10:00:04Z', 'bob'),
].map((e) => JSON.stringify(e)).join(SEP) + SEP);

// Current segment: rotation sentinel head + one fresh entry. Being newest, it
// becomes LOG_FILE at boot (IM path), exercising the boot re-seed too.
const sentinel = {
  ccvRotationContext: 1,
  url: 'ccv://rotation-context',
  from: basename(prevFile),
  teammateNames: [['You are alice. Do the assigned work now.', 'alice']],
  timestamp: '2026-07-01T11:00:00.000Z',
};
const currentFile = join(projectLogDir, `${projectName}_20260701_110000.jsonl`);
writeFileSync(currentFile, [
  JSON.stringify(sentinel),
  JSON.stringify(mainAgentNoise('2026-07-01T11:00:01Z')),
].join(SEP) + SEP);

let prevSegmentHandler, _initPromise;

before(async () => {
  const interceptor = await import('../server/interceptor.js');
  _initPromise = interceptor._initPromise;
  await _initPromise;
  // Leave resume mode: LOG_FILE ← the pre-seeded current segment (newest file).
  interceptor.resolveResumeChoice('continue');
  const { logsRoutes } = await import('../server/routes/logs.js');
  prevSegmentHandler = logsRoutes.find((r) => r.path === '/api/prev-segment-teammates').handler;
  assert.ok(prevSegmentHandler, 'route must be registered');
});

after(() => {
  process.chdir(origCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function collectRes() {
  const chunks = [];
  return {
    res: {
      writeHead(code, headers) { this.code = code; this.headers = headers; },
      write(s) { chunks.push(s); return true; },
      end(s) { if (s) chunks.push(s); this.ended = true; },
    },
    lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

describe('/api/prev-segment-teammates', () => {
  it('streams context line + teammate-only entries + done line', async () => {
    const { res, lines } = collectRes();
    await prevSegmentHandler({}, res, new URL('http://x/api/prev-segment-teammates'), true, {});
    const out = lines();
    assert.ok(res.ended);
    assert.equal(res.headers['Content-Type'], 'application/x-ndjson');

    const ctx = out[0];
    assert.equal(ctx.rotationContext.from, basename(prevFile));
    // Sentinel carry-forward pairs are present (merged with the in-process
    // registry snapshot — boot re-seed loaded the same pair).
    assert.ok(ctx.teammateNames.some(([, name]) => name === 'alice'));

    const done = out[out.length - 1];
    assert.equal(done.done, true);
    assert.equal(done.prevSegment, basename(prevFile));
    assert.equal(done.truncated, false);

    const entries = out.slice(1, -1);
    const labels = entries.map((e) => e.body.messages[0].content);
    assert.equal(entries.length, 2, 'main noise and in-flight teammate are filtered');
    assert.ok(labels[0].includes('alice') && labels[1].includes('bob'));
    assert.ok(entries.every((e) => !e.mainAgent && !e.inProgress));
  });

  it('never accepts a client-supplied filename (param is ignored)', async () => {
    const { res, lines } = collectRes();
    const url = new URL('http://x/api/prev-segment-teammates?file=../../../etc/passwd');
    await prevSegmentHandler({}, res, url, true, {});
    const out = lines();
    // Same result as the un-parameterized call: server resolved its own file.
    assert.equal(out[out.length - 1].prevSegment, basename(prevFile));
  });
});
