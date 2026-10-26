import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';

const url = process.env.RELAYDECK_SERVER_URL || process.env.AMOEBA_SERVER_URL;
const token = process.env.RELAYDECK_AGENT_TOKEN || process.env.AMOEBA_AGENT_TOKEN;
if (!url || !token) { console.error('Start this bridge inside an Relaydeck-hosted harness. RELAYDECK_SERVER_URL and RELAYDECK_AGENT_TOKEN are required.'); process.exit(1); }
async function request(route, body) {
  const res = await fetch(new URL(route, url), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(75000) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || `Host returned ${res.status}`); return data;
}
const definitions = {
  agents: { description: 'List the team, current tasks, device, harness, and lifecycle state.', schema: {} },
  rooms: { description: 'Discover the shared chat rooms you belong to. The Team room has ID team.', schema: {} },
  room_history: { description: 'Read recent chat room notices in chronological order. Start with the team room for context.', schema: { groupId: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } },
  task: { description: 'Signal the task you are currently working on. Empty text clears the task.', schema: { task: z.string().max(2000) } },
  message: { description: 'Send a direct message. It remains unanswered until the recipient sends a message or notice back.', schema: { to: z.string(), body: z.string(), replyTo: z.string().optional() } },
  notice: { description: 'Send a direct notice without requiring an answer. Also answers pending messages from that recipient.', schema: { to: z.string(), body: z.string(), replyTo: z.string().optional() } },
  inbox: { description: 'Read new messages into your context. Call at the beginning of each turn and before finishing. Reading is not replying.', schema: { markRead: z.boolean().optional() } },
  group_notice: { description: 'Broadcast a notice to a group. Use team for the entire team. Groups accept notices only.', schema: { groupId: z.string().optional(), body: z.string() } },
  council: { description: 'Ask other agents for implementation recommendations. Replies arrive in your inbox.', schema: { question: z.string(), agentIds: z.array(z.string()).optional() } },
  activity: { description: 'Report a tool call or milestone so humans can follow your work.', schema: { tool: z.string(), detail: z.string(), success: z.boolean().optional() } },
  sync: { description: 'Check status, pull fast-forward, or push committed changes through the configured Forgejo/Gitea remote. Never force pushes.', schema: { action: z.enum(['status', 'pull', 'push']) } },
};
if (process.argv.includes('--call')) {
  const index = process.argv.indexOf('--call'); const name = process.argv[index + 1];
  try { if (!definitions[name]) throw new Error(`Unknown tool. Choose ${Object.keys(definitions).join(', ')}`); const input = process.argv.includes('--stdin') ? readFileSync(0, 'utf8').replace(/^\uFEFF/, '').trim() : process.argv[index + 2]; console.log(JSON.stringify(await request(`/api/tools/${name}`, JSON.parse(input || '{}')), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  const server = new McpServer({ name: 'relaydeck', version: '0.1.0' }, { instructions: 'You are part of a Relaydeck team with a shared chat room. Start with agents, rooms, room_history (groupId team), and inbox. Announce your task and post updates to group_notice (groupId team). Call inbox at each turn boundary and reply to direct messages. New messages are appended to every tool result. Reading is not replying.' });
  let available;
  try { available = await request('/api/tools'); } catch (error) { console.error(error.message); process.exit(1); }
  const registrations = {};
  for (const [name, definition] of Object.entries(definitions)) {
    registrations[name] = server.tool(name, definition.description, definition.schema, async input => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await request(`/api/tools/${name}`, input), null, 2) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
    if (!available.includes(name)) registrations[name].disable();
  }
  await server.connect(new StdioServerTransport());
  const timer = setInterval(async () => {
    try { const current = await request('/api/tools'); for (const name of Object.keys(registrations)) {
      if (current.includes(name) !== available.includes(name)) current.includes(name) ? registrations[name].enable() : registrations[name].disable();
    } available = current; } catch {}
  }, 5000); timer.unref();
}
