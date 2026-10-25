import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/server.js';

test('real MCP transport discovers tools, receives context, and honors host controls', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-mcp-'));
  const host = await createHost({ directory: dir, port: 0, local: false, quiet: true });
  const hostActor = { role: 'admin', id: 'human', name: 'Human' };
  const d = host.store.device('MCP test'); host.store.data.devices[0].online = true;
  const { agent, token } = host.store.agent(hostActor, { name: 'Bridge test', deviceId: d.id, harness: 'test', command: 'node', args: [], cwd: dir });
  const client = new Client({ name: 'relaydeck-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/bridge.js')], env: { ...process.env, RELAYDECK_SERVER_URL: host.address, RELAYDECK_AGENT_TOKEN: token } }));
  const list = await client.listTools(); assert.ok(list.tools.some(t => t.name === 'message'));
  host.store.tool(hostActor, 'message', { to: agent.id, body: 'Please review the plan.' });
  const response = await client.callTool({ name: 'task', arguments: { task: 'Reviewing the plan' } });
  assert.equal(JSON.parse(response.content[0].text).inbox[0].body, 'Please review the plan.');
  const reply = await client.callTool({ name: 'notice', arguments: { to: 'human', body: 'The plan is ready.' } });
  assert.equal(reply.isError, undefined); assert.ok(host.store.data.messages[0].answeredAt);
  host.store.data.settings.notice = false;
  const blocked = await client.callTool({ name: 'notice', arguments: { to: 'human', body: 'Blocked' } });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /disabled/);
});
