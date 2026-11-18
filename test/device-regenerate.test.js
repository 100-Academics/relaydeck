import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/server.js';
import { startRunner } from '../src/runner.js';
import { Store } from '../src/store.js';

const wait = async (predicate, ms = 15000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 50)); } };

test('regenerating a device key persists the activity entry across a host restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-regen-act-'));
  let host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  t.after(async () => { if (host) { await host.close().catch(() => {}); host = null; } await rm(dir, { recursive: true, force: true }); });
  const auth = { Authorization: `Bearer ${host.store.data.adminToken}`, 'Content-Type': 'application/json' };
  const device = await (await fetch(`${host.address}/api/devices`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Laptop' }) })).json();
  const res = await fetch(`${host.address}/api/devices/${device.id}/regenerate`, { method: 'POST', headers: auth });
  assert.equal(res.status, 200);
  assert.ok(host.store.data.activity.some(a => a.detail.includes('Regenerated key')));
  await host.close(); host = null;
  const fresh = new Store(dir);
  const persisted = fresh.data.activity.some(a => a.detail.includes('Regenerated key'));
  fresh.close();
  assert.ok(persisted, 'activity entry must survive a host restart');
});

test('regenerating a device key stops its running agent processes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-regen-orphan-'));
  let host, runner;
  t.after(async () => { runner?.stop(); await host?.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
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
  assert.ok(alive(pid), 'harness must be running before regeneration');
  const res = await fetch(`${host.address}/api/devices/${device.id}/regenerate`, { method: 'POST', headers: auth });
  assert.equal(res.status, 200);
  await wait(() => !alive(pid), 10000);
  assert.ok(!alive(pid), `harness process ${pid} must be stopped when its device key is regenerated`);
  await wait(() => ['stopped', 'disconnected'].includes(host.store.data.agents[0].status), 15000);
  assert.ok(['stopped', 'disconnected'].includes(host.store.data.agents[0].status), `agent status should settle, got ${host.store.data.agents[0].status}`);
});

test('regenerating a device key revokes its web sessions but keeps the new key working', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-regen-sess-'));
  let host;
  t.after(async () => { await host?.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  const auth = { Authorization: `Bearer ${host.store.data.adminToken}`, 'Content-Type': 'application/json' };
  const device = await (await fetch(`${host.address}/api/devices`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Laptop' }) })).json();
  const login = await fetch(`${host.address}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: device.token }) });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('relaydeck_session='));
  const before = await fetch(`${host.address}/api/state`, { headers: { cookie } });
  assert.equal(before.status, 200);
  const res = await fetch(`${host.address}/api/devices/${device.id}/regenerate`, { method: 'POST', headers: auth });
  assert.equal(res.status, 200);
  const next = await res.json();
  const stale = await fetch(`${host.address}/api/state`, { headers: { cookie } });
  assert.equal(stale.status, 401, 'a session signed in with the old key must be revoked');
  const relogin = await fetch(`${host.address}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: next.token }) });
  assert.equal(relogin.status, 200, 'the regenerated key must sign in');
});
