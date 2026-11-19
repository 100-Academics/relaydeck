import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { agentInstructions } from '../src/onboarding.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relaydeck-inbox-'));
  const store = new Store(dir); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const d = store.device('Laptop'); store.data.devices[0].online = true;
  const host = { role: 'admin', id: 'human', name: 'Human' };
  const { agent, token } = store.agent(host, { deviceId: d.id, name: 'Alpha', harness: 'test', command: 'node', args: [], cwd: '.' });
  return { store, dir, host, d, actor: store.auth(token), agent };
}

test('questions request an answer and stay unanswered until the recipient replies', t => {
  const { store, host, actor, agent } = fixture(t);
  const q = store.tool(actor, 'question', { to: 'human', body: 'Should we keep the legacy API?' }).result;
  assert.equal(q.type, 'question');
  assert.equal(q.answeredAt, null);
  assert.equal(store.tool(host, 'inbox').result.length, 1);
  assert.equal(q.answeredAt, null);
  store.tool(host, 'message', { to: agent.id, body: 'Drop it.' });
  assert.ok(q.answeredAt);
});

test('questions are direct delivery only; groups accept notices only', t => {
  const { store, actor } = fixture(t);
  assert.throws(() => store.send(actor, { type: 'question', groupId: 'team', body: 'All of you?' }), /only accept notices/);
  assert.throws(() => store.tool(actor, 'question', { groupId: 'team', body: 'All of you?' }), /Recipient not found/);
});

test('pinned notes ride along in every tool response and session instructions', async t => {
  const { store, host, actor, agent } = fixture(t);
  assert.equal(store.tool(actor, 'agents').pinned.length, 0);
  store.tool(host, 'pin', { body: 'Never commit the .env key' });
  assert.equal(store.tool(host, 'pin', { body: 'Second standing order' }).result.length, 2);
  assert.equal(store.tool(actor, 'agents').pinned.length, 2);
  const instructions = await agentInstructions(agent, store.data.pinned);
  assert.ok(instructions.includes('Pinned team notes (always in effect)'));
  assert.ok(instructions.includes('Never commit the .env key'));
  assert.ok(instructions.includes('Second standing order'));
});

test('pinned notes are capped, removable, and surfaced in the GUI snapshot', t => {
  const { store, host, actor } = fixture(t);
  for (let i = 0; i < 55; i++) store.tool(host, 'pin', { body: `Note ${i}` });
  assert.equal(store.data.pinned.length, 50);
  const pinId = store.data.pinned[0].id;
  assert.equal(store.tool(host, 'unpin', { pinId }).result.length, 49);
  assert.throws(() => store.tool(host, 'unpin', { pinId }), /not found/);
  assert.throws(() => store.tool(host, 'unpin', {}), /pinId/);
  store.tool(host, 'pin', { body: 'Snapshot note' });
  assert.equal(store.snapshot(host).pinned.length, 50);
});

test('disabling pins hides them from tool responses without deleting them', t => {
  const { store, host, actor } = fixture(t);
  store.tool(host, 'pin', { body: 'Hidden note' });
  store.data.settings.pins = false;
  assert.equal(store.tool(actor, 'agents').pinned.length, 0);
  assert.equal(store.data.pinned.length, 1);
});
