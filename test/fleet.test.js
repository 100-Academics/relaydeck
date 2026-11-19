import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/server.js';

const admin = { role: 'admin', id: 'human', name: 'Human' };

test('device renames and host-only room membership edits', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-fleet-'));
  const host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  t.after(async () => { await host.close(); await rm(dir, { recursive: true, force: true }); });

  const d1 = host.store.device('Build machine');
  const d2 = host.store.device('Studio');
  const d1Actor = { role: 'device', id: d1.id, name: d1.name };
  const d2Actor = { role: 'device', id: d2.id, name: d2.name };
  host.store.data.devices.find(d => d.id === d1.id).online = true;
  host.store.data.devices.find(d => d.id === d2.id).online = true;
  const a1 = host.store.agent(d1Actor, { name: 'Parser', deviceId: d1.id, harness: 'test', command: 'node', args: [], cwd: dir });
  const a2 = host.store.agent(d2Actor, { name: 'Docs', deviceId: d2.id, harness: 'test', command: 'node', args: [], cwd: dir });

  // Renaming keeps the key working; only the host or the device itself may rename.
  const renamed = host.store.renameDevice(admin, d1.id, 'Build box');
  assert.equal(renamed.name, 'Build box');
  assert.equal(host.store.auth(d1.token).id, d1.id, 'The device key must keep working after a rename');
  assert.throws(() => host.store.renameDevice(d2Actor, d1.id, 'Hijack'), /own device/);
  assert.equal(host.store.renameDevice(d1Actor, d1.id, 'Build box v2').name, 'Build box v2');

  // Room membership: host edits; agents are bound by membership at send time.
  const group = { id: 'interface', name: 'Interface', members: [a1.agent.id] };
  host.store.data.groups.push(group); host.store.save();
  host.store.send({ role: 'agent', id: a1.agent.id, name: a1.agent.name }, { groupId: 'interface', type: 'notice', body: 'Spec updated.' });
  assert.throws(() => host.store.send({ role: 'agent', id: a2.agent.id, name: a2.agent.name }, { groupId: 'interface', type: 'notice', body: 'Not a member.' }), /not a member/);
  host.store.updateGroup(admin, 'interface', { remove: [a1.agent.id], add: [a2.agent.id] });
  const g = host.store.data.groups.find(g => g.id === 'interface');
  assert.deepEqual(g.members, [a2.agent.id]);
  assert.throws(() => host.store.send({ role: 'agent', id: a1.agent.id, name: a1.agent.name }, { groupId: 'interface', type: 'notice', body: 'Late notice.' }), /not a member/);

  // The Team room is open to everyone and its membership is not editable.
  assert.throws(() => host.store.updateGroup(admin, 'team', { add: [a1.agent.id] }), /every agent/);
  assert.equal(host.store.updateGroup(admin, 'team', { name: 'Whole team' }).name, 'Whole team');

  // Agents cannot edit rooms, through the store or the room_update bridge tool.
  assert.throws(() => host.store.updateGroup({ role: 'agent', id: a1.agent.id, name: 'Parser' }, 'interface', { name: 'X' }), /Only the host/);
  assert.throws(() => host.store.tool({ role: 'agent', id: a1.agent.id, name: 'Parser' }, 'room_update', { groupId: 'interface', name: 'X' }), /Only the host/);
  const viaBridge = host.store.tool(admin, 'room_update', { groupId: 'interface', name: 'Interface v2' });
  assert.equal(viaBridge.result.name, 'Interface v2');
});
