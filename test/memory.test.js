import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { createHost } from '../src/server.js';
import { startRunner } from '../src/runner.js';
import { agentInstructions } from '../src/onboarding.js';

const admin = { role: 'admin', id: 'human', name: 'You' };
const worker = { role: 'agent', id: 'agent-1', name: 'Worker' };

let dir, store;
test.before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-memory-'));
  store = new Store(dir);
  store.data.agents.push({ id: 'agent-1', name: 'Worker', harness: 'Shell', command: 'sh', args: [], cwd: dir });
});
test.after(async () => { store?.close(); await rm(dir, { recursive: true, force: true }); });

test('remember records, memory reads, host can forget', () => {
  const entry = store.tool(worker, 'remember', { body: 'The test LLM key lives in .env' }).result;
  assert.ok(entry.id);
  const read = store.tool(worker, 'memory', {}).result;
  assert.equal(read.length, 1);
  assert.equal(read[0].body, 'The test LLM key lives in .env');
  assert.throws(() => store.remember(worker, ''), /Memory note/);
  store.forget(admin, entry.id);
  assert.equal(store.data.memory.length, 0);
});

test('artifact declarations validate kind and ref', () => {
  const file = store.tool(worker, 'artifact', { kind: 'file', ref: 'src/parser.js', note: 'new parser' }).result;
  assert.equal(file.kind, 'file');
  const port = store.tool(worker, 'artifact', { kind: 'port', ref: 4321 }).result;
  assert.equal(port.ref, 4321);
  assert.throws(() => store.artifact(worker, { kind: 'galaxy', ref: 'x' }), /Choose file, dir, service, or port/);
  assert.throws(() => store.artifact(worker, { kind: 'port', ref: 99999 }), /Port must be a number/);
  const list = store.tool(worker, 'artifacts', {}).result;
  assert.equal(list.length, 2);
});

test('session instructions carry the human role line and remembered facts', async () => {
  store.data.memory = [{ id: 'm1', body: 'Never force push to main', by: 'Worker', at: new Date().toISOString() }];
  const doc = await agentInstructions({ name: 'Worker', id: 'agent-1', startupInstructions: '' }, store.data.memory);
  assert.match(doc, /The human is here to help and to playtest/);
  assert.match(doc, /Never force push to main/);
  assert.match(doc, /## Project memory/);
});

test('remove-all deletes exactly the declared files and directories', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-artifacts-'));
  const host = await createHost({ directory: root, port: 0, local: false, root, quiet: true });
  let runner;
  t.after(async () => { runner?.stop(); await host.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (route, { body, method, token } = {}) => {
    const response = await fetch(`${host.address}/api${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token || host.store.data.adminToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const d = (await request('/devices', { body: { name: 'Builder' } })).data;
  runner = await startRunner({ server: host.address, token: d.token, root, log() {} });
  const wait = async (predicate, what, ms = 15000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${what}`); await new Promise(r => setTimeout(r, 50)); } };
  await wait(() => host.store.data.devices[0].online, 'device online');
  const agent = { id: 'agent-1', name: 'Worker', deviceId: d.id, harness: 'Shell', command: 'sh', args: [], cwd: root };
  host.store.data.agents.push(agent);
  // The agent creates things and declares them.
  await mkdir(path.join(root, 'generated'), { recursive: true });
  await writeFile(path.join(root, 'agent-made.txt'), 'made by the agent');
  await writeFile(path.join(root, 'keep-me.txt'), 'hand written');
  await writeFile(path.join(root, 'generated', 'bundle.js'), 'const x=1;');
  host.store.artifact(worker, { kind: 'file', ref: 'agent-made.txt' });
  host.store.artifact(worker, { kind: 'dir', ref: 'generated' });
  host.store.artifact(worker, { kind: 'service', ref: 'redis' });
  host.store.save();
  const { data } = await request('/artifacts/remove-all', { body: {} });
  if (!data.results?.[0]?.removed) console.error('REMOVE-ALL RESPONSE:', JSON.stringify(data, null, 2));
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].removed.length, 2, 'declared file + directory removed');
  await assert.rejects(stat(path.join(root, 'agent-made.txt')), 'declared file is gone');
  await assert.rejects(stat(path.join(root, 'generated')), 'declared directory is gone');
  await stat(path.join(root, 'keep-me.txt'), 'undeclared file survives');
  const ledger = host.store.data.artifacts;
  assert.deepEqual(ledger.map(a => a.kind), ['service'], 'services stay listed for manual stop');
  const { data: readBack } = await request('/artifacts');
  assert.equal(readBack.artifacts.length, 1);
});
