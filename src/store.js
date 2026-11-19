import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const id = () => randomUUID();
export const secret = () => randomBytes(32).toString('hex');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export const tools = ['agents', 'rooms', 'room_history', 'task', 'assign', 'message', 'notice', 'question', 'inbox', 'group_notice', 'council', 'situation', 'activity', 'room_update', 'sync', 'pin', 'unpin', 'pins', 'remember', 'memory', 'artifact', 'artifacts'];
export const agentRoles = ['worker', 'arbiter', 'compiler', 'secret'];
export const envKey = value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);export function fail(condition, message, status = 400) { if (!condition) throw Object.assign(new Error(message), { status }); }
export function str(value, label, max = 10000) { fail(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label} is required (up to ${max} characters).`); return value.trim(); }
export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'relaydeck.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    const row = this.db.prepare('SELECT data FROM workspace WHERE id=1').get();
    this.data = row ? JSON.parse(row.data) : {
      adminToken: secret(), devices: [], agents: [], groups: [{ id: 'team', name: 'Team room', members: [] }],
      messages: [], activity: [], councils: [], memory: [], artifacts: [], proxyServices: [], settings: Object.fromEntries(tools.map(t => [t, true])),
    };
    // Volatile per-agent runtime state (never persisted): when output last
    // arrived and whether the watchdog has flagged the agent as stalled.
    this.runtime = { lastOutput: new Map(), stalled: new Map() };
    this.data.memory ??= []; this.data.artifacts ??= []; this.data.proxyServices ??= [];
    for (const d of this.data.devices) d.online = false;    for (const tool of tools) this.data.settings[tool] ??= true;
    this.data.pinned ??= [];
    for (const a of this.data.agents) if (['running', 'starting'].includes(a.status)) a.status = 'disconnected';
    this.save();
  }
  save() { this.db.prepare('INSERT OR REPLACE INTO workspace (id, data) VALUES (1, ?)').run(JSON.stringify(this.data)); }
  close() { this.db.close(); }
  activity(actor, tool, detail, success = true) {
    this.data.activity.push({ id: id(), actor, tool, detail: String(detail).slice(0, 4000), success, at: new Date().toISOString() });
    this.data.activity = this.data.activity.slice(-2000);
  }
  device(name) {
    const token = secret();
    const d = { id: id(), name: str(name, 'Device name', 80), tokenHash: hash(token), online: false, createdAt: new Date().toISOString() };
    this.data.devices.push(d); this.save(); return { ...d, token, tokenHash: undefined };
  }
  regenerateDeviceToken(deviceId) {
    const d = this.data.devices.find(d => d.id === deviceId);
    fail(d, 'Device not found.', 404);
    const token = secret();
    d.tokenHash = hash(token);
    d.online = false;
    this.save();
    return { ...d, token, tokenHash: undefined };
  }
  renameDevice(actor, deviceId, name) {
    const d = this.data.devices.find(d => d.id === deviceId);
    fail(d, 'Device not found.', 404);
    fail(actor.role === 'admin' || (actor.role === 'device' && actor.id === deviceId), 'You can only rename your own device.', 403);
    d.name = str(name, 'Device name', 80);
    this.activity(actor.id, 'rename', `Renamed device to ${d.name}`);
    this.save();
    return { ...d, tokenHash: undefined };
  }
  updateGroup(actor, groupId, input) {
    fail(actor.role === 'admin', 'Only the host can edit rooms.', 403);
    const g = this.data.groups.find(g => g.id === groupId);
    fail(g, 'Group not found.', 404);
    if (input.name !== undefined) g.name = str(input.name, 'Room name', 80);
    if (input.add !== undefined || input.remove !== undefined) {
      fail(g.id !== 'team', 'The Team room includes every agent; membership cannot be edited.');
      const list = ids => Array.isArray(ids) ? ids : [];
      const known = ids => list(ids).every(v => this.data.agents.some(a => a.id === v));
      fail(known(input.add) && known(input.remove), 'Choose agents that exist.');
      for (const a of list(input.add)) if (!g.members.includes(a)) g.members.push(a);
      for (const r of list(input.remove)) g.members = g.members.filter(m => m !== r);
    }
    this.activity(actor.id, 'room_update', `Updated the ${g.name} room`);
    this.save();
    return g;
  }
  removeDevice(deviceId) {
    const index = this.data.devices.findIndex(d => d.id === deviceId);
    fail(index >= 0, 'Device not found.', 404);
    const [device] = this.data.devices.splice(index, 1);
    const agentIds = new Set(this.data.agents.filter(a => a.deviceId === deviceId).map(a => a.id));
    const gone = id => id === deviceId || agentIds.has(id);
    this.data.agents = this.data.agents.filter(a => !gone(a.id));
    // Keep group room history and conversations between surviving members;
    // drop only what the removed device or its agents sent, or what was
    // addressed solely to them.
    this.data.messages = this.data.messages.filter(m => !gone(m.from) && !(m.to != null && gone(m.to)));
    // Councils the removed device or its agents started go away; councils
    // others started keep their surviving participants.
    for (const c of this.data.councils) c.participants = c.participants.filter(id => !gone(id));
    this.data.councils = this.data.councils.filter(c => !gone(c.from) && c.participants.length > 0);
    this.save();
    return device;
  }
  auth(token) {
    if (typeof token !== 'string' || !token || token.length > 1000) return null;
    if (equal(token, this.data.adminToken)) return { role: 'admin', id: 'human', name: 'You' };
    const h = hash(token);
    const d = this.data.devices.find(d => equal(h, d.tokenHash));
    if (d) return { role: 'device', id: d.id, name: d.name };
    const a = this.data.agents.find(a => a.tokenHash && equal(h, a.tokenHash));
    if (a) return { role: 'agent', id: a.id, name: a.name };
    return null;
  }
  snapshot(actor) {
    return {
      viewer: actor,
      devices: this.data.devices.map(({ tokenHash, ...d }) => d),
      agents: this.data.agents.map(({ tokenHash, ...a }) => ({ ...a, lastOutputAt: this.runtime.lastOutput.get(a.id) || null, stalled: this.runtime.stalled.get(a.id) === true })),
      groups: this.data.groups, messages: this.data.messages, councils: this.data.councils, pinned: this.data.pinned,
      memory: this.data.memory, artifacts: this.data.artifacts,
      proxyServices: this.data.proxyServices.map(({ value, ...s }) => ({ ...s, masked: true })), proxyAddress: this.proxyAddress || null,
      activity: this.data.activity.slice(-200), settings: this.data.settings,
    };  }
  canControl(actor, agent) { return actor.role === 'admin' || (actor.role === 'device' && actor.id === agent.deviceId); }
  agentToken(agentId) { return createHmac('sha256', this.data.adminToken).update(`agent:${agentId}`).digest('hex'); }
  agent(actor, input) {
    const d = this.data.devices.find(d => d.id === input.deviceId);
    fail(d?.online, 'Choose a connected device.');
    fail(actor.role === 'admin' || actor.role === 'device' && actor.id === d.id, 'You can only launch agents on your own device.', 403);
    const startup = this.startup(input);
    const agentId = id(), token = this.agentToken(agentId);
    const a = { id: agentId, ...startup,
      deviceId: d.id, status: 'starting', task: '',
      tokenHash: hash(token), createdAt: new Date().toISOString() };
    this.data.agents.push(a); this.activity(actor.id, 'launch', `Started ${a.name} using ${a.harness}`); this.save();
    return { agent: a, token };
  }
  startup(input) {
    fail(Array.isArray(input.args) && input.args.length <= 100 && input.args.every(a => typeof a === 'string' && a.length < 10000 && !a.includes('\0')), 'Arguments must be a JSON array of strings.');
    fail(input.onboarding === undefined || ['auto', 'manual'].includes(input.onboarding), 'Choose automatic or manual room instructions.');
    fail(input.startupInstructions === undefined || typeof input.startupInstructions === 'string' && input.startupInstructions.length <= 12000, 'Startup instructions must be text up to 12,000 characters.');
    fail(input.delivery === undefined || ['inbox', 'terminal'].includes(input.delivery), 'Choose a valid message delivery mode.');
    fail(input.role === undefined || input.role === '' || agentRoles.includes(input.role), `Choose a valid role: ${agentRoles.join(', ')}.`);
    fail(input.stallAfterSec === undefined || input.stallAfterSec === '' || (Number.isInteger(input.stallAfterSec) && input.stallAfterSec >= 0), 'Stall threshold must be whole seconds (0 = per-harness default).');
    fail(input.killAfterSec === undefined || input.killAfterSec === '' || (Number.isInteger(input.killAfterSec) && input.killAfterSec >= 0), 'Hard timeout must be whole seconds (0 = off).');
    fail(input.env === undefined || (input.env === null || typeof input.env === 'object' && !Array.isArray(input.env)
      && Object.keys(input.env).length <= 50
      && Object.entries(input.env).every(([k, v]) => envKey(k) && (v === null || typeof v === 'string' && v.length <= 8192))), 'Environment variables must be KEY=VALUE pairs (max 50, keys A–Z, a–z, 0–9, _).');
    fail(input.proxy === undefined || typeof input.proxy === 'boolean', 'Proxy must be true or false.');
    return { name: str(input.name, 'Agent name', 80), harness: str(input.harness, 'Harness', 80), command: str(input.command, 'Command', 1024), args: [...input.args], cwd: str(input.cwd, 'Working directory', 2000), delivery: input.delivery || 'inbox', onboarding: input.onboarding || 'auto', startupInstructions: input.startupInstructions || '', role: input.role || 'worker', stallAfterSec: input.stallAfterSec || 0, killAfterSec: input.killAfterSec || 0, env: Object.fromEntries(Object.entries(input.env || {}).map(([k, v]) => [k, v === null ? '' : v])), proxy: !!input.proxy };
  }
  updateAgent(actor, agentId, input) {
    const a = this.data.agents.find(a => a.id === agentId);
    fail(a, 'Agent not found.', 404); fail(this.canControl(actor, a), 'You can only control agents on your own device.', 403);
    const allowed = ['name', 'harness', 'command', 'args', 'cwd', 'delivery', 'onboarding', 'startupInstructions', 'role', 'stallAfterSec', 'killAfterSec', 'env', 'proxy'];
    fail(input && Object.keys(input).every(k => allowed.includes(k)), 'Only startup settings can be edited.');    const next = this.startup({ ...a, ...input });
    fail(next.cwd === a.cwd || ['stopped', 'error'].includes(a.status), 'Stop the agent before changing its working directory.');
    Object.assign(a, next);
    this.activity(actor.id, 'startup', `Updated startup settings for ${a.name}; command changes apply on next launch`); this.save();
    return a;
  }
  unread(agentId) { return this.data.messages.filter(m => m.recipients.includes(agentId) && !m.readBy.includes(agentId)); }
  // Secret agents send as the host (their control CLIs are indistinguishable
  // from the real human). The record keeps the real sender for routing; only
  // the display name changes, and the flag is hidden from non-host viewers.
  viewMessage(actor, m) {
    const out = { ...m };
    if (actor.role !== 'admin' && out.secret) { out.fromName = 'Human (host)'; delete out.secret; }
    return out;
  }
  remember(actor, body) {
    const text = str(body, 'Memory note', 2000);
    const entry = { id: id(), body: text, by: actor.name, at: new Date().toISOString() };
    this.data.memory.push(entry); this.data.memory = this.data.memory.slice(-500);
    this.activity(actor.id, 'remember', text.slice(0, 240));
    return entry;
  }
  forget(actor, memoryId) {
    const index = this.data.memory.findIndex(m => m.id === memoryId);
    fail(index >= 0, 'Memory not found.', 404);
    this.data.memory.splice(index, 1); this.save();
  }
  artifact(actor, input) {
    fail(['file', 'dir', 'service', 'port'].includes(input.kind), 'Choose file, dir, service, or port.');
    const ref = input.kind === 'port' ? Number(input.ref) : str(input.ref, 'Artifact reference', 500);
    if (input.kind === 'port') fail(Number.isInteger(ref) && ref > 0 && ref < 65536, 'Port must be a number from 1 to 65535.');
    const entry = { id: id(), kind: input.kind, ref, note: typeof input.note === 'string' ? input.note.slice(0, 500) : '', by: actor.name, byId: actor.id, at: new Date().toISOString() };
    this.data.artifacts.push(entry); this.data.artifacts = this.data.artifacts.slice(-1000);
    this.activity(actor.id, 'artifact', `${input.kind}: ${ref}`);
    return entry;  }
  addProxyService(actor, input) {
    fail(actor.role === 'admin', 'Only the host can manage proxy services.', 403);
    const service = { id: id(), name: str(input.name, 'Service name', 80), host: str(input.host, 'Service host', 200), header: str(input.header || 'Authorization', 'Header name', 120), value: str(input.value, 'Credential value', 4000), at: new Date().toISOString() };
    fail(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(service.header), 'Header name must be a valid HTTP token.');
    this.data.proxyServices.push(service); this.data.proxyServices = this.data.proxyServices.slice(-100);
    this.activity(actor.id, 'proxy', `Added credential service ${service.name} for ${service.host}`); this.save();
    return { ...service, value: undefined, masked: true };
  }
  removeProxyService(actor, serviceId) {
    fail(actor.role === 'admin', 'Only the host can manage proxy services.', 403);
    const index = this.data.proxyServices.findIndex(s => s.id === serviceId);
    fail(index >= 0, 'Proxy service not found.', 404);
    this.data.proxyServices.splice(index, 1);
    this.activity(actor.id, 'proxy', 'Removed a credential service'); this.save();
  }
  proxyServiceFor(agent, hostname) {
    const a = this.data.agents.find(x => x.id === agent.id);
    if (!a?.proxy) return null;
    return this.data.proxyServices.find(s => s.host === hostname) || null;
  }  send(actor, input) {
    const type = input.type === 'notice' ? 'notice' : input.type === 'question' ? 'question' : 'message';
    fail(input.type === undefined || ['message', 'notice', 'question'].includes(input.type), 'Choose message, notice, or question.');
    const body = str(input.body, 'Message', 20000);
    let recipients;
    if (input.groupId) {
      fail(type === 'notice', 'Group chats only accept notices.');
      const g = this.data.groups.find(g => g.id === input.groupId);
      fail(g, 'Group not found.', 404);
      fail(actor.role !== 'agent' || !g.members.length || g.members.includes(actor.id), 'You are not a member of this group.', 403);
      recipients = this.data.agents.filter(a => (!g.members.length || g.members.includes(a.id)) && a.id !== actor.id).map(a => a.id);
    } else {
      fail(this.data.agents.some(a => a.id === input.to) || input.to === 'human' || this.data.devices.some(d => d.id === input.to), 'Recipient not found.', 404);
      fail(input.to !== actor.id, 'Choose another participant.');
      recipients = [input.to];
    }
    let councilId = null;
    if (input.replyTo) {
      const original = this.data.messages.find(m => m.id === input.replyTo);
      fail(original && original.recipients.includes(actor.id), 'You can only reply to messages addressed to you.');
      if (original.secret && recipients.includes('human') && !recipients.includes(original.from)) recipients.push(original.from);
      fail(recipients.includes(original.from), 'A reply must go to the original sender.');
      councilId = original.councilId;
    }
    if (!input.groupId && !councilId) councilId = this.data.messages.findLast(m => m.councilId && m.to === actor.id && recipients.includes(m.from) && !m.answeredAt)?.councilId || null;
    const message = { id: id(), from: actor.id, fromName: actor.name, to: input.to || null, groupId: input.groupId || null,
      type, body, recipients, readBy: [], answeredAt: null, replyTo: input.replyTo || null, councilId: input.councilId || councilId, at: new Date().toISOString() };
    if (actor.role === 'agent' && this.data.agents.find(a => a.id === actor.id)?.role === 'secret') { message.fromName = 'Human (host)'; message.secret = true; }
    if (!input.groupId) for (const m of this.data.messages) {
      if ((m.type === 'message' || m.type === 'question') && !m.answeredAt && m.recipients.includes(actor.id) && recipients.includes(m.from) && !m.groupId) m.answeredAt = message.at;
    }
    this.data.messages.push(message);
    this.activity(actor.id, input.groupId ? 'group_notice' : type, body.slice(0, 240));
    this.save(); return message;
  }
  tool(actor, name, input = {}) {
    fail(tools.includes(name), 'Unknown tool.', 404);
    fail(this.data.settings[name], `The host has disabled ${name}.`, 403);
    let result;
    if (name === 'agents') result = this.snapshot(actor).agents.filter(a => a.id === actor.id || actor.role === 'admin' || a.role !== 'secret');
    else if (name === 'rooms') result = this.data.groups.filter(g => actor.role !== 'agent' || !g.members.length || g.members.includes(actor.id));
    else if (name === 'room_history') {
      const g = this.data.groups.find(g => g.id === (input.groupId || 'team'));
      fail(g, 'Group not found.', 404);
      fail(actor.role !== 'agent' || !g.members.length || g.members.includes(actor.id), 'You are not a member of this group.', 403);
      const limit = input.limit ?? 30;
      fail(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'History limit must be between 1 and 100.');
      result = this.data.messages.filter(m => m.groupId === g.id).slice(-limit).map(m => this.viewMessage(actor, m));
    }
    else if (name === 'assign') {
      const self = this.data.agents.find(a => a.id === actor.id);
      fail(actor.role === 'agent' && self?.role === 'arbiter', 'Only the arbiter can assign tasks to other agents.', 403);
      const target = this.data.agents.find(a => a.id === input.to);
      fail(target, 'Agent not found.', 404);
      fail(target.id !== actor.id, 'Use the task tool for your own task.');
      target.task = str(input.task, 'Task', 2000);
      this.activity(actor.id, 'assign', `${self.name} assigned ${target.name}: ${target.task}`);
      result = { assigned: target.id, task: target.task };
        } else if (name === 'remember') result = this.remember(actor, input.body);
    else if (name === 'memory') result = this.data.memory;
    else if (name === 'artifact') result = this.artifact(actor, input);
    else if (name === 'artifacts') result = this.data.artifacts;
    else if (name === 'task') {      const a = this.data.agents.find(a => a.id === (actor.role === 'agent' ? actor.id : input.agentId));
      fail(a, 'Agent not found.', 404); fail(actor.role === 'agent' || this.canControl(actor, a), 'Not allowed.', 403);
      a.task = typeof input.task === 'string' ? input.task.slice(0, 2000) : ''; result = { task: a.task };
      this.activity(actor.id, name, a.task || 'Task cleared');
    } else if (['message', 'notice', 'group_notice', 'question'].includes(name)) result = this.send(actor, { ...input, type: { message: 'message', notice: 'notice', group_notice: 'notice', question: 'question' }[name], groupId: name === 'group_notice' ? input.groupId || 'team' : undefined });
    else if (name === 'pin') {
      const body = str(input.body, 'Pinned note', 2000);
      this.data.pinned.push({ id: id(), body, by: actor.id, byName: actor.name, at: new Date().toISOString() });
      this.data.pinned = this.data.pinned.slice(-50);
      this.activity(actor.id, 'pin', body.slice(0, 240));
      result = this.data.pinned;
    } else if (name === 'unpin') {
      fail(typeof input.pinId === 'string' && input.pinId, 'Provide the pinId to remove.');
      const index = this.data.pinned.findIndex(p => p.id === input.pinId);
      fail(index >= 0, 'Pinned note not found.', 404);
      const [removed] = this.data.pinned.splice(index, 1);
      this.activity(actor.id, 'unpin', removed.body.slice(0, 240));
      result = this.data.pinned;
    } else if (name === 'pins') result = this.data.pinned;
    else if (name === 'inbox') {
      result = this.unread(actor.id).map(m => this.viewMessage(actor, m));
      if (input.markRead !== false) for (const m of result) m.readBy.push(actor.id);
    } else if (name === 'situation') {
      const visible = this.data.agents.filter(a => a.id === actor.id || actor.role === 'admin' || a.role !== 'secret');
      result = {
        agents: visible.map(a => ({ name: a.name, role: a.role, status: a.status, task: a.task || null })),
        unanswered: this.data.messages.filter(m => m.type === 'message' && !m.answeredAt).map(m => this.viewMessage(actor, m)),
        teamRoom: this.data.messages.filter(m => m.groupId === 'team').slice(-20).map(m => this.viewMessage(actor, m)),
        recentActivity: this.data.activity.slice(-30),
      };
    } else if (name === 'council') {
      const question = str(input.question, 'Council question', 20000);
      fail(input.agentIds === undefined || Array.isArray(input.agentIds) && input.agentIds.every(v => this.data.agents.some(a => a.id === v)), 'Choose valid council participants.');
      const participants = this.data.agents.filter(a => a.id !== actor.id && (!input.agentIds?.length || input.agentIds.includes(a.id)));
      fail(participants.length, 'Launch another agent before starting a council.');
      const c = { id: id(), question, from: actor.id, participants: participants.map(a => a.id), at: new Date().toISOString() };
      this.data.councils.push(c);
      for (const a of participants) this.send(actor, { to: a.id, type: 'message', body: `[Council] ${question}\nReply to ${actor.id} with your recommendation.`, councilId: c.id });
      result = c;
    } else if (name === 'room_update') {
      const groupId = str(input.groupId, 'Room ID', 100);
      result = this.updateGroup(actor, groupId, { name: input.name, add: input.add, remove: input.remove });
    } else if (name === 'activity') {
      this.activity(actor.id, str(input.tool, 'Tool name', 120), str(input.detail, 'Detail', 4000), input.success !== false); result = { recorded: true };
    } else fail(false, 'Sync must be dispatched to a device.');
    this.save();
    // Every agent tool response carries new messages into its model context,
    // and pinned notes stay in effect for the whole session.
    const inbox = actor.role === 'agent' && !['inbox', 'room_history', 'situation'].includes(name) && this.data.settings.inbox ? this.unread(actor.id).map(m => this.viewMessage(actor, m)) : [];    for (const m of inbox) m.readBy.push(actor.id);
    const pinned = actor.role === 'agent' && this.data.settings.pins ? this.data.pinned : [];
    this.save(); return { result, inbox, pinned };
  }
}
