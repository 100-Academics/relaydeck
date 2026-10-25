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
export const tools = ['agents', 'task', 'message', 'notice', 'inbox', 'group_notice', 'council', 'activity', 'sync'];
export function fail(condition, message, status = 400) { if (!condition) throw Object.assign(new Error(message), { status }); }
export function str(value, label, max = 10000) { fail(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label} is required (up to ${max} characters).`); return value.trim(); }

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'relaydeck.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    const row = this.db.prepare('SELECT data FROM workspace WHERE id=1').get();
    this.data = row ? JSON.parse(row.data) : {
      adminToken: secret(), devices: [], agents: [], groups: [{ id: 'team', name: 'Team room', members: [] }],
      messages: [], activity: [], councils: [], settings: Object.fromEntries(tools.map(t => [t, true])),
    };
    for (const d of this.data.devices) d.online = false;
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
      agents: this.data.agents.map(({ tokenHash, ...a }) => a),
      groups: this.data.groups, messages: this.data.messages, councils: this.data.councils,
      activity: this.data.activity.slice(-200), settings: this.data.settings,
    };
  }
  canControl(actor, agent) { return actor.role === 'admin' || (actor.role === 'device' && actor.id === agent.deviceId); }
  agentToken(agentId) { return createHmac('sha256', this.data.adminToken).update(`agent:${agentId}`).digest('hex'); }
  agent(actor, input) {
    const d = this.data.devices.find(d => d.id === input.deviceId);
    fail(d?.online, 'Choose a connected device.');
    fail(actor.role === 'admin' || actor.role === 'device' && actor.id === d.id, 'You can only launch agents on your own device.', 403);
    fail(Array.isArray(input.args) && input.args.length <= 100 && input.args.every(a => typeof a === 'string' && a.length < 10000), 'Arguments must be a JSON array of strings.');
    const agentId = id(), token = this.agentToken(agentId);
    const a = { id: agentId, name: str(input.name, 'Agent name', 80), harness: str(input.harness, 'Harness', 80),
      command: str(input.command, 'Command', 1024), args: input.args, cwd: str(input.cwd, 'Working directory', 2000),
      deviceId: d.id, delivery: input.delivery === 'terminal' ? 'terminal' : 'inbox', status: 'starting', task: '',
      tokenHash: hash(token), createdAt: new Date().toISOString() };
    this.data.agents.push(a); this.activity(actor.id, 'launch', `Started ${a.name} using ${a.harness}`); this.save();
    return { agent: a, token };
  }
  unread(agentId) { return this.data.messages.filter(m => m.recipients.includes(agentId) && !m.readBy.includes(agentId)); }
  send(actor, input) {
    const type = input.type === 'notice' ? 'notice' : 'message';
    fail(input.type === type, 'Choose message or notice.');
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
      fail(recipients.includes(original.from), 'A reply must go to the original sender.');
      councilId = original.councilId;
    }
    if (!input.groupId && !councilId) councilId = this.data.messages.findLast(m => m.councilId && m.to === actor.id && recipients.includes(m.from) && !m.answeredAt)?.councilId || null;
    const message = { id: id(), from: actor.id, fromName: actor.name, to: input.to || null, groupId: input.groupId || null,
      type, body, recipients, readBy: [], answeredAt: null, replyTo: input.replyTo || null, councilId: input.councilId || councilId, at: new Date().toISOString() };
    if (!input.groupId) for (const m of this.data.messages) {
      if (m.type === 'message' && !m.answeredAt && m.recipients.includes(actor.id) && recipients.includes(m.from) && !m.groupId) m.answeredAt = message.at;
    }
    this.data.messages.push(message);
    this.activity(actor.id, input.groupId ? 'group_notice' : type, body.slice(0, 240));
    this.save(); return message;
  }
  tool(actor, name, input = {}) {
    fail(tools.includes(name), 'Unknown tool.', 404);
    fail(this.data.settings[name], `The host has disabled ${name}.`, 403);
    let result;
    if (name === 'agents') result = this.snapshot(actor).agents;
    else if (name === 'task') {
      const a = this.data.agents.find(a => a.id === (actor.role === 'agent' ? actor.id : input.agentId));
      fail(a, 'Agent not found.', 404); fail(actor.role === 'agent' || this.canControl(actor, a), 'Not allowed.', 403);
      a.task = typeof input.task === 'string' ? input.task.slice(0, 2000) : ''; result = { task: a.task };
      this.activity(actor.id, name, a.task || 'Task cleared');
    } else if (['message', 'notice', 'group_notice'].includes(name)) result = this.send(actor, { ...input, type: name === 'message' ? 'message' : 'notice', groupId: name === 'group_notice' ? input.groupId || 'team' : undefined });
    else if (name === 'inbox') {
      result = [...this.unread(actor.id)];
      if (input.markRead !== false) for (const m of result) m.readBy.push(actor.id);
    } else if (name === 'council') {
      const question = str(input.question, 'Council question', 20000);
      fail(input.agentIds === undefined || Array.isArray(input.agentIds) && input.agentIds.every(v => this.data.agents.some(a => a.id === v)), 'Choose valid council participants.');
      const participants = this.data.agents.filter(a => a.id !== actor.id && (!input.agentIds?.length || input.agentIds.includes(a.id)));
      fail(participants.length, 'Launch another agent before starting a council.');
      const c = { id: id(), question, from: actor.id, participants: participants.map(a => a.id), at: new Date().toISOString() };
      this.data.councils.push(c);
      for (const a of participants) this.send(actor, { to: a.id, type: 'message', body: `[Council] ${question}\nReply to ${actor.id} with your recommendation.`, councilId: c.id });
      result = c;
    } else if (name === 'activity') {
      this.activity(actor.id, str(input.tool, 'Tool name', 120), str(input.detail, 'Detail', 4000), input.success !== false); result = { recorded: true };
    } else fail(false, 'Sync must be dispatched to a device.');
    this.save();
    // Every agent tool response carries new messages into its model context.
    const inbox = actor.role === 'agent' && name !== 'inbox' && this.data.settings.inbox ? [...this.unread(actor.id)] : [];
    for (const m of inbox) m.readBy.push(actor.id);
    this.save(); return { result, inbox };
  }
}
