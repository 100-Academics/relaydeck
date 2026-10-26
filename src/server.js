import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, id, secret, fail, str, tools } from './store.js';
import { startRunner } from './runner.js';
import { options, openBrowser } from './runtime.js';
import { migrateWorkspace } from './migration.js';

const project = fileURLToPath(new URL('..', import.meta.url));
export async function createHost({ directory = path.join(project, '.relaydeck'), port = 4317, host = '127.0.0.1', local = true, root = process.cwd(), quiet = false } = {}) {
  fail(Number.isInteger(port) && port >= 0 && port <= 65535, 'Port must be an integer between 0 and 65535 (0 chooses an available port).');
  const app = express(), server = createServer(app);
  let ready = false, store;
  app.use((req, res, next) => ready ? next() : res.status(503).json({ error: 'Relaydeck is starting. Try again shortly.' }));
  // Reserve the listener before opening storage: a duplicate start must never
  // reset the running workspace's persisted connection state.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  try {
    await migrateWorkspace(directory, path.resolve(directory) === path.join(project, '.relaydeck') ? path.join(project, '.amoeba') : directory);
    store = new Store(directory);
  } catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const runners = new Map(), browsers = new Map(), buffers = new Map(), sessions = new Map(), pending = new Map(), tickets = new Map(), attempts = new Map();
  let localRunner, closing = false;
  const broadcast = () => { for (const [ws, actor] of browsers) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'state', state: store.snapshot(actor) })); };
  const actorFor = req => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer) return store.auth(bearer);
    const sessionId = req.headers.cookie?.match(/(?:^|; )relaydeck_session=([a-f0-9]+)/)?.[1];
    const session = sessions.get(sessionId);
    return session && session.expires > Date.now() ? session.actor : null;
  };
  const sameOrigin = req => !req.headers.origin || req.headers.origin === `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'" });
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' }); next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.get('/api/health', (req, res) => res.json({ status: 'ok', name: 'Relaydeck' }));
  app.post('/api/login', (req, res) => {
    const key = req.socket.remoteAddress;
    const attempt = attempts.get(key) || { count: 0, reset: Date.now() + 60000 };
    if (Date.now() > attempt.reset) { attempt.count = 0; attempt.reset = Date.now() + 60000; }
    fail(attempt.count < 20, 'Too many attempts. Wait a minute.', 429); attempt.count++; attempts.set(key, attempt);
    let actor;
    if (req.body.ticket && tickets.has(req.body.ticket)) { const t = tickets.get(req.body.ticket); tickets.delete(req.body.ticket); if (t.expires > Date.now()) actor = t.actor; }
    else actor = store.auth(req.body.token);
    fail(actor && actor.role !== 'agent', 'Use a host or device key to sign in.', 401);
    const sessionId = secret(); sessions.set(sessionId, { actor, expires: Date.now() + 7 * 86400000 });
    res.cookie('relaydeck_session', sessionId, { httpOnly: true, sameSite: 'strict', secure: req.secure || req.headers['x-forwarded-proto'] === 'https', maxAge: 7 * 86400000 });
    res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => { req.actor = actorFor(req); if (!req.actor) return res.status(401).json({ error: 'Sign in with your host or device key.' }); next(); });
  const human = (req, res, next) => { fail(req.actor.role !== 'agent', 'This action requires a host or device key.', 403); next(); };
  const admin = (req, res, next) => { fail(req.actor.role === 'admin', 'Only the host can change this setting.', 403); next(); };
  app.post('/api/logout', human, (req, res) => { const sid = req.headers.cookie?.match(/(?:^|; )relaydeck_session=([a-f0-9]+)/)?.[1]; sessions.delete(sid); res.clearCookie('relaydeck_session'); res.json({ ok: true }); });
  app.get('/api/state', human, (req, res) => res.json(store.snapshot(req.actor)));
  app.get('/api/tools', (req, res) => res.json(tools.filter(t => store.data.settings[t])));
  app.post('/api/gui-ticket', human, (req, res) => { const ticket = secret(); tickets.set(ticket, { actor: req.actor, expires: Date.now() + 60000 }); res.json({ ticket }); });
  app.post('/api/devices', admin, (req, res) => { const device = store.device(req.body.name); broadcast(); res.json(device); });
  app.patch('/api/settings', admin, (req, res) => {
    for (const [key, value] of Object.entries(req.body)) { fail(tools.includes(key) && typeof value === 'boolean', 'Unknown tool setting.'); store.data.settings[key] = value; }
    store.activity(req.actor.id, 'settings', 'Updated enabled tools'); store.save(); broadcast(); res.json(store.data.settings);
  });
  app.post('/api/groups', human, (req, res) => {
    const members = req.body.members || [];
    fail(Array.isArray(members) && members.every(v => store.data.agents.some(a => a.id === v)), 'Choose valid group members.');
    const group = { id: id(), name: str(req.body.name, 'Group name', 80), members: [...new Set(members)] };
    store.data.groups.push(group); store.save(); broadcast(); res.json(group);
  });
  app.post('/api/agents', human, (req, res) => {
    fail(runners.has(req.body.deviceId), 'Device is not connected.');
    const { agent, token } = store.agent(req.actor, req.body);
    runners.get(agent.deviceId).send(JSON.stringify({ type: 'launch', agent: { ...agent, tokenHash: undefined }, token }));
    broadcast(); res.json({ ...agent, tokenHash: undefined });
  });
  function controlled(req) {
    const a = store.data.agents.find(a => a.id === req.params.id);
    fail(a, 'Agent not found.', 404); fail(store.canControl(req.actor, a), 'You can only control agents on your own device.', 403); return a;
  }
  app.post('/api/agents/:id/stop', human, (req, res) => {
    const a = controlled(req); fail(runners.has(a.deviceId), 'Device is disconnected.');
    runners.get(a.deviceId).send(JSON.stringify({ type: 'stop', agentId: a.id })); res.json({ ok: true });
  });
  app.post('/api/agents/:id/restart', human, (req, res) => {
    const a = controlled(req); fail(runners.has(a.deviceId), 'Device is disconnected.');
    fail(!['running', 'starting'].includes(a.status), 'Stop the current process before restarting.');
    a.status = 'starting'; a.error = undefined; a.exitCode = undefined; buffers.delete(a.id);
    store.save(); runners.get(a.deviceId).send(JSON.stringify({ type: 'launch', agent: { ...a, tokenHash: undefined }, token: store.agentToken(a.id) })); broadcast(); res.json({ ok: true });
  });
  app.get('/api/agents/:id/bridge', human, (req, res) => {
    const a = controlled(req), d = store.data.devices.find(d => d.id === a.deviceId);
    const command = d.nodePath || 'node', args = [d.bridgePath || 'src/bridge.js'];
    const env = { RELAYDECK_SERVER_URL: `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`, RELAYDECK_AGENT_TOKEN: store.agentToken(a.id) };
    const entry = { command, args, env };
    const configurations = {
      generic: { mcpServers: { relaydeck: entry } },
      hermes: { mcp_servers: { relaydeck: entry } },
      opencode: { mcp: { relaydeck: { type: 'local', command: [command, ...args], environment: env, enabled: true } } },
      'opencode-v2': { mcp: { servers: { relaydeck: { type: 'local', command: [command, ...args], environment: env } } } },
    };
    res.json({ configurations, instructions: 'Add the matching configuration to your harness settings, then restart the agent. This key identifies only this agent. Call inbox at the start of each turn. All tool results include new messages. Use message or notice to reply; reading does not mark a message answered.' });
  });
  const deliver = messages => { for (const m of messages) for (const recipient of m.recipients) {
    const a = store.data.agents.find(a => a.id === recipient);
    if (a?.delivery === 'terminal' && a.status === 'running') runners.get(a.deviceId)?.send(JSON.stringify({ type: 'deliver', agentId: a.id, text: `${m.fromName}: ${m.body}` }));
  } };
  async function sync(actor, input) {
    fail(store.data.settings.sync, 'The host has disabled sync.', 403);
    let deviceId = input.deviceId;
    if (actor.role === 'agent') {
      const a = store.data.agents.find(a => a.id === actor.id); deviceId = a.deviceId;
      input = { ...input, cwd: a.cwd }; fail(input.action !== 'configure', 'Only a human can configure the sync remote.', 403);
    }
    fail(actor.role !== 'device' || actor.id === deviceId, 'You can only sync your own device.', 403);
    const ws = runners.get(deviceId); fail(ws, 'Device is not connected.');
    const requestId = id();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Sync timed out. Check device connectivity and Git credentials.')); }, 70000);
      pending.set(requestId, { resolve, reject, timer, deviceId });
      ws.send(JSON.stringify({ type: 'sync', requestId, input }));
    });
    store.activity(actor.id, 'sync', `${input.action}: ${result.output}`); store.save(); return { result, inbox: [] };
  }
  app.post('/api/tools/:name', async (req, res) => {
    const before = store.data.messages.length;
    try {
      const result = req.params.name === 'sync' ? await sync(req.actor, req.body) : store.tool(req.actor, req.params.name, req.body);
      deliver(store.data.messages.slice(before)); broadcast(); res.json(result);
    } catch (error) { store.activity(req.actor.id, req.params.name, error.message, false); store.save(); broadcast(); throw error; }
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use(express.static(path.join(project, 'dist')));
  app.get('/', (req, res) => res.status(503).send('Build the GUI first: npm run build'));
  app.use((error, req, res, next) => res.status(error.status || 400).json({ error: error.message }));
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !sameOrigin(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    let actor = actorFor(req), authenticated = false;
    const authTimer = setTimeout(() => { if (!authenticated) ws.close(4003, 'Authentication required'); }, 5000);
    ws.alive = true; ws.on('pong', () => { ws.alive = true; });
    if (actor && actor.role !== 'agent') { authenticated = true; browsers.set(ws, actor); ws.send(JSON.stringify({ type: 'state', state: store.snapshot(actor) })); }
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        if (!authenticated) {
          fail(msg.type === 'hello', 'Authenticate first.'); actor = store.auth(msg.token);
          fail(actor?.role === 'device', 'Invalid device key.', 401);
          const d = store.data.devices.find(d => d.id === actor.id);
          fail(!runners.has(d.id), 'Device is already connected.');
          authenticated = true; runners.set(d.id, ws);
          Object.assign(d, { online: true, root: str(msg.root, 'Root', 2000), hostname: msg.hostname, platform: msg.platform, bridgePath: msg.bridgePath, nodePath: msg.nodePath, lastSeen: new Date().toISOString() });
          const active = Array.isArray(msg.sessions) ? msg.sessions : [];
          for (const a of store.data.agents.filter(a => a.deviceId === d.id)) a.status = active.includes(a.id) ? 'running' : a.status === 'error' ? 'error' : 'stopped';
          store.save(); ws.send(JSON.stringify({ type: 'ready', deviceId: d.id })); broadcast(); return;
        }
        if (browsers.has(ws)) {
          const a = store.data.agents.find(a => a.id === msg.agentId);
          fail(a, 'Select an agent.');
          if (msg.type === 'subscribe') { ws.agentId = a.id; ws.send(JSON.stringify({ type: 'terminal', agentId: a.id, data: buffers.get(a.id) || '', reset: true })); return; }
          fail(store.canControl(actor, a), 'You can only control agents on your own device.', 403);
          fail(runners.has(a.deviceId), 'Device is disconnected.');
          if (msg.type === 'input') { fail(typeof msg.data === 'string' && msg.data.length <= 64000, 'Invalid terminal input.'); runners.get(a.deviceId).send(JSON.stringify(msg)); }
          else if (msg.type === 'resize') { fail(Number.isInteger(msg.cols) && Number.isInteger(msg.rows) && msg.cols >= 2 && msg.cols <= 500 && msg.rows >= 2 && msg.rows <= 200, 'Invalid terminal size.'); runners.get(a.deviceId).send(JSON.stringify(msg)); }
        } else {
          if (msg.type === 'result') {
            const p = pending.get(msg.requestId); if (p?.deviceId === actor.id) { clearTimeout(p.timer); pending.delete(msg.requestId); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); } return;
          }
          const a = store.data.agents.find(a => a.id === msg.agentId && a.deviceId === actor.id); fail(a, 'Unknown session.');
          if (msg.type === 'output') {
            fail(typeof msg.data === 'string' && msg.data.length < 1000000, 'Invalid terminal output.');
            buffers.set(a.id, ((msg.replace ? '' : buffers.get(a.id) || '') + msg.data).slice(-150000));
            for (const [browser] of browsers) if (browser.agentId === a.id && browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify({ type: 'terminal', agentId: a.id, data: msg.data, reset: !!msg.replace }));
          } else if (msg.type === 'status') {
            fail(['running', 'stopped', 'error'].includes(msg.status), 'Invalid status.');
            Object.assign(a, { status: msg.status, error: msg.error?.slice(0, 2000), exitCode: msg.exitCode });
            store.activity(a.id, 'process', msg.error || `${msg.status}${msg.exitCode == null ? '' : ` (exit ${msg.exitCode})`}`, msg.status !== 'error'); store.save(); broadcast();
          }
        }
      } catch (error) { ws.send(JSON.stringify({ type: 'error', error: error.message })); if (!authenticated) ws.close(4003, 'Authentication failed'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(authTimer); browsers.delete(ws);
      if (closing) return;
      if (actor && runners.get(actor.id) === ws) {
        runners.delete(actor.id); const d = store.data.devices.find(d => d.id === actor.id); d.online = false;
        for (const a of store.data.agents.filter(a => a.deviceId === d.id && ['running', 'starting'].includes(a.status))) a.status = 'disconnected';
        for (const [key, p] of pending) if (p.deviceId === d.id) { clearTimeout(p.timer); p.reject(new Error('Device disconnected during sync.')); pending.delete(key); }
        store.save(); broadcast();
      }
    });
  });
  const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } } }, 15000);
  const address = hostAddress(host, server.address().port);
  ready = true;
  if (local) {
    mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'local-device.key');
    let token = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    if (!store.auth(token)) { token = store.device('Host device').token; writeFileSync(file, token, { mode: 0o600 }); }
    localRunner = await startRunner({ server: address, token, root, log: quiet ? () => {} : console.log });
  }
  if (!quiet) { console.log(`\nRelaydeck host: ${address}\nHost key: ${store.data.adminToken}\n${host === '0.0.0.0' ? 'Listening on all interfaces. Use HTTPS or a private network for remote clients.\n' : ''}`); }
  return { app, server, store, address, ticket() { const key = secret(); tickets.set(key, { actor: { role: 'admin', id: 'human', name: 'You' }, expires: Date.now() + 60000 }); return key; }, async close() {
    closing = true;
    localRunner?.stop(); clearInterval(heartbeat);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Host shutting down.')); } pending.clear();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve)); wss.close(); store.close();
  } };
}
function hostAddress(host, port) {
  const name = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${name.includes(':') ? `[${name}]` : name}:${port}`;
}
export async function launchHost(config, { log = console.log, open = openBrowser } = {}) {
  try {
    const instance = await createHost(config);
    if (config.gui && !config.headless) open(`${instance.address}/#ticket=${instance.ticket()}`);
    return instance;
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const address = hostAddress(config.host || '127.0.0.1', config.port ?? 4317);
    let existing = false;
    try {
      const response = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      const health = await response.json(); existing = response.ok && health.name === 'Relaydeck' && health.status === 'ok';
    } catch {}
    if (!existing) throw new Error(`Port ${config.port ?? 4317} is already in use by another application. Choose another port, for example: npm start -- --port 4318`);
    log(`Relaydeck is already running at ${address}. Using the existing host; no second host was started.`);
    if (config.gui && !config.headless) open(address);
    return null;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = options({ help: { type: 'boolean', short: 'h' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', short: 'p', default: '4317' }, root: { type: 'string', default: process.cwd() }, data: { type: 'string', default: path.join(project, '.relaydeck') }, 'no-local': { type: 'boolean', default: false } });
    if (args.help) {
      console.log(`Relaydeck host\n\nUsage: npm start -- [options]\n\n  --port, -p <number>  Listening port (default: 4317; 0 picks an available port)\n  --host <address>    Bind address (default: 127.0.0.1)\n  --gui               Open the browser GUI\n  --headless          Run without opening a browser\n  --root <directory>  Local harness workspace (default: current directory)\n  --data <directory>  Persistent workspace data directory\n  --no-local          Run only the coordination server\n  --help, -h          Show this help\n\nExample: npm start -- --port 4318 --gui`);
    } else {
      const instance = await launchHost({ directory: args.data, port: Number(args.port), host: args.host, root: args.root, local: !args['no-local'], gui: args.gui, headless: args.headless });
      if (instance) {
        let closing = false;
        for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await instance.close(); process.exit(0); });
      }
    }
  } catch (error) { console.error(`Relaydeck: ${error.message}`); process.exitCode = 1; }
}
