import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR } from '../findcc.js';
import { imDir } from '../server/lib/im-lock.js';
import { readSenders, upsertSender, MAX_SENDERS } from '../server/lib/im-senders.js';

let n = 0;
function freshId() { return `test_senders_${process.pid}_${n++}`; }
function wipe(id) { try { rmSync(imDir(id), { recursive: true, force: true }); } catch { /* noop */ } }

describe('im-senders', () => {
  beforeEach(() => { mkdirSync(LOG_DIR, { recursive: true }); });

  it('readSenders returns {} when file is absent', () => {
    const id = freshId(); wipe(id);
    assert.deepEqual(readSenders(id), {});
  });

  it('upsert writes a sender and readSenders returns it', () => {
    const id = freshId(); wipe(id);
    assert.equal(upsertSender(id, 'u1', { name: 'Alice', avatar: 'https://a/1.png' }), true);
    const map = readSenders(id);
    assert.equal(map.u1.name, 'Alice');
    assert.equal(map.u1.avatar, 'https://a/1.png');
    assert.ok(typeof map.u1.ts === 'number');
    wipe(id);
  });

  it('merges multiple senders and accepts name-only (no avatar)', () => {
    const id = freshId(); wipe(id);
    upsertSender(id, 'u1', { name: 'Alice', avatar: 'https://a/1.png' });
    upsertSender(id, 'u2', { name: 'Bob' });
    const map = readSenders(id);
    assert.equal(Object.keys(map).length, 2);
    assert.equal(map.u2.name, 'Bob');
    assert.equal(map.u2.avatar, null);
    wipe(id);
  });

  it('skips the write when nothing changed (returns false)', () => {
    const id = freshId(); wipe(id);
    assert.equal(upsertSender(id, 'u1', { name: 'Alice', avatar: 'x' }), true);
    assert.equal(upsertSender(id, 'u1', { name: 'Alice', avatar: 'x' }), false);
    wipe(id);
  });

  it('updates an existing sender when name/avatar change', () => {
    const id = freshId(); wipe(id);
    upsertSender(id, 'u1', { name: 'Alice' });
    assert.equal(upsertSender(id, 'u1', { name: 'Alice Q', avatar: 'https://a/2.png' }), true);
    assert.equal(readSenders(id).u1.name, 'Alice Q');
    wipe(id);
  });

  it('ignores empty/invalid senderId', () => {
    const id = freshId(); wipe(id);
    assert.equal(upsertSender(id, '', { name: 'x' }), false);
    assert.equal(upsertSender(id, null, { name: 'x' }), false);
    assert.deepEqual(readSenders(id), {});
    wipe(id);
  });

  it('tolerates corrupt JSON → {} (and can overwrite)', () => {
    const id = freshId(); wipe(id);
    mkdirSync(imDir(id), { recursive: true });
    writeFileSync(join(imDir(id), 'im-senders.json'), '{ this is not json');
    assert.deepEqual(readSenders(id), {});
    assert.equal(upsertSender(id, 'u1', { name: 'Alice' }), true);
    assert.equal(readSenders(id).u1.name, 'Alice');
    wipe(id);
  });

  it('caps the map at MAX_SENDERS, dropping the oldest', () => {
    const id = freshId(); wipe(id);
    for (let i = 0; i < MAX_SENDERS + 10; i++) upsertSender(id, `u${i}`, { name: `n${i}` });
    const map = readSenders(id);
    assert.equal(Object.keys(map).length, MAX_SENDERS);
    // earliest ids should have been evicted
    assert.equal('u0' in map, false);
    assert.equal(`u${MAX_SENDERS + 9}` in map, true);
    wipe(id);
  });
});
