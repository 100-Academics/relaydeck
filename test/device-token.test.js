import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('regenerating a device token revokes the old token', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-token-'));
  const store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const original = store.device('Laptop');
  store.data.devices[0].online = true;
  const next = store.regenerateDeviceToken(original.id);
  assert.equal(store.auth(original.token), null);
  assert.equal(store.auth(next.token)?.id, original.id);
  assert.equal(store.data.devices[0].online, false);
});
