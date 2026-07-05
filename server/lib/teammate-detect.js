import { getSystemText, TEAMMATE_SYSTEM_RE } from './interceptor-core.js';

/**
 * Server-side teammate detection for the previous-segment backfill filter
 * (/api/prev-segment-teammates). Mirrors the client's three teammate shapes:
 *
 *  1. External-process teammate — interceptor persisted `entry.teammate`
 *     (--agent-name / --parent-session-id spawn).
 *  2. Proxy-mode teammate — system prompt carries the team-communication
 *     marker (TEAMMATE_SYSTEM_RE, shared with interceptor-core.js).
 *  3. Native (same-process Agent-tool) teammate — SDK agent system prompt
 *     ("You are a Claude agent", NOT "You are Claude Code") plus a
 *     SendMessage tool; plain subagents are never granted SendMessage.
 *
 * KEEP IN SYNC with src/utils/teammateDetector.js (native rule) and
 * src/utils/contentFilter.js (TEAMMATE_SYSTEM_RE). Drift is pinned by the
 * parity cases in test/teammate-detect.test.js (pattern follows
 * test/interceptor-core-mainagent.test.js).
 */

// Mirror of src/utils/teammateDetector.js NATIVE_TEAMMATE_RE.
const NATIVE_TEAMMATE_RE = /You are a Claude agent/i;

export function isTeammateLikeEntry(entry) {
  if (!entry || !entry.body) return false;
  if (entry.teammate) return true;
  const sysText = getSystemText(entry.body);
  if (TEAMMATE_SYSTEM_RE.test(sysText)) return true;
  if (!NATIVE_TEAMMATE_RE.test(sysText)) return false;
  const tools = entry.body.tools;
  return Array.isArray(tools) && tools.some((t) => t && t.name === 'SendMessage');
}
