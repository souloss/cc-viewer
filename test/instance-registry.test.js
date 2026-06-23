import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { recordInstance, listInstances } from '../server/lib/instance-registry.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'ccv-instances-')); }

describe('instance-registry', () => {
  it('records and lists ids oldest → newest', async () => {
    const d = tmp();
    assert.deepEqual(listInstances(d), []);
    await recordInstance(d, 'alpha');
    await recordInstance(d, 'beta');
    assert.deepEqual(listInstances(d), ['alpha', 'beta']);
    rmSync(d, { recursive: true, force: true });
  });

  it('dedupes by moving an existing id to the end (most-recent-last)', async () => {
    const d = tmp();
    await recordInstance(d, 'alpha');
    await recordInstance(d, 'beta');
    await recordInstance(d, 'alpha'); // re-used → moves to end
    assert.deepEqual(listInstances(d), ['beta', 'alpha']);
    rmSync(d, { recursive: true, force: true });
  });

  it('caps the list at 50, dropping the oldest', async () => {
    const d = tmp();
    for (let i = 0; i < 55; i++) await recordInstance(d, `id${i}`);
    const list = listInstances(d);
    assert.equal(list.length, 50);
    assert.equal(list[0], 'id5');   // id0..id4 dropped
    assert.equal(list[49], 'id54'); // newest kept
    rmSync(d, { recursive: true, force: true });
  });

  it('sanitizes ids into safe filename tokens (no path traversal)', async () => {
    const d = tmp();
    await recordInstance(d, '../evil');
    assert.deepEqual(listInstances(d), ['.._evil']);
    // only .instances.json (+ its lock may be gone) live directly in the dir — no escape
    assert.ok(existsSync(join(d, '.instances.json')));
    assert.ok(!readdirSync(d).some((f) => f.includes('evil') && f !== '.instances.json'));
    rmSync(d, { recursive: true, force: true });
  });

  it('empty id / no project (logDir="") are no-ops', async () => {
    const d = tmp();
    await recordInstance(d, '');     // empty → ignored
    await recordInstance(d, null);   // falsy → ignored
    assert.deepEqual(listInstances(d), []);
    assert.equal(existsSync(join(d, '.instances.json')), false);
    // no project dir
    await recordInstance('', 'x');
    assert.deepEqual(listInstances(''), []);
    rmSync(d, { recursive: true, force: true });
  });

  it('persists valid JSON and survives concurrent records (lock serializes)', async () => {
    const d = tmp();
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => recordInstance(d, id)));
    const list = JSON.parse(readFileSync(join(d, '.instances.json'), 'utf-8'));
    assert.equal(new Set(list).size, 5, 'no lost update under concurrency');
    assert.deepEqual([...list].sort(), ['a', 'b', 'c', 'd', 'e']);
    rmSync(d, { recursive: true, force: true });
  });
});
