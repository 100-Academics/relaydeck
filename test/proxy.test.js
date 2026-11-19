import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHost } from '../src/server.js';
import { startRunner } from '../src/runner.js';
import { Store } from '../src/store.js';

const wait = async (predicate, timeout = 15000) => { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for condition'); await new Promise(r => setTimeout(r, 50)); } };

test('environment variables are validated on startup and masked in the snapshot', () => {
  const dir = path.join(os.tmpdir(), `relaydeck-env-${Date.now()}`);
  const store = new Store(dir);
  const admin = { role: 'admin', id: 'human', name: 'You' };
  const ok = store.startup({ name: 'A', harness: 'Hermes', command: 'hermes', args: [], cwd: dir, env: { API_BASE: 'https://api.example.com', EMPTY: null }, proxy: true });
  assert.equal(ok.env.API_BASE, 'https://api.example.com'); assert.equal(ok.env.EMPTY, ''); assert.equal(ok.proxy, true);
  assert.throws(() => store.startup({ name: 'A', harness: 'Hermes', command: 'hermes', args: [], cwd: dir, env: { 'bad key': 'x' } }), /Environment variables/);
  assert.throws(() => store.startup({ name: 'A', harness: 'Hermes', command: 'hermes', args: [], cwd: dir, env: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`K${i}`, 'v'])) }), /Environment variables/);
  assert.throws(() => store.startup({ name: 'A', harness: 'Hermes', command: 'hermes', args: [], cwd: dir, env: { K: 42 } }), /Environment variables/);
  const device = store.device('Device');
  store.data.devices.find(d => d.id === device.id).online = true;
  const { agent, token } = store.agent({ role: 'device', id: device.id }, { name: 'Env agent', harness: 'Hermes', command: 'hermes', args: [], cwd: dir, deviceId: device.id, env: { SECRET_VALUE: 'top-secret' }, proxy: false });
  const snapshot = store.snapshot(admin);
  assert.equal(snapshot.agents[0].env.SECRET_VALUE, 'top-secret');
  assert.equal(snapshot.agents[0].proxy, false);
  store.close();
});

test('proxy services are host-only, masked, and scoped to agents with the proxy enabled', () => {
  const dir = path.join(os.tmpdir(), `relaydeck-proxystore-${Date.now()}`);
  const store = new Store(dir);
  const admin = { role: 'admin', id: 'human', name: 'You' };
  const device = store.device('Device');
  store.data.devices.find(d => d.id === device.id).online = true;
  const { agent: on } = store.agent({ role: 'device', id: device.id }, { name: 'On', harness: 'Hermes', command: 'hermes', args: [], cwd: dir, deviceId: device.id, proxy: true });
  const { agent: off } = store.agent({ role: 'device', id: device.id }, { name: 'Off', harness: 'Hermes', command: 'hermes', args: [], cwd: dir, deviceId: device.id, proxy: false });
  const service = store.addProxyService(admin, { name: 'Forgejo', host: 'git.example.com', header: 'Authorization', value: 'agent-secret-xyz' });
  assert.equal(service.masked, true); assert.equal(service.value, undefined);
  assert.equal(store.snapshot(admin).proxyServices[0].value, undefined);
  assert.equal(store.proxyServiceFor(on, 'git.example.com').value, 'agent-secret-xyz');
  assert.equal(store.proxyServiceFor(off, 'git.example.com'), null);
  assert.equal(store.proxyServiceFor(on, 'other.example.com'), null);
  assert.throws(() => store.addProxyService({ role: 'agent', id: on.id, name: 'On' }, { name: 'X', host: 'h', value: 'v' }), /host/);
  assert.throws(() => store.addProxyService(admin, { name: 'X', host: 'h', header: 'Bad Header', value: 'v' }), /Header/);
  store.removeProxyService(admin, service.id);
  assert.throws(() => store.removeProxyService(admin, service.id), /not found/);
  store.close();
});

test('the credential proxy injects the service key for matching agents and hides it from the harness', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-proxy-'));
  const upstream = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ auth: req.headers.authorization || null, agent: req.headers['x-relaydeck-agent'] || null, path: req.url })); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  let runner;
  t.after(async () => { upstream.close(); runner?.stop(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  const request = async (route, { body, method, token = host.store.data.adminToken } = {}) => {
    const response = await fetch(`${host.address}/api${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Authorization: ['Bearer', token].join(' '), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const device = (await request('/devices', { body: { name: 'Runner' } })).data;
  runner = await startRunner({ server: host.address, token: device.token, root: dir, log() {} });
  await wait(() => host.store.data.devices[0].online);
  const { agent, token } = host.store.agent({ role: 'device', id: device.id }, { name: 'Proxy agent', harness: 'Hermes', command: 'hermes', args: [], cwd: dir, deviceId: device.id, proxy: true });
  const other = host.store.agent({ role: 'device', id: device.id }, { name: 'Plain agent', harness: 'Hermes', command: 'hermes', args: [], cwd: dir, deviceId: device.id, proxy: false });
  const created = await request('/proxy/services', { body: { name: 'Local upstream', host: '127.0.0.1', header: 'Authorization', value: 'agent-secret-xyz' } });
  assert.equal(created.status, 200);
  const proxyPort = Number(new URL(host.proxy.address).port);
  const viaProxy = headers => fetch(`${host.proxy.address}/http://127.0.0.1:${upstream.address().port}/echo`, { headers }).then(async r => ({ status: r.status, data: await r.json() }));
  const injected = await viaProxy({ 'X-Relaydeck-Agent': token });
  assert.equal(injected.status, 200);
  assert.equal(injected.data.auth, 'agent-secret-xyz');
  assert.equal(injected.data.agent, null, 'The agent key must not be forwarded upstream');
  assert.equal(injected.data.path, '/echo');
  const anonymous = await viaProxy({});
  assert.equal(anonymous.status, 401);
  const unproxied = await viaProxy({ 'X-Relaydeck-Agent': host.store.agentToken(other.agent.id) });
  assert.equal(unproxied.status, 200);
  assert.equal(unproxied.data.auth, null, 'Agents without the proxy enabled must not receive an injected credential');
  const state = await request('/state');
  assert.ok(state.data.proxyAddress.startsWith('http://127.0.0.1:'));
  assert.equal(state.data.proxyServices.length, 1);
  assert.equal(state.data.proxyServices[0].value, undefined);
});

test('an agent harness receives its environment variables and proxy settings at launch', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-envlaunch-'));
  const host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  let runner;
  t.after(async () => { runner?.stop(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  const request = async (route, { body, method, token = host.store.data.adminToken } = {}) => {
    const response = await fetch(`${host.address}/api${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const device = (await request('/devices', { body: { name: 'Runner' } })).data;
  runner = await startRunner({ server: host.address, token: device.token, root: dir, log() {} });
  await wait(() => host.store.data.devices[0].online);
  const report = path.join(dir, 'launch-report.json');
  const fixture = path.join(dir, 'probe.mjs');
  await writeFile(fixture, `
    import { writeFileSync, readFileSync } from 'node:fs';
    const instructions = process.env.RELAYDECK_INSTRUCTIONS ? readFileSync(process.env.RELAYDECK_INSTRUCTIONS, 'utf8') : '';
    writeFileSync(process.argv[2], JSON.stringify({
      relaydeckVar: process.env.RELAYDECK_TEST_SECRET || null,
      proxyEnv: process.env.http_proxy || null,
      proxyInstructions: instructions.includes('Credential proxy') ? 'present' : 'absent',
      hostCredentialLeak: process.env.RELAYDECK_TOKEN || process.env.RELAYDECK_DEVICE_TOKEN || process.env.RELAYDECK_ADMIN_TOKEN || null,
    }));
    process.stdin.resume();
  `);
  await request('/proxy/services', { body: { name: 'Local upstream', host: '127.0.0.1', header: 'Authorization', value: 'agent-secret-xyz' } });
  const created = await request('/agents', { token: device.token, body: { name: 'Env agent', deviceId: device.id, harness: 'Hermes', command: process.execPath, args: [fixture, report], cwd: dir, env: { RELAYDECK_TEST_SECRET: 'injected-value' }, proxy: true } });
  assert.equal(created.status, 200);
  // Conpty startup on Windows can take several seconds; wait for the report
  // (or an explicit error) rather than a status that may already have passed.
  await wait(() => {
    const a = host.store.data.agents[0];
    if (a.status === 'error') return true;
    try { return Boolean(JSON.parse(readFileSync(report, 'utf8')).relaydeckVar); } catch { return false; }
  }, 90000);
  assert.notEqual(host.store.data.agents[0].status, 'error', host.store.data.agents[0].error);
  const launchReport = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(launchReport.relaydeckVar, 'injected-value', 'The per-agent environment variable must reach the harness');
  assert.equal(launchReport.proxyEnv, host.proxy.address, 'The proxy address must be in the harness environment');
  assert.equal(launchReport.proxyInstructions, 'present', 'The session skill must describe the credential proxy');
  assert.equal(launchReport.hostCredentialLeak, null, 'Host and device keys must not leak into the harness');
  await request(`/agents/${created.data.id}/stop`, { body: {}, token: device.token });
});
