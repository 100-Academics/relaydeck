import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createHost } from '../src/server.js';
import { startRunner } from '../src/runner.js';

const wait = async (predicate, ms = 15000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 50)); } };

test('removing a connected device does not crash the host and revokes its sessions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-remove-crash-'));
  let host, ws;
  t.after(async () => { ws?.close(); if (host) { await host.close().catch(() => {}); host = null; } await rm(dir, { recursive: true, force: true }); });
  const uncaught = [];
  const onUncaught = err => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.removeListener('uncaughtException', onUncaught));
  host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  const auth = { Authorization: `Bearer ${host.store.data.adminToken}`, 'Content-Type': 'application/json' };
  const device = await (await fetch(`${host.address}/api/devices`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Laptop' }) })).json();
  // A browser signed in with the device key.
  const login = await fetch(`${host.address}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: device.token }) });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  // A connected device runner.
  ws = new WebSocket(host.address.replace('http', 'ws') + '/ws');
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', token: device.token, root: dir, hostname: 'test', platform: process.platform, sessions: [] }));
  await new Promise(r => ws.once('message', m => JSON.parse(m).type === 'ready' && r()));
  await wait(() => host.store.data.devices.some(d => d.id === device.id && d.online));
  const res = await fetch(`${host.address}/api/devices/${device.id}`, { method: 'DELETE', headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  // The socket close handler runs asynchronously; give it time to execute.
  await new Promise(r => setTimeout(r, 500));
  assert.equal(uncaught.length, 0, `removing a connected device must not throw in the close handler: ${uncaught.map(e => e.message).join('; ')}`);
  const health = await fetch(`${host.address}/api/health`);
  assert.equal(health.status, 200, 'the host must still be serving after the removal');
  const state = await fetch(`${host.address}/api/state`, { headers: { cookie } });
  assert.equal(state.status, 401, 'a session signed in with the removed device key must be revoked');
});

test('removing a connected device stops its running agent processes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-remove-orphan-'));
  let host, runner;
  t.after(async () => { runner?.stop(); if (host) { await host.close().catch(() => {}); host = null; } await rm(dir, { recursive: true, force: true }); });
  host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  const auth = { Authorization: `Bearer ${host.store.data.adminToken}`, 'Content-Type': 'application/json' };
  const device = await (await fetch(`${host.address}/api/devices`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Laptop' }) })).json();
  const pidFile = (dir + '/harness.pid').replaceAll('\\', '/');
  runner = await startRunner({ server: host.address, token: device.token, root: dir, log() {} });
  await wait(() => host.store.data.devices[0].online);
  const launch = await fetch(`${host.address}/api/agents`, {
    method: 'POST', headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: device.id, name: 'Long runner', harness: 'Node', command: process.execPath, args: ['-e', `require('fs').writeFileSync('${pidFile}',String(process.pid));setInterval(()=>{},60000)`], cwd: dir }),
  });
  assert.equal(launch.status, 200);
  await wait(() => host.store.data.agents[0].status === 'running');
  try { await wait(() => existsSync(pidFile)); } catch { throw new Error('harness pid file was never written; check the PTY launch'); }
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  const alive = p => { try { process.kill(p, 0); return true; } catch { return false; } };
  assert.ok(alive(pid), 'harness must be running before removal');
  const res = await fetch(`${host.address}/api/devices/${device.id}`, { method: 'DELETE', headers: auth });
  assert.equal(res.status, 200);
  await wait(() => !alive(pid), 10000);
  assert.ok(!alive(pid), `harness process ${pid} must be stopped when its device is removed`);
  assert.equal(host.store.data.devices.some(d => d.id === device.id), false);
  assert.equal(host.store.data.agents.length, 0);
});
