import { readFileSync } from 'node:fs';

const url = process.env.RELAYDECK_SERVER_URL || process.env.AMOEBA_SERVER_URL;
const token = process.env.RELAYDECK_AGENT_TOKEN || process.env.AMOEBA_AGENT_TOKEN;
if (!url || !token) { console.error('Start this bridge inside a Relaydeck-hosted harness. RELAYDECK_SERVER_URL and RELAYDECK_AGENT_TOKEN are required.'); process.exit(1); }

const definitions = {
  agents: 'List the team, current tasks, device, harness, and lifecycle state.',
  rooms: 'Discover the shared chat rooms you belong to. The Team room has ID team.',
  room_history: 'Read recent chat room notices in chronological order. Start with the team room for context.',
  task: 'Signal the task you are currently working on. Empty text clears the task.',
  message: 'Send a direct message. It remains unanswered until the recipient sends a message or notice back.',
  notice: 'Send a direct notice without requiring an answer. Also answers pending messages from that recipient.',
  inbox: 'Read new messages into your context. Call at the beginning of each turn and before finishing. Reading is not replying.',
  group_notice: 'Broadcast a notice to a group. Use team for the entire team. Groups accept notices only.',
  council: 'Ask other agents for implementation recommendations. Replies arrive in your inbox.',
  activity: 'Report a tool call or milestone so humans can follow your work.',
  sync: 'Check status, pull fast-forward, or push committed changes through the configured Forgejo/Gitea remote. Never force pushes.',
};

function usage() {
  const lines = ['Relaydeck CLI bridge — already authenticated for this agent by the inherited environment.', '', 'Usage: node $RELAYDECK_BRIDGE --call <tool> [json-input]', '       echo \'{"body":"hi"}\' | node $RELAYDECK_BRIDGE --call <tool> --stdin', '', 'Tools:'];
  for (const [name, description] of Object.entries(definitions)) lines.push(`  ${name.padEnd(14)} ${description}`);
  lines.push('', 'Examples:', '  node $RELAYDECK_BRIDGE --call inbox', '  node $RELAYDECK_BRIDGE --call group_notice \'{\"groupId\":\"team\",\"body\":\"Starting the assigned review.\"}\'');
  return lines.join('\n');
}

async function request(route, body) {
  const res = await fetch(new URL(route, url), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(75000) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || `Host returned ${res.status}`); return data;
}

const argv = process.argv.slice(2);
const callIndex = argv.indexOf('--call');
if (argv.includes('--help') || argv.includes('--usage') || argv.length === 0 || callIndex < 0) {
  const informational = argv.length === 0 || argv.includes('--help') || argv.includes('--usage');
  if (!informational) { console.error('Expected --call <tool>.'); }
  console.log(usage());
  if (!informational) process.exitCode = 1;
} else {
  const name = argv[callIndex + 1];
  try {
    if (!definitions[name]) throw new Error(`Unknown tool. Choose ${Object.keys(definitions).join(', ')}`);
    const input = argv.includes('--stdin') ? readFileSync(0, 'utf8').replace(/^\uFEFF/, '').trim() : argv[callIndex + 2];
    console.log(JSON.stringify(await request(`/api/tools/${name}`, JSON.parse(input || '{}')), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
