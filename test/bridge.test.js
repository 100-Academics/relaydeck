import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/server.js';

const bridgePath = path.resolve('src/bridge.js');

function bridge(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath, ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('the CLI bridge lists tools, receives context, and honors host controls', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-bridge-'));
  const host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  const hostActor = { role: 'admin', id: 'human', name: 'Human' };
  const d = host.store.device('CLI bridge test'); host.store.data.devices[0].online = true;
  const { agent, token } = host.store.agent(hostActor, { name: 'Bridge test', deviceId: d.id, harness: 'test', command: 'node', args: [], cwd: dir });
  const env = { RELAYDECK_SERVER_URL: host.address, RELAYDECK_AGENT_TOKEN: token };
  t.after(async () => { await host.close(); await rm(dir, { recursive: true, force: true }); });

  const help = await bridge(env, ['--help']);
  assert.equal(help.code, 0);
  for (const tool of ['agents', 'rooms', 'room_history', 'task', 'message', 'notice', 'inbox', 'group_notice', 'council', 'activity', 'sync']) assert.ok(help.stdout.includes(tool), `usage lists ${tool}`);

  host.store.tool(hostActor, 'message', { to: agent.id, body: 'Please review the plan.' });
  const task = await bridge(env, ['--call', 'task', JSON.stringify({ task: 'Reviewing the plan' })]);
  assert.equal(task.code, 0);
  assert.equal(JSON.parse(task.stdout).inbox[0].body, 'Please review the plan.');

  const reply = await bridge(env, ['--call', 'notice', JSON.stringify({ to: 'human', body: 'The plan is ready.' })]);
  assert.equal(reply.code, 0);
  assert.ok(host.store.data.messages[0].answeredAt);

  const unknown = await bridge(env, ['--call', 'bogus', '{}']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown tool/);

  host.store.data.settings.notice = false;
  const blocked = await bridge(env, ['--call', 'notice', JSON.stringify({ to: 'human', body: 'Blocked' })]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /disabled/);
});
