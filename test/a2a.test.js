import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/server.js';

const admin = { role: 'admin', id: 'human', name: 'Human' };

test('A2A: agent card, SendMessage, question loop, push webhooks, cancel', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-a2a-'));
  const host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  t.after(async () => { await host.close(); await rm(dir, { recursive: true, force: true }); });

  const device = host.store.device('A2A box');
  host.store.data.devices.find(d => d.id === device.id).online = true;
  const { agent, token } = host.store.agent({ role: 'device', id: device.id, name: 'A2A box' }, { name: 'A2A test', deviceId: device.id, harness: 'test', command: 'node', args: [], cwd: dir });
  const agentActor = { role: 'agent', id: agent.id, name: agent.name };
  const base = host.address;
  const rpc = (method, params, auth = token) => fetch(`${base}/a2a`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(async res => ({ status: res.status, body: await res.json() }));
  // The agent answers through the bridge, exactly like a real harness would.
  const agentTool = (name, body) => fetch(`${base}/api/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }).then(async res => ({ status: res.status, body: await res.json() }));
  const text = parts => parts.filter(p => p.kind === 'text').map(p => p.text).join('\n');

  // Agent card: self-describing manifest at the well-known URL.
  const cardRes = await fetch(`${base}/.well-known/agent-card.json?agent=${agent.id}`);
  assert.equal(cardRes.status, 200);
  const card = await cardRes.json();
  assert.equal(card.name, 'A2A test');
  assert.equal(card.protocolVersion, '1.0');
  assert.equal(card.url, `${base}/a2a`);
  assert.ok(card.skills.length >= 1 && card.capabilities.pushNotifications, 'Card must advertise skills and push support');
  assert.equal(card.securitySchemes.bearerAuth.scheme, 'bearer');

  // No key / wrong key: 401 with a JSON-RPC error.
  const unauth = await rpc('GetTask', { id: 'x' }, null);
  assert.equal(unauth.status, 401); assert.ok(unauth.body.error);
  const other = await rpc('GetTask', { id: 'x' }, 'nope');
  assert.equal(other.status, 401);

  // SendMessage: the task starts working and lands in the agent's inbox.
  const sent = await rpc('SendMessage', { message: { role: 'user', parts: [{ kind: 'text', text: 'Say hello to the A2A world.' }] } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const task = sent.body.result;
  assert.equal(task.status, 'working');
  assert.ok(task.id && task.history.some(h => h.state === 'submitted'));
  const inbox = host.store.unread(agent.id);
  assert.ok(inbox.some(m => m.from === 'a2a' && m.body.includes('A2A world')), 'The client message must reach the agent inbox');

  // GetTask / ListTasks.
  const got = await rpc('GetTask', { id: task.id });
  assert.equal(got.body.result.id, task.id);
  const listed = await rpc('ListTasks', { limit: 10 });
  assert.ok(listed.body.result.some(x => x.id === task.id));

  // The agent asks a question: task goes input-required.
  assert.equal((await agentTool('message', { to: 'a2a', body: 'Which timezone should the meeting use?' })).status, 200);
  let state = (await rpc('GetTask', { id: task.id })).body.result;
  assert.equal(state.status, 'input-required', 'A question back must move the task to input-required');
  assert.ok(text(state.messages.at(-1).parts).includes('timezone'));

  // The client answers on the same task: back to working.
  const followUp = await rpc('SendMessage', { message: { role: 'user', parts: [{ kind: 'text', text: 'Use UTC.' }], taskId: task.id } });
  assert.equal(followUp.body.result.status, 'working');

  // The agent's final answer (notice) completes the task with the reply as result.
  assert.equal((await agentTool('notice', { to: 'a2a', body: 'Hello from Relaydeck. Meeting in UTC.' })).status, 200);
  state = (await rpc('GetTask', { id: task.id })).body.result;
  assert.equal(state.status, 'completed', 'A notice reply must complete the task');
  assert.ok(text(state.messages.at(-1).parts).includes('Hello from Relaydeck'));

  // A reply to a finished task must not resurrect it.
  await agentTool('notice', { to: 'a2a', body: 'Extra.' });
  assert.equal((await rpc('GetTask', { id: task.id })).body.result.status, 'completed');

  // Push notifications: the webhook fires on every transition.
  const hits = [];
  const hook = createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => { hits.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }); }).listen(0, '127.0.0.1');
  await new Promise(r => hook.once('listening', r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
  t.after(() => hook.close());
  const setRes = await rpc('SetTaskPushNotificationConfig', { url: hookUrl, token: 'webhook-token' });
  assert.equal(setRes.status, 200);
  assert.equal(setRes.body.result.url, hookUrl);
  assert.ok((await rpc('ListTaskPushNotificationConfigs', {})).body.result.some(c => c.url === hookUrl));

  const fresh = (await rpc('SendMessage', { message: { role: 'user', parts: [{ kind: 'text', text: 'Webhook probe.' }] } })).body.result;
  await agentTool('notice', { to: 'a2a', body: 'Webhook answered.' });
  await new Promise(r => setTimeout(r, 500));
  assert.ok(hits.some(h => h.id === fresh.id && h.status === 'completed'), 'The push webhook must receive the completed task');
  assert.ok(hits.length >= 1);

  const del = await rpc('DeleteTaskPushNotificationConfig', { id: setRes.body.result.id });
  assert.equal(del.body.result.deleted, true);

  // CancelTask: working tasks can be canceled; finished ones cannot.
  const cancelable = (await rpc('SendMessage', { message: { role: 'user', parts: [{ kind: 'text', text: 'Cancel me.' }] } })).body.result;
  const canceled = await rpc('CancelTask', { id: cancelable.id });
  assert.equal(canceled.body.result.status, 'canceled');
  const again = await rpc('CancelTask', { id: cancelable.id });
  assert.equal(again.status, 400);
  const missing = await rpc('GetTask', { id: 'nope' });
  assert.equal(missing.status, 400);
  assert.ok(missing.body.error.message.includes('not found') || missing.body.error.message.includes('Not found'));
});
