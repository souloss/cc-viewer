import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSX = readFileSync(join(ROOT, 'src/components/settings/RetryConfigModal.jsx'), 'utf8');
const CSS = readFileSync(join(ROOT, 'src/components/settings/RetryConfigModal.module.css'), 'utf8');
const PANEL_JSX = readFileSync(join(ROOT, 'src/components/proxy-stats/ProxyStatsModal.jsx'), 'utf8');
const SHELL_CSS = readFileSync(join(ROOT, 'src/components/proxy-stats/ProxyStatsModal.module.css'), 'utf8');
const HEADER_JSX = readFileSync(join(ROOT, 'src/components/dashboard/AppHeader.jsx'), 'utf8');

describe('RetryConfigForm layout', () => {
  it('groups strategy controls separately from execution parameters', () => {
    assert.match(JSX, /className=\{styles\.configGrid\}/);
    assert.match(JSX, /className=\{styles\.configGroup\}/);
    assert.match(JSX, /className=\{styles\.groupTitle\}/);
    assert.match(JSX, /ui\.retryConfig\.groupStrategy/);
    assert.match(JSX, /ui\.retryConfig\.groupExecution/);

    const modeIndex = JSX.indexOf("renderResetBtn('mode')");
    const statusIndex = JSX.indexOf("renderResetBtn('retryStatusCodes')");
    const numericIndex = JSX.indexOf('NUMERIC_FIELDS.map');
    assert.ok(modeIndex >= 0 && statusIndex > modeIndex, 'strategy group should contain mode before status codes');
    assert.ok(numericIndex > statusIndex, 'execution parameters should render after strategy controls');
  });

  it('uses two columns on wide config panels and returns to one column on narrow panels', () => {
    assert.match(CSS, /\.configGrid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/s);
    assert.match(CSS, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*\.configGrid\s*\{[^}]*grid-template-columns:\s*1fr/s);
    assert.match(CSS, /\.configGroup\s*\{/);
  });

  it('lets the embedded config tab use the modal width without affecting the stats tab', () => {
    assert.match(SHELL_CSS, /\.configFormWrap\s*\{[^}]*max-width:\s*1120px/s);
    assert.match(SHELL_CSS, /\.configFormWrap\s*\{[^}]*margin:\s*0 auto/s);
  });

  it('keeps config and stats in one tabbed panel instead of nested modal surfaces', () => {
    assert.match(PANEL_JSX, /<Segmented/);
    assert.match(PANEL_JSX, /ui\.proxyStats\.tabConfig/);
    assert.match(PANEL_JSX, /ui\.proxyStats\.tabStats/);
    assert.doesNotMatch(PANEL_JSX, /BLUR_MASK_STYLE|<Modal|viewRetryConfig/);
    // RetryConfigModal.jsx must be form-only (no standalone Modal wrapper / blur mask):
    // the unified ProxyStatsModal owns the host Modal; this file exports just RetryConfigForm.
    assert.doesNotMatch(JSX, /BLUR_MASK_STYLE|<Modal/);
  });

  it('routes the hamburger entry to the unified config and stats panel on every viewport', () => {
    assert.match(HEADER_JSX, /label:\s*t\('ui\.proxyStats\.title'\)/);
    assert.match(HEADER_JSX, /onClick:\s*\(\)\s*=>\s*this\.props\.onToggleProxyStats\?\.\(\)/);
    assert.doesNotMatch(HEADER_JSX, /RetryConfigModal|retryConfigModalVisible/);
  });
});
