import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHost, launchHost } from '../src/server.js';

test('duplicate host reuses the GUI without changing stored device state', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-start-'));
  const first = await createHost({ directory, port: 0, local: false, quiet: true });
  t.after(async () => { await first.close(); await rm(directory, { recursive: true, force: true }); });
  first.store.device('Connected device'); first.store.data.devices[0].online = true; first.store.save();
  const opened = [], messages = [];
  const second = await launchHost({ directory, port: first.server.address().port, local: false, quiet: true, gui: true }, { open: url => opened.push(url), log: message => messages.push(message) });
  assert.equal(second, null); assert.deepEqual(opened, [first.address]); assert.match(messages[0], /already running/);
  const db = new DatabaseSync(path.join(directory, 'relaydeck.sqlite'), { readOnly: true });
  try { assert.equal(JSON.parse(db.prepare('SELECT data FROM workspace WHERE id=1').get().data).devices[0].online, true); } finally { db.close(); }
});

test('an unrelated port owner produces an actionable error and no new database', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-port-'));
  const other = createServer((req, res) => res.end('Another app'));
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => other.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(() => launchHost({ directory, port: other.address().port, local: false, quiet: true }), /another application.*--port 4318/);
  await assert.rejects(() => access(path.join(directory, 'relaydeck.sqlite')));
});

test('invalid ports are rejected before accessing storage', async () => {
  for (const port of [-1, 65536, NaN, 3.5]) await assert.rejects(() => createHost({ port }), /Port must be an integer/);
});
