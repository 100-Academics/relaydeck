import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, hash, secret } from '../src/store.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relaydeck-store-'));
  const store = new Store(dir); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const d = store.device('Laptop'); store.data.devices[0].online = true;
  const host = { role: 'admin', id: 'human', name: 'Human' };
  const create = name => { const { agent, token } = store.agent(host, { deviceId: d.id, name, harness: 'test', command: 'node', args: [], cwd: '.' }); return { actor: store.auth(token), agent, token }; };
  const a = create('Alpha'), b = create('Beta'); return { store, dir, host, d, a, b };
}
test('reading does not answer a message; a return notice does', t => {
  const { store, a, b } = fixture(t);
  const m = store.tool(a.actor, 'message', { to: b.agent.id, body: 'Review this?' }).result;
  assert.equal(store.tool(b.actor, 'inbox').result.length, 1); assert.equal(m.answeredAt, null);
  store.tool(b.actor, 'notice', { to: a.agent.id, body: 'Reviewed.' }); assert.ok(m.answeredAt);
});
test('unread messages append to tool responses once', t => {
  const { store, a, b } = fixture(t);
  store.tool(a.actor, 'notice', { to: b.agent.id, body: 'FYI' });
  assert.equal(store.tool(b.actor, 'task', { task: 'Working' }).inbox.length, 1);
  assert.equal(store.tool(b.actor, 'agents').inbox.length, 0);
});
test('group broadcasts target members and reject reply-request messages', t => {
  const { store, a, b } = fixture(t);
  const m = store.tool(a.actor, 'group_notice', { body: 'Team update' }).result;
  assert.deepEqual(m.recipients, [b.agent.id]); assert.equal(m.type, 'notice');
  assert.throws(() => store.send(a.actor, { groupId: 'team', type: 'message', body: '?' }), /only accept notices/);
});
test('disabled tools cannot be called; disabled inbox is not bypassed', t => {
  const { store, a, b } = fixture(t);
  store.tool(a.actor, 'message', { to: b.agent.id, body: 'Hello' });
  store.data.settings.inbox = false; assert.equal(store.tool(b.actor, 'agents').inbox.length, 0);
  store.data.settings.message = false; assert.throws(() => store.tool(a.actor, 'message', { to: b.agent.id, body: 'No' }), /disabled/);
});
test('client cannot launch or change tasks on other devices', t => {
  const { store, a } = fixture(t); const other = store.device('Other'), actor = store.auth(other.token);
  assert.throws(() => store.agent(actor, { ...a.agent, name: 'Hijack' }), /own device/);
  assert.throws(() => store.tool(actor, 'task', { agentId: a.agent.id, task: 'Hijack' }), /Not allowed/);
});
test('council fans out requests and associates recommendations', t => {
  const { store, a, b, host } = fixture(t);
  const c = store.tool(host, 'council', { question: 'What architecture?' }).result;
  assert.equal(c.participants.length, 2);
  store.tool(a.actor, 'notice', { to: 'human', body: 'Use a device runner.' });
  const reply = store.data.messages.at(-1); assert.equal(reply.councilId, c.id);
  const toBeta = store.data.messages.find(m => m.to === b.agent.id); assert.equal(toBeta.answeredAt, null);
});
test('persisted state survives restart without persisting online status', t => {
  const { store, dir, a, b } = fixture(t);
  store.tool(a.actor, 'message', { to: b.agent.id, body: 'Durable message' });
  const reopened = new Store(dir); try { assert.equal(reopened.data.messages.length, 1); assert.equal(reopened.data.devices[0].online, false); assert.equal(reopened.data.agents[0].status, 'disconnected'); } finally { reopened.close(); }
});
test('snapshots omit keys and malformed keys do not authenticate', t => {
  const { store, host } = fixture(t); const snapshot = JSON.stringify(store.snapshot(host));
  assert.ok(!snapshot.includes('tokenHash')); assert.ok(!snapshot.includes(store.data.adminToken)); assert.equal(store.auth({}), null);
  assert.equal(store.auth('あ'.repeat(64)), null);
});
