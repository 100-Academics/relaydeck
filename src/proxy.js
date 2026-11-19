import http from 'node:http';
import https from 'node:https';

// A local credential proxy that sits OUTSIDE the agent's environment.
// Agents authenticate per request with their existing agent key
// (X-Relaydeck-Agent); when the target host matches a service the host has
// named for that agent, the real credential is injected here — the harness
// shell never sees it.
export function startCredentialProxy({ authenticate, serviceFor, host = '127.0.0.1', port = 0 }) {
  const server = http.createServer((req, res) => {
    let target;
    try {
      // Forward-proxy clients send the absolute target in the request line
      // (curl -x); some HTTP clients instead send it as a literal path with
      // a leading slash. Plain origin-form paths are not proxied.
      const candidate = req.url.replace(/^\/(?=https?:\/\/)/i, '');
      if (!/^https?:\/\//i.test(candidate)) throw new Error('absolute');
      target = new URL(candidate);
    } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Use an absolute http(s) target, for example: curl -x PROXY http://host/…' })); return; }
    if (!/^https?:$/.test(target.protocol)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Only http and https targets are proxied.' })); return; }
    const authHeader = String(req.headers['x-relaydeck-agent'] || '');
    authenticate(authHeader).then(async agent => {
      if (!agent) { res.writeHead(401, { 'Content-Type': 'application/json', 'Proxy-Authenticate': 'X-Relaydeck-Agent' }); res.end(JSON.stringify({ error: 'Unknown agent key. Send your Relaydeck agent key in the X-Relaydeck-Agent header.' })); return; }
      const portNumber = target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80);
      const service = await serviceFor(agent, target.hostname, portNumber);
      const headers = { ...req.headers };
      delete headers['x-relaydeck-agent'];
      delete headers['proxy-authorization'];
      delete headers['host'];
      if (service && typeof service === 'object') headers[String(service.header).toLowerCase()] = service.value;
      const transport = target.protocol === 'https:' ? https : http;
      const upstream = transport.request({ hostname: target.hostname, port: portNumber, path: `${target.pathname}${target.search}`, method: req.method, headers }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.rawHeaders);
        upstreamRes.pipe(res);
      });
      upstream.on('error', error => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Upstream: ${error.message}` })); });
      req.pipe(upstream);
    }).catch(error => { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(port, host, () => resolve({ server, address: `http://${host}:${server.address().port}`, close: () => new Promise(r => { server.close(r); for (const s of sockets) s.destroy(); }) }));
  });
}
