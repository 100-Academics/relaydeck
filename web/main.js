import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { createIcons, Activity, ArrowUpRight, Bell, Check, ChevronDown, CircleHelp, Command, Copy, GitBranch, Globe, Laptop, LogOut, MessageSquare, Monitor, MoreHorizontal, Network, Plus, Radio, Send, Settings2, ShieldCheck, Square, TerminalSquare, Users, Sun, Moon, X } from 'lucide';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import './dark.css';

const icons = { Activity, ArrowUpRight, Bell, Check, ChevronDown, CircleHelp, Command, Copy, GitBranch, Globe, Laptop, LogOut, MessageSquare, Monitor, MoreHorizontal, Network, Plus, Radio, Send, Settings2, ShieldCheck, Square, TerminalSquare, Users, Sun, Moon, X };
const app = document.querySelector('#app'), dialog = document.querySelector('#dialog');
let state, page = 'workspace', selected, channel = 'team', ws, terminal, fit, resizeObserver, retry, loggedOut = false;
let connected = false, modalCleanup;
const drafts = {};
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const button = (action, text, name = '', cls = '') => `<button class="${cls}" data-action="${action}"${text ? '' : ` aria-label="${e(({ launch: 'New agent', group: 'Create room', logout: 'Sign out' })[action] || action)}"`}>${name ? icon(name) : ''}${text}</button>`;
const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const agent = () => state?.agents.find(a => a.id === selected);
const device = id => state?.devices.find(d => d.id === id);
const name = id => id === 'human' ? 'Host' : state.agents.find(a => a.id === id)?.name || device(id)?.name || 'Agent';
const controlled = a => state.viewer.role === 'admin' || a?.deviceId === state.viewer.id;
const lifecycleButton = a => !controlled(a) ? '' : a.status === 'running' ? `<button data-action="stop" class="icon-button stop-button" aria-label="Stop agent">${icon('square')}</button>` : ['stopped', 'error'].includes(a.status) ? button('restart', 'Restart', '', 'small-button') : '';
const agentActions = a => `${status(a)}${controlled(a) ? `${button('startup', 'Startup', 'settings-2', 'small-button')}${button('skill', 'Agent skill', 'message-square', 'small-button')}${button('bridge', 'Connect tools', 'command', 'small-button')}` : ''}${lifecycleButton(a)}`;
const status = a => `<span class="status ${e(a.status)}"><span></span>${e(a.status)}</span>`;
function paintIcons() { createIcons({ icons, attrs: { 'stroke-width': 1.7 } }); }
function toast(message, error = false) { const el = document.createElement('div'); document.querySelector('#toasts').replaceChildren(); el.className = `toast ${error ? 'error' : ''}`; el.textContent = message; document.querySelector('#toasts').append(el); setTimeout(() => el.remove(), 6000); }
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; } } catch {}
  // Remote HTTP workspaces (including Tailscale IPs) lack the Clipboard API.
  const field = document.createElement('textarea'); field.value = text; field.style.cssText = 'position:fixed;left:-9999px;top:0';
  (dialog.open ? dialog : document.body).append(field); field.select();
  const copied = document.execCommand('copy'); field.remove();
  if (!copied) throw new Error('Select the displayed text and copy it manually.');
}
async function api(route, body, method) {
  const res = await fetch(`/api${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Request failed.'); return data;
}
async function tool(name, input) { return api(`/tools/${name}`, input); }
function modal(title, body, onSubmit) {
  modalCleanup?.(); dialog.innerHTML = `<form id="modal-form"><div class="dialog-heading"><h2>${e(title)}</h2><button type="button" class="icon-button" data-action="close" aria-label="Close dialog">${icon('x')}</button></div>${body}<p id="modal-error" class="form-error" role="alert"></p></form>`;
  const form = dialog.querySelector('form'); form.onsubmit = async event => {
    event.preventDefault(); const submit = form.querySelector('[type=submit]'); if (submit) submit.disabled = true;
    try { await onSubmit?.(new FormData(form)); } catch (error) { dialog.querySelector('#modal-error').textContent = error.message; }
    finally { if (submit) submit.disabled = false; }
  }; paintIcons(); if (!dialog.open) dialog.showModal();
}
const field = (label, content, hint = '') => `<label class="field"><span>${label}</span>${content.includes('aria-label=') ? content : content.replace(/<(input|select|textarea)/, `<$1 aria-label="${e(label)}"`)}${hint ? `<small>${hint}</small>` : ''}</label>`;
function themeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return `<button class="theme-toggle" data-action="theme" aria-label="Switch to ${dark ? 'light' : 'dark'} mode" title="Switch to ${dark ? 'light' : 'dark'} mode">${icon(dark ? 'sun' : 'moon')}</button>`;
}
function refreshThemeButtons() {
  document.querySelectorAll('[data-action=theme]').forEach(el => { el.outerHTML = themeButton(); });
  if (terminal) terminal.options.theme = { ...terminal.options.theme, background: document.documentElement.dataset.theme === 'dark' ? '#0c131e' : '#182536' };
  paintIcons();
}
window.addEventListener('relaydeck-theme-change', refreshThemeButtons);
function login() {
  app.innerHTML = `<div class="login-theme">${themeButton()}</div><main class="login"><div class="login-art"><img src="/relaydeck.svg" alt=""/><h1>A place for<br>your agents<br>to work together.</h1><p>Any harness. Every device.<br>One shared workspace.</p><div class="login-diagram"><span>${icon('terminal-square')} Hermes</span><b>+</b><span>${icon('terminal-square')} OpenCode</span><b>+</b><span>${icon('laptop')} Your tools</span></div></div><section class="login-form"><div class="brand"><img src="/relaydeck.svg" alt=""/>relaydeck</div><h2>Join your workspace</h2><p>Use your host key or the device key provided by your host.</p><form id="login-form">${field('Access key', '<input name="token" type="password" required autocomplete="current-password" placeholder="Paste your access key"/>')}<button class="primary" type="submit">Open workspace ${icon('arrow-up-right')}</button><p class="form-error" id="login-error" role="alert"></p></form><p class="quiet">The host key appears in the host terminal.<br>Client keys are created in Devices.</p></section></main>`;
  paintIcons(); document.querySelector('#login-form').onsubmit = async ev => { ev.preventDefault(); try { await api('/login', Object.fromEntries(new FormData(ev.target))); loggedOut = false; await boot(); } catch (err) { document.querySelector('#login-error').textContent = err.message; } };
}
function skeleton() {
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="/" aria-label="Relaydeck home"><img src="/relaydeck.svg" alt=""/>relaydeck<span>shell</span></a><div class="workspace-label">${icon('network')} Shared workspace</div><nav aria-label="Main navigation">${[['workspace', 'Workspace', 'terminal-square'], ['councils', 'Councils', 'users'], ['devices', 'Devices', 'monitor'], ['sync', 'Repository sync', 'git-branch'], ['settings', 'Tool controls', 'settings-2']].map(([id, label, i]) => `<button data-page="${id}">${icon(i)}${label}<span id="nav-${id}"></span></button>`).join('')}</nav><div class="rail-heading">Agents ${button('launch', '', 'plus', 'icon-button')}</div><div id="roster" class="roster"></div><div class="sidebar-bottom"><div class="role-icon">${icon('shield-check')}</div><div><strong>${state.viewer.role === 'admin' ? 'Host workspace' : 'Client workspace'}</strong><small>${e(state.viewer.name)}</small></div>${button('logout', '', 'log-out', 'icon-button')}</div></aside><main class="main"><header class="topbar"><div class="breadcrumbs">Workspace <span>/</span> <strong id="breadcrumb">Overview</strong></div><div class="topbar-tools"><div id="connection" class="connection"></div>${themeButton()}</div></header><div id="content"></div><footer><span>Relaydeck <span class="footer-dot">•</span> Your harnesses, connected.</span>${button('help', 'Connection guide', 'circle-help', 'text-button')}</footer></main></div>`;
  render();
}
function roster() {
  document.querySelector('#roster').innerHTML = state.agents.length ? state.agents.map((a, i) => `<button class="roster-item ${a.id === selected ? 'selected' : ''}" data-agent="${a.id}"><span class="avatar color-${i % 4}">${e(a.name.slice(0, 2).toUpperCase())}<b class="dot ${e(a.status)}"></b></span><span><strong>${e(a.name)}</strong><small>${e(a.harness)} <span>on ${e(device(a.deviceId)?.name)}</span></small></span></button>`).join('') : `<div class="rail-empty">No agents yet.<br>Launch a harness to begin.</div>`;
  document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  document.querySelector('#nav-councils').textContent = state.councils.length || '';
  document.querySelector('#connection').innerHTML = `<span class="dot ${connected ? 'running' : ''}"></span>${connected ? 'Workspace connected' : 'Reconnecting…'}`;
}
function header(title, subtitle, action = '') { return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`; }
function teamStrip() {
  const running = state.agents.filter(a => a.status === 'running').length, online = state.devices.filter(d => d.online).length;
  const unanswered = state.messages.filter(m => m.type === 'message' && !m.answeredAt).length;
  return `<div class="team-strip"><div class="team-mark">${icon('network')}</div><div><strong>Your team, in sync.</strong><span>Harnesses run on their devices. The conversation lives here.</span></div><div class="team-numbers"><span><b>${running}</b> running</span><span><b>${online}</b> ${online === 1 ? 'device' : 'devices'}</span><span><b>${unanswered}</b> unanswered</span></div></div>`;
}
function agentPicker() { return `<div class="mobile-agent-switch"><label for="agent-picker">Agent terminal</label><select id="agent-picker">${state.agents.map(a => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${e(a.name)} · ${e(a.harness)}</option>`).join('')}</select></div>`; }
function workspace() {
  const a = agent();
  return `${header('Agent workspace', 'A shared place for independent minds.', button('launch', 'Launch agent', 'plus', 'primary'))}<div id="team-strip">${teamStrip()}</div>${state.agents.length ? agentPicker() : ''}<div class="work-grid"><section class="terminal-panel"><div class="panel-top"><div>${icon('terminal-square')}<strong id="terminal-name">${a ? e(a.name) : 'Your next agent starts here'}</strong></div><div id="terminal-actions">${a ? `${agentActions(a)}` : '<span class="muted">Ready when you are</span>'}</div></div><div id="terminal-meta" class="terminal-meta">${a ? `${e(a.harness)}<span>${e(device(a.deviceId)?.name)}</span><span title="${e(a.cwd)}">${e(a.cwd)}</span>` : 'Hermes, OpenCode, Claude Code, or any terminal harness.'}</div><div class="terminal-body" id="terminal-body">${a ? '<div id="terminal"></div>' : `<div class="terminal-empty"><div class="orbit"><span>${icon('terminal-square')}</span><b></b><i></i></div><h2>Bring your own intelligence.</h2><p>Run the harness you already use.<br>Give it a team to talk to.</p>${button('launch', 'Launch your first agent', 'plus', 'terminal-cta')}<small>Real terminals. Local processes. Shared context.</small></div>`}</div><div class="task-bar">${icon('activity')}<div id="task-text">${e(a?.task || 'No task announced')}</div>${a ? button('task', 'Set task', '', 'text-button') : ''}</div><div id="process-error" class="process-error">${e(a?.error || '')}</div></section><section class="conversation"><div class="panel-top"><div>${icon('message-square')}<strong>Conversation</strong></div>${button('group', '', 'plus', 'icon-button')}</div><div class="channel-picker"><select id="channel" aria-label="Conversation">${channelOptions()}</select><span>${icon('chevron-down')}</span></div><div id="messages" class="messages" aria-live="polite"></div><form id="compose" class="composer"><textarea name="body" aria-label="Message" placeholder="Share an update with the team…" rows="3" maxlength="20000" required></textarea><div><select name="kind" aria-label="Message type"><option value="notice">Notice</option><option value="message">Message · reply requested</option></select><button type="submit" class="send-button" aria-label="Send">${icon('send')}</button></div><small id="compose-hint">Notices keep everyone in the loop. No reply needed.</small></form></section></div><section class="activity-section"><div class="section-title"><h2>Recent activity</h2><span>Live across your workspace</span></div><div id="activity"></div></section>`;
}
function channelOptions() { return `<optgroup label="Group rooms">${state.groups.map(g => `<option value="${g.id}" ${channel === g.id ? 'selected' : ''}># ${e(g.name)}</option>`).join('')}</optgroup><optgroup label="Direct messages"><option value="human" ${channel === 'human' ? 'selected' : ''}>Host inbox</option>${state.agents.map(a => `<option value="${a.id}" ${channel === a.id ? 'selected' : ''}>${e(a.name)}</option>`).join('')}${state.devices.filter(d => d.id !== state.viewer.id).map(d => `<option value="${d.id}" ${channel === d.id ? 'selected' : ''}>${e(d.name)} operator</option>`).join('')}</optgroup>`; }
function messages() {
  const box = document.querySelector('#messages'); if (!box) return;
  const group = state.groups.some(g => g.id === channel);
  const items = state.messages.filter(m => group ? m.groupId === channel : !m.groupId && (m.from === channel || m.to === channel));
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = items.length ? items.map(m => `<article class="message ${m.from === state.viewer.id ? 'own' : ''}"><div class="message-heading"><span class="mini-avatar">${e(m.fromName.slice(0, 1))}</span><strong>${e(m.fromName)}</strong><time>${time(m.at)}</time></div><p>${e(m.body)}</p><div class="message-meta">${m.groupId ? icon('radio') + 'Notice' : `${m.type === 'message' ? icon('message-square') : icon('bell')} To ${e(name(m.to))}`}${m.type === 'message' ? `<span class="answer-tag ${m.answeredAt ? 'answered' : ''}">${m.answeredAt ? 'Answered' : 'Unanswered'}</span>` : ''}${m.recipients.includes(state.viewer.id) && m.from !== state.viewer.id ? `<button class="text-button" data-reply="${m.id}">Reply</button>` : ''}</div></article>`).join('') : `<div class="conversation-empty">${icon('radio')}<h3>${group ? 'The room is open.' : 'Start a conversation.'}</h3><p>${group ? 'Send a notice to share progress, a discovery, or a change of plan.' : 'Messages request a reply. Notices simply share an update.'}</p></div>`;
  if (nearBottom || !box.dataset.rendered) box.scrollTop = box.scrollHeight; box.dataset.rendered = 'true';
  const kind = document.querySelector('[name=kind]'); kind.querySelector('[value=message]').disabled = group; if (group) kind.value = 'notice';
}
function activity() {
  const el = document.querySelector('#activity'); if (!el) return;
  el.innerHTML = state.activity.length ? state.activity.slice(-8).reverse().map(a => `<div class="activity-row">${icon(a.success ? 'activity' : 'circle-help')}<span><strong>${e(name(a.actor))}</strong><span class="activity-tool">${e(a.tool)}</span></span><p>${e(a.detail)}</p><time>${time(a.at)}</time></div>`).join('') : `<div class="activity-empty">Tool calls, launches, and team updates will appear here as your agents work.</div>`;
}
function devices() {
  return `${header('Connected devices', 'Give each machine its own seat at the table.', state.viewer.role === 'admin' ? button('pair', 'Connect device', 'plus', 'primary') : '')}<div class="info-banner">${icon('monitor')}<div><strong>A GUI when you want one. Headless when you don’t.</strong><p>Host and client runners work in the background. Add <code>--gui</code> to open their workspace in a browser.</p></div></div><div class="device-grid">${state.devices.map(d => `<article class="device-card"><div class="device-card-top"><span class="device-icon">${icon('laptop')}</span><span class="status ${d.online ? 'running' : 'stopped'}"><span></span>${d.online ? 'Connected' : 'Offline'}</span></div><h2>${e(d.name)}</h2><p>${e(d.hostname || 'Waiting for first connection')}</p><dl><dt>System</dt><dd>${e(d.platform || '—')}</dd><dt>Workspace</dt><dd title="${e(d.root)}">${e(d.root || 'Not connected yet')}</dd><dt>Agents</dt><dd>${state.agents.filter(a => a.deviceId === d.id && a.status === 'running').length} running</dd></dl>${d.online && (state.viewer.role === 'admin' || d.id === state.viewer.id) ? `<button class="secondary wide" data-launch-device="${d.id}">${icon('plus')} Launch here</button>` : ''}</article>`).join('')}</div>`;
}
function councils() {
  return `${header('Council room', 'Ask your team to think through a decision together.', button('council', 'Ask the council', 'users', 'primary'))}<div class="council-list">${state.councils.length ? state.councils.slice().reverse().map(c => {
    const requests = state.messages.filter(m => m.councilId === c.id && m.from === c.from);
    const replies = state.messages.filter(m => m.councilId === c.id && m.from !== c.from);
    return `<article class="council-card"><div class="council-heading"><span class="device-icon">${icon('users')}</span><span>${e(name(c.from))} asked the team</span><time>${time(c.at)}</time></div><h2>${e(c.question)}</h2><div class="participants">${c.participants.map(p => `<span>${icon(requests.find(m => m.to === p)?.answeredAt ? 'check' : 'message-square')}${e(name(p))}</span>`).join('')}</div><div class="council-replies">${replies.length ? replies.map(r => `<div><strong>${e(r.fromName)}</strong><p>${e(r.body)}</p></div>`).join('') : '<p>Waiting for recommendations. Responses appear here when agents reply to the council message.</p>'}</div></article>`;
  }).join('') : `<div class="large-empty">${icon('users')}<h2>More perspectives. Better decisions.</h2><p>Ask your agents how they would approach a problem.<br>Each receives a direct message requesting a recommendation.</p>${button('council', 'Start a council', 'plus', 'secondary')}</div>`}</div>`;
}
function syncPage() {
  const eligible = state.devices.filter(d => d.online && (state.viewer.role === 'admin' || d.id === state.viewer.id));
  return `${header('Repository sync', 'Keep devices aligned through Forgejo or Gitea.')}<div class="sync-layout"><section class="surface"><div class="section-title"><h2>${icon('git-branch')} Shared repository</h2><span>Forgejo / Gitea</span></div><form id="sync-form">${field('Device', `<select name="deviceId" required>${eligible.map(d => `<option value="${d.id}">${e(d.name)}</option>`).join('')}</select>`)}${field('Repository directory', `<input name="cwd" required value="${e(eligible[0]?.root || '')}"/>`, 'Use an existing Git checkout inside this device’s workspace.')}${field('Forgejo / Gitea repository URL', '<input name="url" type="url" placeholder="https://git.example.com/team/project.git"/>', 'Credentials come from the device’s Git credential helper.')}<div class="form-actions"><button name="action" value="configure" class="primary">Save remote</button><button name="action" value="status" class="secondary">Check status</button></div><div class="sync-buttons"><button name="action" value="pull" class="secondary">Pull changes</button><button name="action" value="push" class="secondary">Push commits</button></div></form><pre id="sync-result" class="sync-result" aria-live="polite">Select a checkout to inspect its sync status.</pre></section><aside class="sync-explainer">${icon('git-branch')}<h2>One project.<br>Every device.</h2><p>Each device has a local checkout. Relaydeck connects them through a Forgejo or Gitea remote named <code>relaydeck</code>.</p><p>Pulls fast-forward only. Pushes send committed changes. Local edits and merge conflicts stay visible for you to resolve.</p><p class="quiet">Directory paths can differ across devices. Pair the corresponding checkout on each machine.</p></aside></div>`;
}
const descriptions = { rooms: 'Discover available chat rooms.', room_history: 'Read recent conversation in a chat room.', agents: 'Discover agents, their harnesses, and current tasks.', task: 'Announce what an agent is working on.', message: 'Send direct messages that request a response.', notice: 'Send updates without requesting a response.', inbox: 'Receive messages through the harness tool bridge.', group_notice: 'Broadcast notices to a shared room.', council: 'Ask other agents for their recommendations.', activity: 'Report tool calls and progress to the workspace.', sync: 'Check, pull, and push through Forgejo or Gitea.' };
function settings() { return `${header('Tool controls', 'Decide which capabilities your team can use.')}<div class="info-banner">${icon('shield-check')}<div><strong>Enforced by the host</strong><p>Disabled tools are blocked for all agents and clients. Connected MCP bridges update their tool lists automatically.</p></div></div><div class="tool-list">${Object.entries(state.settings).map(([key, enabled]) => `<div class="tool-row"><span class="tool-icon">${icon(key === 'sync' ? 'git-branch' : key === 'council' ? 'users' : 'command')}</span><div><h3>${e(key.replaceAll('_', ' '))}</h3><p>${descriptions[key]}</p></div><label class="switch"><input type="checkbox" data-tool="${key}" ${enabled ? 'checked' : ''} ${state.viewer.role !== 'admin' ? 'disabled' : ''} aria-label="Enable ${key}"/><span></span></label></div>`).join('')}</div>${state.viewer.role !== 'admin' ? '<p class="quiet">Only the host can change tool availability.</p>' : ''}`; }
function teardownTerminal() { resizeObserver?.disconnect(); terminal?.dispose(); terminal = undefined; }
function render() {
  teardownTerminal(); roster(); document.querySelector('#breadcrumb').textContent = ({ workspace: 'Overview', councils: 'Councils', devices: 'Devices', sync: 'Repository sync', settings: 'Tool controls' })[page];
  document.querySelector('#content').innerHTML = ({ workspace, devices, councils, sync: syncPage, settings })[page]();
  if (page === 'workspace') {
    const picker = document.querySelector('#agent-picker'); if (picker) picker.onchange = ev => { selected = ev.target.value; render(); };
    messages(); activity(); const form = document.querySelector('#compose'); form.body.value = drafts[channel] || '';
    form.body.oninput = () => { drafts[channel] = form.body.value; };
    form.onsubmit = async ev => { ev.preventDefault(); const submit = form.querySelector('button'); submit.disabled = true; try {
      const group = state.groups.some(g => g.id === channel), kind = group ? 'group_notice' : form.kind.value;
      await tool(kind, { body: form.body.value, ...(group ? { groupId: channel } : { to: channel }) }); form.body.value = ''; drafts[channel] = ''; toast('Sent to the conversation.');
    } catch (err) { toast(err.message, true); } finally { submit.disabled = false; } };
    document.querySelector('#channel').onchange = ev => { channel = ev.target.value; form.body.value = drafts[channel] || ''; delete document.querySelector('#messages').dataset.rendered; messages(); paintIcons(); };
    form.kind.onchange = () => { document.querySelector('#compose-hint').textContent = form.kind.value === 'message' ? 'Stays unanswered until the recipient sends a message or notice back.' : 'Notices keep everyone in the loop. No reply needed.'; };
    if (agent()) mountTerminal();
  }
  if (page === 'sync') document.querySelector('#sync-form').onsubmit = async ev => {
    ev.preventDefault(); const out = document.querySelector('#sync-result'), data = Object.fromEntries(new FormData(ev.target)); data.action = ev.submitter.value; out.textContent = 'Working…';
    ev.target.querySelectorAll('button').forEach(b => b.disabled = true);
    try { const { result } = await tool('sync', data); out.textContent = `${result.output}${result.remote ? `\n\nRemote: ${result.remote}` : ''}`; } catch (err) { out.textContent = err.message; } finally { ev.target.querySelectorAll('button').forEach(b => b.disabled = false); }
  };
  if (page === 'sync') document.querySelector('[name=deviceId]').onchange = ev => { document.querySelector('[name=cwd]').value = device(ev.target.value)?.root || ''; };
  paintIcons();
}
function mountTerminal() {
  terminal = new Terminal({ cursorBlink: true, fontFamily: '"Cascadia Code", "Consolas", monospace', fontSize: 13, lineHeight: 1.25, theme: { background: document.documentElement.dataset.theme === 'dark' ? '#0c131e' : '#182536', foreground: '#dce5ef', cursor: '#9baeff', selectionBackground: '#3b527a' }, scrollback: 4000, disableStdin: !controlled(agent()) });
  fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(document.querySelector('#terminal')); terminal.onData(data => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'input', agentId: selected, data })));
  resizeObserver = new ResizeObserver(() => { try { fit.fit(); if (ws?.readyState === 1 && controlled(agent())) ws.send(JSON.stringify({ type: 'resize', agentId: selected, cols: terminal.cols, rows: terminal.rows })); } catch {} });
  resizeObserver.observe(document.querySelector('#terminal')); if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', agentId: selected }));
}
function update(next) {
  const previous = agent(); state = next;
  if (!document.querySelector('.shell')) { selected ||= state.agents[0]?.id; skeleton(); return; }
  roster();
  if (page === 'workspace') {
    if (!selected && state.agents.length) { selected = state.agents[0].id; render(); return; }
    document.querySelector('#team-strip').innerHTML = teamStrip();
    document.querySelector('#channel').innerHTML = channelOptions(); messages(); activity();
    const a = agent(); document.querySelector('#task-text').textContent = a?.task || 'No task announced'; document.querySelector('#process-error').textContent = a?.error || '';
    if (a && previous?.status !== a.status) document.querySelector('#terminal-actions').innerHTML = `${agentActions(a)}`;
  } else if (page !== 'sync') render();
  paintIcons();
}
function connect() {
  clearTimeout(retry); ws?.close(); const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); ws = socket;
  socket.onopen = () => { connected = true; if (state) roster(); if (selected && page === 'workspace') socket.send(JSON.stringify({ type: 'subscribe', agentId: selected })); };
  socket.onmessage = event => { const msg = JSON.parse(event.data); if (msg.type === 'state') update(msg.state); else if (msg.type === 'terminal' && msg.agentId === selected && terminal) { if (msg.reset) terminal.reset(); terminal.write(msg.data); } else if (msg.type === 'error') toast(msg.error, true); };
  socket.onclose = () => { if (ws !== socket) return; connected = false; if (state && document.querySelector('.shell')) roster(); if (!loggedOut) retry = setTimeout(async () => { try { await api('/state'); connect(); } catch { login(); } }, 2500); };
}
function startupFields(a = {}) {
  return `${field('Working directory', `<input name="cwd" value="${e(a.cwd || '')}" required ${a.status && !['stopped', 'error'].includes(a.status) ? 'readonly' : ''}/>`, 'Stop the agent before changing its directory.')}${field('Executable', `<input name="command" value="${e(a.command || 'hermes')}" required/>`, 'Program name or full path on the selected device. Put flags in Arguments.')}${field('Arguments (JSON array)', `<textarea name="args" rows="3" required spellcheck="false">${e(JSON.stringify(a.args || []))}</textarea>`, 'Example: ["--model", "your-model"]. Each item is one argument; paths with spaces stay in one item.')}${field('Room instructions', `<select name="onboarding"><option value="auto" ${a.onboarding !== 'manual' ? 'selected' : ''}>Automatic for supported harnesses</option><option value="manual" ${a.onboarding === 'manual' ? 'selected' : ''}>Manual — I will provide the agent skill</option></select>`, 'Hermes, OpenCode, Claude Code and Codex get startup guidance. Shell and Custom need the Agent skill copied into their context.')}${field('Additional startup instructions', `<textarea name="startupInstructions" rows="3" maxlength="12000" placeholder="e.g. Focus on the backend and share findings in the Team room.">${e(a.startupInstructions || '')}</textarea>`, 'Included with the room skill when the agent next starts. Codex automatic mode overrides developer_instructions for this run; choose Manual to keep a profile-managed value.')}${field('Message delivery', `<select name="delivery"><option value="inbox" ${a.delivery !== 'terminal' ? 'selected' : ''}>Tool inbox (MCP or CLI)</option><option value="terminal" ${a.delivery === 'terminal' ? 'selected' : ''}>Terminal input (prompt-ready harnesses)</option></select>`, 'Agents read the inbox while working. Terminal input submits messages immediately and requires a harness that safely queues prompts.')}`;
}
function startup() {
  const a = agent();
  const harnesses = [...new Set(['Hermes', 'OpenCode', 'Claude Code', 'Codex', 'Shell', 'Custom', a.harness])];
  modal('Agent startup settings', `<p class="dialog-intro">Command and instruction changes apply the next time this agent starts. Saving leaves the current process running.</p><div class="form-grid">${field('Agent name', `<input name="name" required maxlength="80" value="${e(a.name)}"/>`)}${field('Harness', `<select name="harness">${harnesses.map(h => `<option ${h === a.harness ? 'selected' : ''}>${e(h)}</option>`).join('')}</select>`)}</div>${startupFields(a)}<div class="form-actions"><button class="primary" type="submit">Save startup settings</button></div>`, async data => {
    const input = Object.fromEntries(data); input.args = JSON.parse(input.args);
    await api(`/agents/${a.id}`, input, 'PATCH'); dialog.close(); state = await api('/state');
    document.querySelector('#terminal-name').textContent = agent().name;
    toast('Startup settings saved. Stop and restart the agent to use the new command and instructions.');
  });
}
function launch(deviceId) {
  const devices = state.devices.filter(d => d.online && (state.viewer.role === 'admin' || d.id === state.viewer.id));
  if (!devices.length) return toast('Connect a device before launching an agent.', true);
  const d = devices.find(d => d.id === deviceId) || devices[0];
  modal('Launch an agent', `<p class="dialog-intro">Run a harness inside Relaydeck on a connected device.</p><div class="form-grid">${field('Agent name', '<input name="name" placeholder="e.g. Atlas" required maxlength="80"/>')}${field('Harness', '<select name="harness"><option>Hermes</option><option>OpenCode</option><option>Claude Code</option><option>Codex</option><option>Shell</option><option>Custom</option></select>')}</div>${field('Device', `<select name="deviceId">${devices.map(x => `<option value="${x.id}" ${d.id === x.id ? 'selected' : ''}>${e(x.name)}</option>`).join('')}</select>`)}${startupFields({ cwd: d.root })}<div class="form-actions"><button class="primary" type="submit">Launch agent</button></div>`, async data => {
    const input = Object.fromEntries(data); input.args = JSON.parse(input.args); const a = await api('/agents', input); selected = a.id; channel = a.id; page = 'workspace'; dialog.close(); state = await api('/state'); render(); toast(`${a.name} is starting.`);
  });
  dialog.querySelector('[name=harness]').onchange = ev => { dialog.querySelector('[name=command]').value = ({ Hermes: 'hermes', OpenCode: 'opencode', 'Claude Code': 'claude', Codex: 'codex', Shell: device(dialog.querySelector('[name=deviceId]').value)?.platform === 'win32' ? 'powershell.exe' : '/bin/bash', Custom: '' })[ev.target.value]; };
  dialog.querySelector('[name=deviceId]').onchange = ev => { dialog.querySelector('[name=cwd]').value = device(ev.target.value)?.root || ''; };
}
const actions = {
  startup,
  async skill() {
    const { instructions } = await api(`/agents/${selected}/instructions`);
    modal('Agent room skill', `<p class="dialog-intro">Supported harnesses receive this guidance on their next launch. For an agent already running, paste it into the harness conversation. Custom harnesses can read the file named by RELAYDECK_INSTRUCTIONS.</p><pre class="copy-block skill-preview" id="agent-skill">${e(instructions)}</pre>${button('copy-skill', 'Copy agent instructions', 'copy', 'secondary')}<div class="form-actions">${button('close', 'Done', '', 'primary')}</div>`);
  },
  async 'copy-skill'() { await copyText(document.querySelector('#agent-skill').textContent); toast('Agent instructions copied.'); },
  theme() { window.RelaydeckTheme.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); },
  launch: () => launch(), close: () => dialog.close(),
  async logout() { await api('/logout', {}); loggedOut = true; ws?.close(); teardownTerminal(); state = null; login(); },
  async stop() { await api(`/agents/${selected}/stop`, {}); toast('Stop requested.'); },
  async restart() { await api(`/agents/${selected}/restart`, {}); terminal?.reset(); toast('Agent is restarting.'); },
  task() { modal('Current task', `${field('What is this agent working on?', `<textarea name="task" rows="4" maxlength="2000">${e(agent()?.task)}</textarea>`)}<div class="form-actions"><button class="primary" type="submit">Save task</button></div>`, async data => { await tool('task', { agentId: selected, task: data.get('task') }); dialog.close(); }); },
  group() { modal('Create a group room', `${field('Room name', '<input name="name" required maxlength="80" placeholder="e.g. Interface team"/>')}<p class="quiet">Select members, or leave all unchecked to include every agent.</p><div class="check-list">${state.agents.map(a => `<label><input type="checkbox" name="members" value="${a.id}"/>${e(a.name)}</label>`).join('')}</div><div class="form-actions"><button class="primary" type="submit">Create room</button></div>`, async data => { const g = await api('/groups', { name: data.get('name'), members: data.getAll('members') }); channel = g.id; dialog.close(); state = await api('/state'); render(); }); },
  council() { modal('Ask the council', `<p class="dialog-intro">Every selected agent receives a message requesting a recommendation.</p>${field('What should the team think through?', '<textarea name="question" rows="5" required placeholder="How should we approach…"></textarea>')}<div class="check-list">${state.agents.map(a => `<label><input type="checkbox" name="agents" value="${a.id}" checked/>${e(a.name)} <small>${e(a.harness)}</small></label>`).join('')}</div><div class="form-actions"><button class="primary" type="submit">Ask the council</button></div>`, async data => { if (!data.getAll('agents').length) throw new Error('Choose at least one agent.'); await tool('council', { question: data.get('question'), agentIds: data.getAll('agents') }); dialog.close(); toast('Council requests sent.'); }); },
  pair() { modal('Connect a device', `<p class="dialog-intro">Create a separate key for each client. The key allows the client to control its own harnesses.</p>${field('Device name', '<input name="name" required placeholder="e.g. Studio laptop" maxlength="80"/>')}<div class="form-actions"><button class="primary" type="submit">Create device key</button></div>`, async data => {
    const d = await api('/devices', { name: data.get('name') });
    modal('Your device is ready to connect', `<p>On the client, install this project and run <code>npm ci</code>. Start its runner with the command below.</p><pre class="copy-block" id="pair-command">${e(`npm run runner -- --server ${location.origin} --token ${d.token} --root "/path/to/workspace" --gui`)}</pre>${button('copy-pair', 'Copy command', 'copy', 'secondary')}<p class="quiet">Use the host’s reachable address in place of localhost. Remove <code>--gui</code> for headless mode. Sign into the client GUI using this device key.</p>${field('Device key — save it now', `<input readonly value="${d.token}" aria-label="Device key"/>`)}<p class="quiet">Use a private network or HTTPS for connections between devices.</p><div class="form-actions">${button('close', 'Done', '', 'primary')}</div>`);
  }); },
  async 'copy-pair'() { await copyText(document.querySelector('#pair-command').textContent); toast('Command copied.'); },
  async bridge() {
    const { instructions, configurations } = await api(`/agents/${selected}/bridge`);
    modal('Connect the harness to its team', `<p>${e(instructions)}</p>${field('Configuration format', '<select id="bridge-format"><option value="generic">Standard MCP (Claude Code and others)</option><option value="hermes">Hermes (JSON is valid YAML)</option><option value="opencode">OpenCode v1</option><option value="opencode-v2">OpenCode v2</option></select>')}<pre class="copy-block" id="bridge-config"></pre>${button('copy-bridge', 'Copy configuration', 'copy', 'secondary')}<p id="bridge-location" class="quiet"></p><h3>Command-line bridge</h3><pre class="copy-block">node "$RELAYDECK_BRIDGE" --call inbox '{}'</pre><p class="quiet">In PowerShell, use <code>$env:RELAYDECK_BRIDGE</code>. Other harnesses can use the CLI bridge from their shell tool. Keep this agent key private.</p><div class="form-actions">${button('close', 'Done', '', 'primary')}</div>`);
    const format = dialog.querySelector('#bridge-format');
    format.value = agent().harness === 'Hermes' ? 'hermes' : agent().harness === 'OpenCode' ? 'opencode' : 'generic';
    const refresh = () => {
      dialog.querySelector('#bridge-config').textContent = JSON.stringify(configurations[format.value], null, 2);
      dialog.querySelector('#bridge-location').textContent = format.value === 'hermes' ? 'Merge mcp_servers.relaydeck into your Hermes config.yaml. JSON objects are also valid YAML. Preserve your existing configuration.' : format.value.startsWith('opencode') ? 'Merge the mcp entry into opencode.json. Select the format matching your installed OpenCode major version.' : 'Merge the mcpServers entry into your harness MCP configuration. For Codex, use the CLI bridge or translate this entry to mcp_servers.relaydeck in config.toml.';
    }; format.onchange = refresh; refresh();
  },
  async 'copy-bridge'() { await copyText(document.querySelector('#bridge-config').textContent); toast('Configuration copied.'); },
  help() { modal('How the workspace fits together', `<div class="guide-step">${icon('network')}<div><h3>One host coordinates the team</h3><p>It stores messages, task state, tool controls, and activity. Run it with or without a browser GUI.</p></div></div><div class="guide-step">${icon('laptop')}<div><h3>Each device runs its own harnesses</h3><p>Connect a client from Devices. Launch Hermes, OpenCode, or another installed executable in an embedded terminal.</p></div></div><div class="guide-step">${icon('message-square')}<div><h3>The bridge makes agents teammates</h3><p>Agents receive the room skill on startup for supported harnesses and can use the CLI bridge immediately. Agent skill shows the instructions; Connect tools optionally adds MCP. Messages arrive in tool results. A reply clears the unanswered tag; reading alone does not.</p></div></div><div class="form-actions">${button('close', 'Got it', '', 'primary')}</div>`); },
};
document.addEventListener('click', async event => {
  const action = event.target.closest('[data-action]'), nav = event.target.closest('[data-page]'), row = event.target.closest('[data-agent]'), launchDevice = event.target.closest('[data-launch-device]'), reply = event.target.closest('[data-reply]');
  try {
    if (action) { event.preventDefault(); await actions[action.dataset.action]?.(); }
    else if (nav) { page = nav.dataset.page; render(); }
    else if (row) { selected = row.dataset.agent; channel = selected; page = 'workspace'; render(); }
    else if (launchDevice) launch(launchDevice.dataset.launchDevice);
    else if (reply) { const original = state.messages.find(m => m.id === reply.dataset.reply); modal(`Reply to ${original.fromName}`, `${field('Your response', '<textarea name="body" rows="4" required></textarea>')}<div class="form-actions"><button class="primary" type="submit">Send reply</button></div>`, async data => { await tool('notice', { to: original.from, replyTo: original.id, body: data.get('body') }); dialog.close(); }); }
  } catch (err) { toast(err.message, true); }
});
document.addEventListener('change', async event => { if (event.target.matches('[data-tool]')) { try { await api('/settings', { [event.target.dataset.tool]: event.target.checked }, 'PATCH'); toast('Tool availability updated.'); } catch (err) { event.target.checked = !event.target.checked; toast(err.message, true); } } });
async function boot() {
  try {
    const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket'); if (ticket) { const clean = new URL(location.href); clean.hash = ''; clean.pathname = '/'; history.replaceState(null, '', clean.href); await api('/login', { ticket }); }
    state = await api('/state'); selected = state.agents.find(a => a.deviceId === new URLSearchParams(location.search).get('device'))?.id || state.agents[0]?.id; skeleton(); connect();
  } catch { login(); }
}
boot();
