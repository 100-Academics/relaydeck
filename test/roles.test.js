import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { agentInstructions } from '../src/onboarding.js';

const admin = { role: 'admin', id: 'human', name: 'You' };
const actor = a => ({ role: 'agent', id: a.id, name: a.name });
let dir, store;
test.before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-roles-'));
  store = new Store(dir);
  const mk = (name, role) => { const input = { name, harness: 'Shell', command: 'sh', args: [], cwd: dir, role }; const a = { id: store.data.agents.length === 0 ? 'agent-a' : `agent-${name.toLowerCase()}`, ...store.startup(input) }; store.data.agents.push(a); return a; };
  store.data.agents = [mk('Worker', 'worker'), mk('Arbiter', 'arbiter'), mk('Spy', 'secret')];
});
test.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });

test('role validation rejects unknown roles', () => {
  assert.throws(() => store.startup({ name: 'X', harness: 'Shell', command: 'sh', args: [], cwd: dir, role: 'queen' }), /Choose a valid role/);
});

test('secret agents are hidden from other agents but visible to the host', () => {
  const [worker, , spy] = store.data.agents;
  const asWorker = store.tool(actor(worker), 'agents', {}).result;
  assert.deepEqual(asWorker.map(a => a.name).sort(), ['Arbiter', 'Worker'], 'the worker sees its teammates but not the secret agent');
  const asSpy = store.tool(actor(spy), 'agents', {}).result;
  assert.deepEqual(asSpy.map(a => a.name).sort(), ['Arbiter', 'Spy', 'Worker'], 'the spy sees itself plus both teammates');
  const asAdmin = store.tool(admin, 'agents', {}).result;
  assert.equal(asAdmin.length, 3, 'host sees everyone');
});

test('secret agent messages arrive as the host, and replies route back to the spy', () => {
  const [worker, , spy] = store.data.agents;
  const sent = store.tool(actor(spy), 'message', { to: worker.id, body: 'yo, you have mail' }).result;
  assert.equal(sent.fromName, 'Human (host)');
  assert.equal(sent.secret, true);
  assert.equal(sent.from, spy.id, 'routing identity is preserved');
  const inbox = store.tool(actor(worker), 'inbox', {}).result;
  assert.equal(inbox[0].fromName, 'Human (host)', 'worker sees it as the host');
  assert.equal(inbox[0].secret, undefined, 'the secret flag is stripped for agents');
  const reply = store.tool(actor(worker), 'notice', { to: 'human', replyTo: sent.id, body: 'copy that' }).result;
  assert.ok(reply.recipients.includes(spy.id), 'a reply to the host is routed back to the secret agent');
  const spyInbox = store.tool(actor(spy), 'inbox', {}).result;
  assert.ok(spyInbox.some(m => m.body === 'copy that'), 'the reply lands in the spy inbox');
  assert.ok(sent.answeredAt, 'the spy message is marked answered by the reply');
});

test('arbiter can assign tasks; workers cannot', () => {
  const [worker, arbiter] = store.data.agents;
  const assigned = store.tool(actor(arbiter), 'assign', { to: worker.id, task: 'Review the parser' }).result;
  assert.equal(assigned.task, 'Review the parser');
  assert.equal(store.data.agents[0].task, 'Review the parser');
  assert.throws(() => store.tool(actor(worker), 'assign', { to: arbiter.id, task: 'Do my job' }), /Only the arbiter/);
});

test('situation summary hides the secret agent from agent viewers', () => {
  const [worker] = store.data.agents;
  const asWorker = store.tool(actor(worker), 'situation', {}).result;
  assert.ok(asWorker.agents.every(a => a.name !== 'Spy'));
  const asAdmin = store.tool(admin, 'situation', {}).result;
  assert.ok(asAdmin.agents.some(a => a.name === 'Spy'));
  assert.ok(asAdmin.recentActivity.length >= 0);
});

test('session instructions carry the role', async () => {
  const [worker, , spy] = store.data.agents;
  const workerDoc = await agentInstructions({ ...worker, startupInstructions: '' });
  const spyDoc = await agentInstructions({ ...spy, startupInstructions: '' });
  assert.match(workerDoc, /You are a \*\*worker\*\*/);
  assert.match(spyDoc, /secret agent/);
  assert.match(spyDoc, /messages appear to come from the host/);
});
