import { fail, str } from './store.js';

// A2A (agent-to-agent) 1.0, JSON-RPC 2.0 binding (glow-up spec §11).
// The host serves one AgentCard per agent and speaks the standard binding on
// POST /a2a. The credential is the agent's own relaydeck key (bearer), so an
// A2A client is authenticated to exactly the agent on the card.

export const a2aProtocolVersion = '1.0';
export const a2aTerminalStates = ['completed', 'canceled', 'failed', 'rejected'];

export function agentCard(agent, base) {
  const device = agent.deviceName || 'a relaydeck device';
  return {
    protocolVersion: a2aProtocolVersion,
    name: agent.name,
    description: `Relaydeck agent "${agent.name}" (${agent.harness}, running on ${device}). Send it a task or question; it works in its own terminal and replies when it is done, asking back if it needs input.`,
    url: `${base}/a2a`,
    version: '1.0.0',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
    skills: [{
      id: 'relay-message', name: 'Relay message',
      description: 'Deliver a task or question to the agent. The reply arrives as the task result (completed), or the task moves to input-required when the agent needs something from you.',
      tags: ['relaydeck', 'agent-chat', 'task-relay'],
      examples: ['Summarize the current state of this repository.', 'Review the API design in docs/ and report the risks.'],
      inputModes: ['text'], outputModes: ['text'],
    }],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'This agent\'s relaydeck key (the one from its Connect tools panel).' } },
    security: [{ bearerAuth: [] }],
  };
}

export function rpcError(code, message) { return Object.assign(new Error(message), { code }); }
const jsonRpc = (res, id, result) => { res.setHeader('Content-Type', 'application/json'); res.json({ jsonrpc: '2.0', id, result }); };
const failRpc = (res, id, error) => { res.status(400).json({ jsonrpc: '2.0', id, error: { code: error.code ?? -32603, message: error.message } }); };

function textOf(message) {
  fail(message && typeof message === 'object', 'message is required.');
  fail(['user', 'agent'].includes(message.role), 'message.role must be "user" or "agent".');
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts.filter(p => p?.kind === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  fail(text.trim().length > 0 && text.length <= 20000, 'The message needs at least one text part (up to 20,000 characters).');
  return text;
}

// ctx: { store, base, streams, webhook } — streams maps taskId -> Set<res>,
// webhook(task) fires the configured push-notification POSTs.
export function a2aHandle(ctx, req, res) {
  const store = ctx.store, actor = req.actor;
  const body = req.body;
  const id = body?.id ?? null;
  try {
    fail(body && body.jsonrpc === '2.0', 'Invalid Request: jsonrpc "2.0" is required.');
    const method = body.method;
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    const agent = store.data.agents.find(a => a.id === actor.id);
    if (!['SendMessage', 'SendStreamingMessage', 'GetTask', 'ListTasks', 'CancelTask',
      'SetTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig',
      // 0.3-era spellings, accepted for older clients:
      'SetTaskPushNotificationConfiguration', 'GetTaskPushNotificationConfiguration', 'ListTaskPushNotificationConfigurations', 'DeleteTaskPushNotificationConfiguration',
    ].includes(method)) throw rpcError(-32601, `Method not found: ${method}`);

    const result = method === 'SendMessage' || method === 'SendStreamingMessage' ? send(ctx, store, agent, params, method)
      : method === 'GetTask' ? getTask(store, agent, params)
      : method === 'ListTasks' ? listTasks(store, agent, params)
      : method === 'CancelTask' ? cancelTask(ctx, store, agent, params)
      : method.startsWith('SetTaskPushNotification') ? store.a2aSetPush(agent.id, params)
      : method.startsWith('GetTaskPushNotification') ? getPush(store, agent, params)
      : method.startsWith('ListTaskPushNotification') ? store.a2aPushConfigs(agent.id)
      : deletePush(store, agent, params);

    if (method === 'SendStreamingMessage') {
      res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
      const event = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
      event({ kind: 'task', ...result });
      const set = new Set(); ctx.streams.set(result.id, set); set.add(res);
      const close = () => { set.delete(res); if (!set.size) ctx.streams.delete(result.id); };
      req.on('close', close);
      const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': alive\n\n'); }, 15000);
      res.on('close', () => { clearInterval(heartbeat); close(); });
      res.on('finish', () => { clearInterval(heartbeat); close(); });
      // End the stream when the task reaches a terminal state.
      const check = setInterval(() => {
        if (a2aTerminalStates.includes(store.a2aTask(result.id)?.status)) {
          event({ kind: 'task', ...store.a2aTask(result.id) }); res.end(); clearInterval(check); clearInterval(heartbeat); close();
        }
      }, 1000);
      setTimeout(() => { clearInterval(check); if (!res.writableEnded) res.end(); clearInterval(heartbeat); close(); }, 5 * 60000).unref?.();
      return;
    }
    jsonRpc(res, id, result);
  } catch (error) { failRpc(res, id, { code: error.status === 404 ? -32001 : (error.code ?? -32603), message: error.message }); }
}

function send(ctx, store, agent, params, method) {
  const text = textOf(params.message);
  const taskId = params.message?.taskId || params.configuredTaskId || null;
  let task;
  if (taskId) {
    task = store.a2aTask(taskId);
    fail(task && task.agentId === agent.id, 'Task not found.', 404);
    fail(['working', 'input-required'].includes(task.status), 'This task has already ended.', 409);
  }
  if (!task) {
    task = store.a2aCreateTask(agent, text);
  } else {
    const now = new Date().toISOString();
    task.messages.push({ kind: 'message', role: 'user', messageId: params.message?.messageId || `${task.id}-msg-${task.messages.length}`, parts: [{ kind: 'text', text }] });
    if (task.status !== 'working') task.history.push({ state: 'working', at: now });
    task.status = 'working'; task.updatedAt = now;
    store.save();
  }
  store.a2aInbound(agent, text, task.id);
  ctx.webhook?.(task);
  if (method === 'SendStreamingMessage') return { ...task };
  return task;
}

function getTask(store, agent, params) {
  const task = store.a2aTask(str(params.id, 'Task ID', 100));
  fail(task && task.agentId === agent.id, 'Task not found.', 404);
  return task;
}

function listTasks(store, agent, params) {
  const limit = params.limit ?? 20;
  fail(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Limit must be between 1 and 100.');
  return store.data.a2a.tasks.filter(t => t.agentId === agent.id).slice(0, limit);
}

function cancelTask(ctx, store, agent, params) {
  const task = store.a2aTask(str(params.id, 'Task ID', 100));
  fail(task && task.agentId === agent.id, 'Task not found.', 404);
  fail(['working', 'input-required'].includes(task.status), 'This task has already ended.', 409);
  const next = store.a2aTransition(task, 'canceled', undefined);
  ctx.webhook?.(next);
  return next;
}

function getPush(store, agent, params) {
  const config = store.a2aPushConfigs(agent.id).find(c => c.id === params.id);
  fail(config, 'Push config not found.', 404);
  return config;
}

function deletePush(store, agent, params) {
  return store.a2aDeletePush(agent.id, str(params.id, 'Push config ID', 100));
}

// Push-notification configs: POST the full task to each webhook when a state
// transition happens (spec §11: "yo, you have mail" relay).
export function a2aWebhook(store, task) {
  for (const config of store.a2aPushConfigs(task.agentId)) {
    fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.token ? { Authorization: 'Bearer ' + config.token } : {}) },
      body: JSON.stringify({ kind: 'task', ...task }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => {});
  }
}
