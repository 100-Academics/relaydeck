import WebSocket from 'ws';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { insideRoot, syncRepository } from './sync.js';
import { options, openBrowser } from './runtime.js';

const bridgePath = fileURLToPath(new URL('./bridge.js', import.meta.url));
const workerPath = fileURLToPath(new URL('./pty-worker.js', import.meta.url));
const exec = promisify(execFile);
export async function executable(command, args) {
  if (process.platform !== 'win32') return { command, args };
  let resolved = command;
  try { const { stdout } = await exec('where.exe', [command], { windowsHide: true, timeout: 5000 }); resolved = stdout.trim().split(/\r?\n/).find(p => /\.(exe|cmd|bat|ps1)$/i.test(p)) || command; } catch {}
  if (resolved === command && !path.isAbsolute(command)) {
    // PowerShell also resolves executables registered through Windows App Paths.
    const quoted = `'${command.replaceAll("'", "''")}'`;
    try { const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', `(Get-Command -Name ${quoted} -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source`], { windowsHide: true, timeout: 5000 }); if (stdout.trim()) resolved = stdout.trim(); } catch {}
  }
  if (/\.(cmd|bat|ps1)$/i.test(resolved)) {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', `& ${[resolved, ...args].map(quote).join(' ')}`] };
  }
  return { command: resolved, args };
}
export async function startRunner({ server, token, root, onReady = () => {}, log = console.log }) {
  root = await realpath(root);
  const url = new URL('/ws', server); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const processes = new Map(); let socket, timer, stopped = false, deviceId;
  const terminate = entry => {
    if (!entry || entry.stopping) return;
    entry.stopping = true;
    if (entry.worker.connected) entry.worker.send({ type: 'stop' });
  };
  const send = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const status = (agentId, state, error, exitCode) => send({ type: 'status', agentId, status: state, error, exitCode });
  async function launch({ agent, token: agentToken }) {
    if (processes.has(agent.id)) return;
    try {
      const cwd = await insideRoot(root, agent.cwd);
      const launchCommand = await executable(agent.command, agent.args);
      const env = { ...process.env, TERM: 'xterm-256color', RELAYDECK_SERVER_URL: server, RELAYDECK_AGENT_ID: agent.id, RELAYDECK_AGENT_TOKEN: agentToken, RELAYDECK_BRIDGE: bridgePath };
      // Do not let child harnesses inherit host or runner credentials.
      delete env.RELAYDECK_TOKEN; delete env.RELAYDECK_DEVICE_TOKEN; delete env.RELAYDECK_ADMIN_TOKEN;
      delete env.AMOEBA_TOKEN; delete env.AMOEBA_DEVICE_TOKEN; delete env.AMOEBA_ADMIN_TOKEN;
      const worker = fork(workerPath, [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
      const entry = { worker, output: '', cwd, ended: false }; processes.set(agent.id, entry);
      const forget = () => { if (processes.get(agent.id) === entry) processes.delete(agent.id); };
      worker.send({ type: 'start', ...launchCommand, cwd });
      worker.on('message', msg => {
        if (entry.ended) return;
        if (msg.type === 'output') { entry.output = (entry.output + msg.data).slice(-150000); send({ type: 'output', agentId: agent.id, data: msg.data }); }
        else if (msg.type === 'ready') status(agent.id, 'running');
        else if (msg.type === 'error') { entry.failed = true; status(agent.id, 'error', msg.error); }
        else if (msg.type === 'exit') { entry.ended = true; forget(); if (!entry.failed) status(agent.id, 'stopped', undefined, msg.exitCode); }
      });
      worker.on('error', error => { entry.failed = true; forget(); status(agent.id, 'error', error.message); });
      worker.on('exit', code => { forget(); if (!entry.ended && !entry.failed) status(agent.id, 'error', `Terminal worker exited unexpectedly (${code}).`); });
      worker.stderr.on('data', data => log(`Terminal worker: ${data.toString().trim()}`));
    } catch (error) { status(agent.id, 'error', error.message); }
  }
  function connect() {
    if (stopped) return;
    socket = new WebSocket(url, { maxPayload: 1024 * 1024 });
    socket.on('open', () => send({ type: 'hello', token, root, hostname: os.hostname(), platform: process.platform, bridgePath, nodePath: process.execPath, sessions: [...processes.keys()] }));
    socket.on('message', async raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'ready') {
          deviceId = msg.deviceId; log(`Connected ${deviceId} to ${server}. Workspace: ${root}`);
          for (const [agentId, entry] of processes) send({ type: 'output', agentId, data: entry.output, replace: true });
          onReady(deviceId);
        } else if (msg.type === 'launch') await launch(msg);
        else if (msg.type === 'input' || msg.type === 'resize') { const entry = processes.get(msg.agentId); if (entry?.worker.connected) entry.worker.send(msg); }
        else if (msg.type === 'stop') terminate(processes.get(msg.agentId));
        else if (msg.type === 'deliver') {
          const entry = processes.get(msg.agentId);
          if (entry) {
            // Keep control characters out of terminal input; submit as one prompt.
            const text = msg.text.replace(/[\x00-\x1f\x7f]/g, ' ');
            entry.worker.send({ type: 'input', data: `[Relaydeck message] ${text}` });
            setTimeout(() => { if (entry.worker.connected) entry.worker.send({ type: 'input', data: '\r' }); }, 100);
          }
        } else if (msg.type === 'sync') {
          try { send({ type: 'result', requestId: msg.requestId, result: await syncRepository(root, msg.input) }); }
          catch (error) { send({ type: 'result', requestId: msg.requestId, error: error.message }); }
        }
      } catch (error) { log(`Runner: ${error.message}`); }
    });
    socket.on('error', error => log(`Connection: ${error.message}`));
    socket.on('close', (code) => {
      if (code === 4003) { log('Device key rejected. Pair this device again from the host GUI.'); return; }
      if (!stopped) timer = setTimeout(connect, 2500);
    });
  }
  connect();
  return { stop() { stopped = true; clearTimeout(timer); for (const p of processes.values()) terminate(p); socket?.close(); }, get deviceId() { return deviceId; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = options({ server: { type: 'string', default: process.env.RELAYDECK_SERVER_URL || 'http://127.0.0.1:4317' }, token: { type: 'string' }, root: { type: 'string', default: process.cwd() } });
  const token = args.token || process.env.RELAYDECK_DEVICE_TOKEN || process.env.AMOEBA_DEVICE_TOKEN;
  if (!token) { console.error('Provide --token <device-key> or RELAYDECK_DEVICE_TOKEN. Create a device key in the host GUI.'); process.exit(1); }
  let opened = false;
  const runner = await startRunner({ server: args.server, token, root: args.root, async onReady(deviceId) {
    if (args.gui && !args.headless && !opened) {
      opened = true;
      try { const response = await fetch(new URL('/api/gui-ticket', args.server), { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); const { ticket } = await response.json(); openBrowser(`${args.server}/?device=${deviceId}#ticket=${ticket}`); }
      catch { openBrowser(`${args.server}/?device=${deviceId}`); }
    }
  } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { runner.stop(); setTimeout(() => process.exit(0), 300); });
}
