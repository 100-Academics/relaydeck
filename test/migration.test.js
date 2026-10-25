import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { migrateWorkspace } from '../src/migration.js';

test('rename preserves WAL-backed state and device keys without overwriting a new workspace', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = path.join(root, 'old'), current = path.join(root, 'new');
  await mkdir(old);
  const db = new DatabaseSync(path.join(old, 'amoeba.sqlite'));
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE workspace (id INTEGER PRIMARY KEY, data TEXT); INSERT INTO workspace VALUES (1, 'saved history')");
    await writeFile(path.join(old, 'local-device.key'), 'existing-device-key');
    assert.equal(await migrateWorkspace(current, old), true);
    const copy = new DatabaseSync(path.join(current, 'relaydeck.sqlite'));
    try { assert.equal(copy.prepare('SELECT data FROM workspace').get().data, 'saved history'); }
    finally { copy.close(); }
    assert.equal(await readFile(path.join(current, 'local-device.key'), 'utf8'), 'existing-device-key');
    db.exec("UPDATE workspace SET data='later legacy change'");
    assert.equal(await migrateWorkspace(current, old), false);
  } finally { db.close(); }
});
