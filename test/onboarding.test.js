import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHost } from '../src/server.js';
import { startRunner } from '../src/runner.js';
import { onboardingLaunch, agentInstructions } from '../src/onboarding.js';
import { clientGuiUrl } from '../src/runtime.js';

const wait = async predicate => { const end = Date.now() + 15000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for agent'); await new Promise(r => setTimeout(r, 50)); } };

test('onboarding adapters preserve arguments and settings; manual mode leaves launches alone', async () => {
  const agent = { id: 'a', name: 'Atlas', args: ['--model', 'chosen-model'], startupInstructions: 'Review the backend.' };
  const instructions = await agentInstructions(agent);
  const file = 'C:/workspace with spaces/session/SKILL.md';
  const hermes = onboardingLaunch({ ...agent, harness: 'Hermes' }, instructions, { HERMES_ENVIRONMENT_HINT: 'Existing environment', HERMES_EPHEMERAL_SYSTEM_PROMPT: 'Existing personality' }, file);
  assert.equal(hermes.env.HERMES_EPHEMERAL_SYSTEM_PROMPT, 'Existing personality');
  assert.ok(hermes.env.HERMES_ENVIRONMENT_HINT.startsWith('Existing environment\n\n'));
  assert.ok(hermes.env.HERMES_ENVIRONMENT_HINT.includes(instructions));
  assert.deepEqual(hermes.args, agent.args);
  const open = onboardingLaunch({ ...agent, harness: 'OpenCode' }, instructions, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'custom/model', instructions: ['existing.md'], mcp: { existing: {} } }) }, file);
  const config = JSON.parse(open.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.instructions, ['existing.md', file]); assert.equal(config.model, 'custom/model'); assert.deepEqual(config.mcp, { existing: {} });
  const claude = onboardingLaunch({ ...agent, harness: 'Claude Code', args: ['--append-system-prompt', 'Existing rules', '--model', 'chosen-model'] }, instructions, {}, file);
  assert.equal(claude.args.filter(a => a === '--append-system-prompt').length, 1);
  assert.ok(claude.args[1].startsWith('Existing rules\n\n')); assert.ok(claude.args[1].includes(file));
  const codex = onboardingLaunch({ ...agent, harness: 'Codex' }, instructions, {}, file);
  assert.equal(codex.args[0], '-c'); assert.ok(codex.args[1].startsWith('developer_instructions=')); assert.deepEqual(codex.args.slice(2), agent.args);
  for (const harness of ['Hermes', 'OpenCode', 'Claude Code', 'Codex', 'Custom', 'Shell']) {
    const manual = onboardingLaunch({ ...agent, harness, onboarding: 'manual' }, instructions, {}, file);
    assert.deepEqual(manual.args, agent.args); assert.equal(manual.automatic, false); assert.equal(manual.env.RELAYDECK_INSTRUCTIONS, file);
  }
});

test('a real hosted process receives its skill, posts to the room, and uses edited commands after restart', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-onboarding-'));
  const host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  let runner;
  t.after(async () => { runner?.stop(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  const request = async (route, { body, method, token = host.store.data.adminToken } = {}) => {
    const response = await fetch(`${host.address}/api${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const d = (await request('/devices', { body: { name: 'Test runner' } })).data;
  runner = await startRunner({ server: host.address, token: d.token, root: dir, log() {} });
  await wait(() => host.store.data.devices[0].online);
  const fixture = path.join(dir, 'agent.mjs');
  await writeFile(fixture, `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const instructions = readFileSync(process.env.RELAYDECK_INSTRUCTIONS, 'utf8');
    assert.ok(process.env.HERMES_ENVIRONMENT_HINT.includes(instructions));
    assert.ok(instructions.includes(process.env.RELAYDECK_AGENT_ID));
    assert.ok(instructions.includes('room_history'));
    const result = spawnSync(process.execPath, [process.env.RELAYDECK_BRIDGE, '--call', 'group_notice', '--stdin'], { input: JSON.stringify({ groupId: 'team', body: process.argv[2] }), encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    process.stdin.resume();
  `);
  const created = await request('/agents', { token: d.token, body: { name: 'Room-aware agent', deviceId: d.id, harness: 'Hermes', command: process.execPath, args: [fixture, 'first launch'], cwd: dir } });
  assert.equal(created.status, 200);
  const a = created.data;
  await wait(() => host.store.data.messages.some(m => m.from === a.id && m.body === 'first launch'));
  const preview = await request(`/agents/${a.id}/instructions`, { token: d.token });
  assert.equal(preview.status, 200); assert.ok(preview.data.instructions.includes(a.id));
  assert.ok(!preview.data.instructions.includes(host.store.agentToken(a.id)));
  const patch = { method: 'PATCH', body: { args: [fixture, 'second launch'], startupInstructions: 'Coordinate with the frontend agent.' } };
  const other = (await request('/devices', { body: { name: 'Other device' } })).data;
  assert.equal((await request(`/agents/${a.id}`, { ...patch, token: other.token })).status, 403);
  assert.equal((await request(`/agents/${a.id}`, { ...patch, token: host.store.agentToken(a.id) })).status, 403);
  assert.equal((await request(`/agents/${a.id}/instructions`, { token: other.token })).status, 403);
  assert.equal((await request(`/agents/${a.id}`, { ...patch, token: d.token })).status, 200);
  assert.equal(host.store.data.agents[0].status, 'running');
  assert.equal(host.store.data.messages.filter(m => m.body === 'second launch').length, 0);
  const invalid = await request(`/agents/${a.id}`, { method: 'PATCH', token: d.token, body: { args: 'not an array' } });
  assert.equal(invalid.status, 400); assert.deepEqual(host.store.data.agents[0].args, patch.body.args);
  assert.equal((await request(`/agents/${a.id}`, { method: 'PATCH', body: { deviceId: other.id } })).status, 400);
  await request(`/agents/${a.id}/stop`, { body: {}, token: d.token });
  await wait(() => host.store.data.agents[0].status === 'stopped');
  await request(`/agents/${a.id}/restart`, { body: {}, token: d.token });
  await wait(() => host.store.data.messages.some(m => m.from === a.id && m.body === 'second launch'));
  await request(`/agents/${a.id}/stop`, { body: {}, token: d.token });
  await wait(() => host.store.data.agents[0].status === 'stopped');
});

test('client GUI links normalize trailing slashes and encode ticket parameters', () => {
  for (const base of ['http://localhost:4318', 'http://localhost:4318/', 'http://localhost:4318//']) {
    const url = new URL(clientGuiUrl(base, 'a&b', 'test/ticket?'));
    assert.equal(url.pathname, '/'); assert.equal(url.searchParams.get('device'), 'a&b');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('ticket'), 'test/ticket?');
  }
  assert.equal(new URL(clientGuiUrl('http://[::1]:4318/', 'device')).hash, '');
});
