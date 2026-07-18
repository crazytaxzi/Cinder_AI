const state = {
  csrf: sessionStorage.getItem('cinder_csrf') || '',
  overview: null,
  config: null,
  resources: { channels: [], roles: [] },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && state.csrf) headers.set('x-csrf-token', state.csrf);
  const response = await fetch(path, { credentials: 'same-origin', ...options, method, headers });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (response.status === 401) {
    sessionStorage.removeItem('cinder_csrf');
    location.href = '/login';
    throw new Error('Authentication required.');
  }
  if (!response.ok) {
    throw new Error(body?.error || body?.summary || `${method} ${path} failed with HTTP ${response.status}`);
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function json(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function when(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  el.style.borderColor = bad ? 'rgba(255,107,122,.6)' : 'rgba(141,255,106,.5)';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 4200);
}

function compactNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(Number(value || 0));
}

function money(value) {
  const amount = Number(value || 0);
  return amount < 0.01 ? `$${amount.toFixed(6)}` : `$${amount.toFixed(2)}`;
}

function renderUsage(usage) {
  if (!usage?.periods) return;
  const labels = [['today', 'Today'], ['sevenDays', '7 days'], ['thirtyDays', '30 days'], ['allTime', 'All recorded']];
  $('#usage-summary').innerHTML = labels.map(([key, label]) => {
    const period = usage.periods[key] || {};
    return `<div class="status-card"><span>${escapeHtml(label)}</span><strong>${money(period.estimatedCostUsd)}</strong></div>`;
  }).join('');
  const all = usage.periods.allTime || {};
  const modelRows = (usage.modelBreakdown || []).map((item) => [
    `${item.model} recorded`, `${compactNumber(item.requests)} requests · ${money(item.estimatedCostUsd)}`,
  ]);
  $('#usage-details').innerHTML = [
    ['Full cognition model', usage.model],
    ['Compact voice model', usage.voiceModel],
    ['Requests recorded', compactNumber(all.requests)],
    ['Input tokens', compactNumber(all.inputTokens)],
    ['Cached input tokens', compactNumber(all.cachedInputTokens)],
    ['Output tokens', compactNumber(all.outputTokens)],
    ['Reasoning tokens (included in output)', compactNumber(all.reasoningTokens)],
    ['Text-model cost', money(all.textModelCostUsd)],
    ['Voice transcription cost', money(all.audioTranscriptionCostUsd)],
    ['Voice synthesis cost', money(all.audioTtsCostUsd)],
    ['Mini rates', `$${usage.pricing.full.inputUsdPerMillion}/M input · $${usage.pricing.full.cachedInputUsdPerMillion}/M cached · $${usage.pricing.full.outputUsdPerMillion}/M output`],
    ['STT / TTS rates', `$${usage.pricing.transcriptionUsdPerMinute}/min · $${usage.pricing.ttsUsdPerMinute}/min`],
    ...modelRows,
  ].map(([label, value]) => `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('#usage-note').textContent = usage.note || '';
}

async function establishSession() {
  const session = await api('/api/session');
  state.csrf = session.csrf;
  sessionStorage.setItem('cinder_csrf', session.csrf);
}

function setView(name) {
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  void loadView(name);
}

async function loadOverview() {
  const overview = await api('/api/overview');
  state.overview = overview;
  const status = overview.status;
  const components = [
    ['Discord', status.discordConnected],
    ['Twitch', status.twitchConnected],
    ['OpenAI full tools', status.fullToolSelfTest],
    ['Windows bridge', status.bridge?.connected ?? status.bridge?.enabled === false],
    ['Runtime', !overview.runtime.paused],
  ];
  $('#status-grid').innerHTML = components.map(([label, ok]) => `
    <div class="status-card">
      <span class="status-dot ${ok ? 'ok' : 'bad'}"></span>${escapeHtml(label)}
      <strong>${ok ? 'Ready' : 'Not ready'}</strong>
    </div>
  `).join('');

  $('#runtime-details').innerHTML = [
    ['Hosting', status.hosting],
    ['Version', status.version],
    ['Model test', overview.startupSelfTest?.summary || 'Not completed'],
    ['Paused', overview.runtime.paused ? `Yes: ${overview.runtime.pauseReason || ''}` : 'No'],
    ['Queue depth', overview.runtime.queueDepth],
  ].map(([label, value]) => `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  $('#stat-details').innerHTML = Object.entries(overview.stats)
    .map(([label, value]) => `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join('');

  $('#approval-count').textContent = overview.stats.approvals;
  $('#failure-count').textContent = overview.stats.failures;
  renderUsage(overview.usage);
  const ready = status.discordConnected && status.fullToolSelfTest && !overview.runtime.paused;
  $('#connection-pill').textContent = ready ? 'Cinder ready' : 'Attention needed';
  $('#connection-pill').className = `pill ${ready ? 'ok' : 'bad'}`;
}

async function loadApprovals() {
  const items = await api('/api/approvals?resolved=true');
  $('#approvals-list').innerHTML = items.length ? items.map((item) => `
    <article class="item-card">
      <div class="item-head"><div><div class="item-title">${escapeHtml(item.description)}</div><div class="item-meta">${escapeHtml(item.status)} · ${when(item.createdAt)} · requested by ${escapeHtml(item.requestedByName)}</div></div><span class="pill ${item.status === 'pending' ? 'neutral' : item.status === 'executed' ? 'ok' : 'bad'}">${escapeHtml(item.status)}</span></div>
      <div class="item-body"><strong>Tool:</strong> ${escapeHtml(item.toolName)}</div>
      <pre class="json">${json(item.toolArguments)}</pre>
      ${item.status === 'pending' ? `<div class="inline-actions"><button class="success approval-approve" data-id="${escapeHtml(item.id)}">Approve</button><button class="danger-button approval-deny" data-id="${escapeHtml(item.id)}">Deny</button></div>` : ''}
    </article>
  `).join('') : '<article class="panel muted">No approvals are waiting. The tiny clipboard is empty.</article>';
  $$('.approval-approve').forEach((button) => button.addEventListener('click', () => resolveApproval(button.dataset.id, true)));
  $$('.approval-deny').forEach((button) => button.addEventListener('click', () => resolveApproval(button.dataset.id, false)));
}

async function resolveApproval(id, approved) {
  const note = prompt(approved ? 'Optional approval note:' : 'Optional denial reason:') || '';
  const result = await api(`/api/approvals/${encodeURIComponent(id)}/${approved ? 'approve' : 'deny'}`, {
    method: 'POST', body: JSON.stringify({ note })
  });
  toast(result.summary || 'Approval updated.', !result.ok);
  await loadApprovals();
  await loadOverview();
}

async function loadActions() {
  const items = await api('/api/actions?limit=200');
  $('#actions-list').innerHTML = items.length ? items.map((item) => `
    <article class="item-card">
      <div class="item-head"><div><div class="item-title">${escapeHtml(item.toolName)}</div><div class="item-meta">${when(item.createdAt)} · event ${escapeHtml(item.eventId)}</div></div><span class="pill ${item.result?.ok ? 'ok' : 'bad'}">${item.result?.ok ? 'success' : 'failed'}</span></div>
      <div class="item-body">${escapeHtml(item.result?.summary || '')}</div>
      <details><summary>Arguments and result</summary><pre class="json">${json({ arguments: item.toolArguments, result: item.result })}</pre></details>
    </article>
  `).join('') : '<article class="panel muted">No actions recorded yet.</article>';
}

async function loadEvents() {
  const platform = $('#event-platform').value;
  const items = await api(`/api/events?limit=200${platform ? `&platform=${encodeURIComponent(platform)}` : ''}`);
  $('#events-list').innerHTML = items.length ? items.map((item) => `
    <article class="item-card">
      <div class="item-head"><div><div class="item-title">${escapeHtml(item.actor?.displayName || 'Unknown')}</div><div class="item-meta">${escapeHtml(item.platform)} · ${escapeHtml(item.channelName || item.channelId || '')} · ${when(item.occurredAt)}</div></div>${item.actor?.isBot ? '<span class="pill neutral">bot</span>' : ''}</div>
      <div class="item-body">${escapeHtml(item.text)}</div>
      ${item.replyTo ? `<div class="item-meta">Replying to ${escapeHtml(item.replyTo.authorName || item.replyTo.messageId)}</div>` : ''}
    </article>
  `).join('') : '<article class="panel muted">Nothing matched that view.</article>';
}

async function loadFailures() {
  const items = await api('/api/failures?limit=200');
  $('#failures-list').innerHTML = items.length ? items.map((item) => `
    <article class="item-card">
      <div class="item-head"><div><div class="item-title">${escapeHtml(item.errorName)} · ${escapeHtml(item.id.slice(0, 8))}</div><div class="item-meta">${escapeHtml(item.platform)} · ${when(item.createdAt)}${item.requestId ? ` · OpenAI ${escapeHtml(item.requestId)}` : ''}</div></div><span class="pill ${item.acknowledgedAt ? 'neutral' : 'bad'}">${item.acknowledgedAt ? 'acknowledged' : 'new'}</span></div>
      <div class="item-body">${escapeHtml(item.errorMessage)}</div>
      ${item.errorCode ? `<div class="item-meta">Code: ${escapeHtml(item.errorCode)}${item.httpStatus ? ` · HTTP ${escapeHtml(item.httpStatus)}` : ''}</div>` : ''}
      <details><summary>Stack and exact details</summary><pre class="json">${escapeHtml(item.errorStack || 'No stack recorded.')}</pre></details>
      ${item.acknowledgedAt ? '' : `<div class="inline-actions"><button class="failure-ack" data-id="${escapeHtml(item.id)}">Acknowledge</button></div>`}
    </article>
  `).join('') : '<article class="panel muted">No cognitive failures recorded. Suspiciously tidy.</article>';
  $$('.failure-ack').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/failures/${encodeURIComponent(button.dataset.id)}/acknowledge`, { method: 'POST', body: '{}' });
    await loadFailures(); await loadOverview();
  }));
}

async function loadMemory() {
  const items = await api('/api/memories?limit=250');
  $('#memory-list').innerHTML = items.length ? items.map((item) => `
    <article class="item-card">
      <div class="item-head"><div><div class="item-title">${escapeHtml(item.kind)} · ${escapeHtml(item.scope)}</div><div class="item-meta">importance ${escapeHtml(item.importance)} · updated ${when(item.updatedAt)}</div></div><button class="danger-button memory-delete" data-id="${escapeHtml(item.id)}">Delete</button></div>
      <div class="item-body">${escapeHtml(item.content)}</div>
    </article>
  `).join('') : '<article class="panel muted">Cinder has not stored any memories yet.</article>';
  $$('.memory-delete').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Delete this memory permanently?')) return;
    await api(`/api/memories/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
    await loadMemory(); await loadOverview();
  }));
}

async function loadIdentities() {
  const items = await api('/api/identities?limit=300');
  $('#identities-list').innerHTML = items.length ? items.map((item) => `
    <article class="item-card">
      <div class="item-head"><div><div class="item-title">${escapeHtml(item.displayName)}</div><div class="item-meta">${escapeHtml(item.platform)} · ${escapeHtml(item.platformUserId)}</div></div><span class="pill ${item.verified ? 'ok' : 'neutral'}">${item.verified ? 'linked' : 'observed'}</span></div>
      <div class="item-body">Person ${escapeHtml(item.personId)}${item.username ? ` · @${escapeHtml(item.username)}` : ''}</div>
    </article>
  `).join('') : '<article class="panel muted">No identities observed yet.</article>';
}

function selectedValues(element) {
  return [...element.selectedOptions].map((option) => option.value).filter(Boolean);
}

function setSelectedValues(element, values) {
  const wanted = new Set(values || []);
  [...element.options].forEach((option) => { option.selected = wanted.has(option.value); });
}

function populateResources() {
  const channels = state.resources.channels || [];
  const roles = state.resources.roles || [];
  const channelOptions = channels
    .filter((channel) => !String(channel.type || '').includes('Category'))
    .map((channel) => `<option value="${escapeHtml(channel.id)}">#${escapeHtml(channel.name)} · ${escapeHtml(channel.type)}</option>`)
    .join('');
  const roleOptions = roles
    .map((role) => `<option value="${escapeHtml(role.name)}">${escapeHtml(role.name)}</option>`)
    .join('');
  $('#command-channel').innerHTML = `<option value="">No specific Discord channel</option>${channelOptions}`;
  $('#admin-channel').innerHTML = `<option value="">No special approval channel</option>${channelOptions}`;
  $('#quiet-channels').innerHTML = channelOptions;
  $('#memory-excluded').innerHTML = channelOptions;
  $('#moderator-role').innerHTML = roleOptions;
  $('#voice-role').innerHTML = roleOptions;
}

async function loadConfiguration() {
  const [config, resources] = await Promise.all([api('/api/config'), api('/api/resources')]);
  state.config = config;
  state.resources = resources;
  populateResources();
  $('#moderator-role').value = config.moderatorRoleName || '';
  $('#voice-role').value = config.voiceJoinRoleName || '';
  $('#admin-channel').value = config.botAdminChannelId || '';
  setSelectedValues($('#quiet-channels'), config.quietChannelIds || []);
  setSelectedValues($('#memory-excluded'), config.memoryExcludedChannelIds || []);
}

async function saveConfiguration() {
  const body = {
    moderatorRoleName: $('#moderator-role').value,
    voiceJoinRoleName: $('#voice-role').value,
    botAdminChannelId: $('#admin-channel').value,
    quietChannelIds: selectedValues($('#quiet-channels')),
    memoryExcludedChannelIds: selectedValues($('#memory-excluded')),
  };
  const saved = await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
  $('#config-result').textContent = `Saved at ${new Date().toLocaleTimeString()}. Moderator role: ${saved.moderatorRoleName}`;
  toast('Configuration saved.');
}

async function loadView(name) {
  try {
    if (name === 'overview') return loadOverview();
    if (name === 'approvals') return loadApprovals();
    if (name === 'actions') return loadActions();
    if (name === 'events') return loadEvents();
    if (name === 'failures') return loadFailures();
    if (name === 'memory') return loadMemory();
    if (name === 'identities') return loadIdentities();
    if (name === 'configuration') return loadConfiguration();
  } catch (error) {
    toast(error.message || String(error), true);
  }
}

async function commandCinder() {
  const text = $('#command-text').value.trim();
  if (!text) return toast('Give Cinder something to do first.', true);
  const channel = $('#command-channel').value.trim();
  const button = $('#command-send');
  button.disabled = true;
  $('#command-result').textContent = 'Cinder is thinking…';
  try {
    const body = { text };
    if (channel) body.channelId = channel;
    const result = await api('/api/command', { method: 'POST', body: JSON.stringify(body) });
    $('#command-result').textContent = JSON.stringify(result, null, 2);
    await loadOverview();
  } catch (error) {
    $('#command-result').textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
}

async function runTest(kind) {
  const live = kind === 'live';
  const button = live ? $('#live-test-button') : $('#self-test-button');
  const result = live ? $('#live-test-result') : $('#self-test-result');
  button.disabled = true;
  result.textContent = live ? 'Running live Discord and Twitch verification…' : 'Sending the complete real tool set to OpenAI…';
  try {
    const body = await api(live ? '/api/verify-live' : '/api/self-test', { method: 'POST', body: '{}' });
    result.textContent = JSON.stringify(body, null, 2);
    toast(body.ok ? 'Verification passed.' : 'Verification failed.', !body.ok);
    await loadOverview();
  } catch (error) {
    result.textContent = error.message || String(error);
    toast(result.textContent, true);
  } finally {
    button.disabled = false;
  }
}

async function init() {
  await establishSession();
  $$('.nav-button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#refresh-button').addEventListener('click', () => loadView($('.nav-button.active').dataset.view));
  $('#logout-button').addEventListener('click', async () => { await api('/api/logout', { method: 'POST', body: '{}' }); location.href = '/login'; });
  $('#event-platform').addEventListener('change', loadEvents);
  $('#command-send').addEventListener('click', commandCinder);
  $('#save-config').addEventListener('click', saveConfiguration);
  $('#self-test-button').addEventListener('click', () => runTest('self'));
  $('#live-test-button').addEventListener('click', () => runTest('live'));
  $('#pause-button').addEventListener('click', async () => { const reason = prompt('Pause reason:', 'Paused from the dashboard') || 'Paused from the dashboard'; await api('/api/control/pause', { method: 'POST', body: JSON.stringify({ reason }) }); await loadOverview(); });
  $('#resume-button').addEventListener('click', async () => { await api('/api/control/resume', { method: 'POST', body: '{}' }); await loadOverview(); });
  $('#restart-button').addEventListener('click', async () => { if (!confirm('Restart the Cinder service?')) return; await api('/api/control/restart', { method: 'POST', body: '{}' }); toast('Cinder is restarting. Refresh in a few seconds.'); });
  $('#link-identities').addEventListener('click', async () => {
    const body = {
      sourcePlatform: $('#link-source-platform').value.trim(),
      sourceUserId: $('#link-source-id').value.trim(),
      targetPlatform: $('#link-target-platform').value.trim(),
      targetUserId: $('#link-target-id').value.trim(),
    };
    await api('/api/identities/link', { method: 'POST', body: JSON.stringify(body) });
    toast('Identities linked.'); await loadIdentities();
  });
  await loadOverview();
  try {
    const stream = new EventSource('/api/stream');
    stream.addEventListener('snapshot', (event) => {
      const snapshot = JSON.parse(event.data);
      $('#approval-count').textContent = snapshot.stats.approvals;
      $('#failure-count').textContent = snapshot.stats.failures;
      renderUsage(snapshot.usage);
      const ready = snapshot.status.discordConnected && snapshot.status.fullToolSelfTest && !snapshot.runtime.paused;
      $('#connection-pill').textContent = ready ? 'Cinder ready' : 'Attention needed';
      $('#connection-pill').className = `pill ${ready ? 'ok' : 'bad'}`;
    });
  } catch {}
}

init().catch((error) => {
  console.error(error);
  location.href = '/login';
});
