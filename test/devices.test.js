import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('removing a device removes its agents and related coordination data', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-device-'));
  const store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const host = { role: 'admin', id: 'human', name: 'Host' };
  const device = store.device('Laptop');
  store.data.devices[0].online = true;
  const launched = store.agent(host, { deviceId: device.id, name: 'Agent', harness: 'test', command: 'node', args: [], cwd: '.' });
  const agent = store.auth(launched.token);
  const other = store.device('Other');
  store.tool(host, 'group_notice', { body: 'Keep this room' });
  store.tool(agent, 'message', { to: 'human', body: 'Remove me' });
  store.removeDevice(device.id);
  assert.equal(store.data.devices.some(d => d.id === device.id), false);
  assert.equal(store.data.agents.some(a => a.deviceId === device.id), false);
  assert.equal(store.data.messages.some(m => m.from === agent.id), false);
  assert.equal(store.data.devices.some(d => d.id === other.id), true);
});
