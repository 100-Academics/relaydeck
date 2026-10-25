import { createHost } from '../src/server.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

const command = process.argv[2] || 'hermes';
const temp = await mkdtemp(path.join(os.tmpdir(), 'relaydeck-harness-'));
const host = await createHost({ directory: temp, port: 0, root: process.cwd(), quiet: true });
let socket;
try {
  const until = async fn => { const deadline = Date.now() + 20000; while (!fn()) { if (Date.now() > deadline) throw new Error('Harness check timed out.'); await new Promise(r => setTimeout(r, 50)); } };
  await until(() => host.store.data.devices[0].online);
  const res = await fetch(`${host.address}/api/agents`, { method: 'POST', headers: { Authorization: `Bearer ${host.store.data.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Harness validation', harness: command, command, args: ['--help'], deviceId: host.store.data.devices[0].id, cwd: process.cwd() }) });
  const a = await res.json(); if (!res.ok) throw new Error(a.error);
  let output = '';
  socket = new WebSocket(host.address.replace('http', 'ws') + '/ws', { headers: { Authorization: `Bearer ${host.store.data.adminToken}` } });
  socket.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'terminal') output += m.data; });
  await new Promise(resolve => socket.once('open', resolve)); socket.send(JSON.stringify({ type: 'subscribe', agentId: a.id }));
  await until(() => ['stopped', 'error'].includes(host.store.data.agents[0].status));
  const current = host.store.data.agents[0];
  if (current.status === 'error' || current.exitCode !== 0 || !output.toLowerCase().includes('usage')) throw new Error(current.error || output.slice(-1500) || `Harness exited ${current.exitCode}`);
  console.log(`${command}: started inside the hosted PTY, streamed help output to the GUI channel, and exited successfully. No model calls made.`);
} finally { socket?.close(); await host.close(); await rm(temp, { recursive: true, force: true }); }
