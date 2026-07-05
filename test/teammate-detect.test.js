/**
 * Unit tests for server/lib/teammate-detect.js — the server-side teammate
 * filter used by /api/prev-segment-teammates. Includes parity cases against
 * the client's src/utils/teammateDetector.js native rule (pattern follows
 * test/interceptor-core-mainagent.test.js: same fixtures through both
 * implementations must agree).
 */
import './_shims/register.mjs';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { isTeammateLikeEntry } from '../server/lib/teammate-detect.js';

let isNativeTeammate;
before(async () => {
  ({ isNativeTeammate } = await import('../src/utils/teammateDetector.js'));
});

const SDK_SYSTEM = 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.';
const MAIN_SYSTEM = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
const TEAM_SYSTEM = MAIN_SYSTEM + ' You are running as an agent in a team.';

const mk = ({ system = '', tools = [], teammate } = {}) => {
  const entry = { body: { system, tools, messages: [] } };
  if (teammate !== undefined) entry.teammate = teammate;
  return entry;
};

describe('isTeammateLikeEntry', () => {
  it('accepts external-process teammates via the persisted teammate field', () => {
    assert.equal(isTeammateLikeEntry(mk({ system: MAIN_SYSTEM, teammate: 'alice' })), true);
  });

  it('accepts proxy-mode teammates via the team system marker', () => {
    assert.equal(isTeammateLikeEntry(mk({ system: TEAM_SYSTEM })), true);
    assert.equal(isTeammateLikeEntry(mk({ system: 'foo Agent Teammate Communication bar' })), true);
  });

  it('accepts native teammates: SDK prompt + SendMessage tool', () => {
    assert.equal(isTeammateLikeEntry(mk({ system: SDK_SYSTEM, tools: [{ name: 'SendMessage' }] })), true);
  });

  it('rejects plain SDK subagents (no SendMessage tool)', () => {
    assert.equal(isTeammateLikeEntry(mk({ system: SDK_SYSTEM, tools: [{ name: 'Bash' }] })), false);
  });

  it('rejects MainAgent and malformed entries', () => {
    assert.equal(isTeammateLikeEntry(mk({ system: MAIN_SYSTEM, tools: [{ name: 'SendMessage' }] })), false);
    assert.equal(isTeammateLikeEntry(null), false);
    assert.equal(isTeammateLikeEntry({}), false);
  });

  it('handles array-form system blocks', () => {
    const entry = { body: { system: [{ text: SDK_SYSTEM }], tools: [{ name: 'SendMessage' }], messages: [] } };
    assert.equal(isTeammateLikeEntry(entry), true);
  });

  it('PARITY: agrees with the client native-teammate rule on shared fixtures', () => {
    const fixtures = [
      mk({ system: SDK_SYSTEM, tools: [{ name: 'SendMessage' }] }),
      mk({ system: SDK_SYSTEM, tools: [{ name: 'Bash' }] }),
      mk({ system: SDK_SYSTEM, tools: [] }),
      mk({ system: MAIN_SYSTEM, tools: [{ name: 'SendMessage' }] }),
      { body: { system: [{ text: SDK_SYSTEM }], tools: [{ name: 'SendMessage' }], messages: [] } },
    ];
    for (const f of fixtures) {
      // For entries without the external tag or proxy marker, the server rule
      // must reduce exactly to the client's native-teammate rule.
      assert.equal(isTeammateLikeEntry(f), isNativeTeammate(f), JSON.stringify(f.body.system).slice(0, 60));
    }
  });
});
