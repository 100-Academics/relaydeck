import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createHost } from '../src/server.js';
import { startRunner } from '../src/runner.js';

const projectRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const wait = async (predicate, what, ms = 20000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${what}`); await new Promise(r => setTimeout(r, 50)); } };

test('PTY worker streams visible output and survives resize', async t => {
  const worker = fork(path.join(projectRoot, 'src/pty-worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, TERM: 'xterm-256color' } });
  const messages = [];
  worker.on('message', m => messages.push(m));
  t.after(() => { if (worker.connected) worker.kill(); });
  worker.send({ type: 'start', command: process.execPath, args: ['-e', 'console.log("visible line one"); console.log("visible line two"); setTimeout(() => {}, 60000)'], cwd: projectRoot });
  await wait(() => messages.some(m => m.type === 'ready'), 'terminal ready');
  await wait(() => messages.some(m => m.type === 'output' && m.data.includes('visible line two')), 'visible output');
  worker.send({ type: 'resize', cols: 220, rows: 50 });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(messages.some(m => m.type === 'error'), false, 'resize must not error the terminal');
  worker.send({ type: 'stop' });
  await wait(() => messages.some(m => m.type === 'exit'), 'exit after stop', 10000);
});

test('watchdog flags a silent running agent and the hard timeout stops it', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-watchdog-'));
  const host = await createHost({ directory: dir, port: 0, local: false, quiet: true, watchdogMs: 250 });
  let runner;
  t.after(async () => { runner?.stop(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  const request = async (route, { body, method, token } = {}) => {
    const response = await fetch(`${host.address}/api${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token || host.store.data.adminToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const d = (await request('/devices', { body: { name: 'Test runner' } })).data;
  runner = await startRunner({ server: host.address, token: d.token, root: dir, log() {} });
  await wait(() => host.store.data.devices[0].online, 'device online');
  const fixture = path.join(dir, 'silent.mjs');
  await writeFile(fixture, 'console.log("one line"); setTimeout(() => {}, 30000);');
  const created = await request('/agents', { token: d.token, body: { name: 'Silent agent', deviceId: d.id, harness: 'Hermes', command: process.execPath, args: [fixture], cwd: dir } });
  const a = created.data;
  await wait(() => host.store.data.agents[0].status === 'running', 'agent running');
  host.store.data.agents[0].stallAfterSec = 1;
  host.store.data.agents[0].killAfterSec = 4;
  await wait(() => host.store.runtime.stalled.get(a.id) === true, 'stalled flag');
  const snapshot = host.store.snapshot({ role: 'admin', id: 'human', name: 'Human' });
  assert.equal(snapshot.agents[0].stalled, true);
  assert.ok(snapshot.agents[0].lastOutputAt > 0);
  assert.equal(host.store.data.activity.some(x => x.tool === 'stalled' && x.detail.includes(a.name)), true);
  await wait(() => host.store.data.agents[0].status === 'stopped', 'hard timeout stop');
  assert.equal(host.store.runtime.stalled.get(a.id), false);
  assert.equal(host.store.data.activity.some(x => x.tool === 'watchdog'), true);
});
