const TERMINAL = ['succeeded', 'failed', 'interrupted'];

const STATUS_LABELS = {
  pending: 'Pendiente de confirmación',
  running: 'En ejecución',
  succeeded: 'Finalizada técnicamente',
  failed: 'Fallida',
  interrupted: 'Interrumpida',
};

const DISPATCH_LABELS = {
  admitted: 'Despacho: encargo admitido.',
  'session-confirmed': 'Despacho: sesión raíz confirmada; admisión del encargo sin confirmar.',
  'possibly-sent': 'Despacho: envío posible; admisión sin confirmar. El encargo no se reenviará automáticamente.',
  unconfirmed: 'Despacho: sin confirmar; el encargo no se reenviará automáticamente.',
  'selection-unavailable': 'Despacho: opción elegida no disponible; no se envió el encargo ni se sustituyó por otra.',
  'command-unavailable': 'Despacho: comando no disponible; no se envió el encargo ni se sustituyó por otro.',
};

const state = {
  health: null,
  connected: null,
  executions: [],
  selected: null,
  detail: null,
  draft: '',
  requestKey: crypto.randomUUID(),
  sending: false,
  error: null,
  options: null,
  optionsLoading: false,
  agent: '',
  model: '',
  command: '',
};

const statusLine = document.querySelector('#status');
const conversationPanel = document.querySelector('#conversation');
const historyList = document.querySelector('#history');

async function api(path, options = {}) {
  const init = { ...options };
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
  }
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw { status: response.status, body };
  return body;
}

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function renderStatus() {
  if (state.connected === false) {
    statusLine.textContent = 'Sin conexión con la app local; datos según la última respuesta conocida.';
    return;
  }
  const engine = state.health?.engine?.reachable ? 'Motor: disponible' : 'Motor: no disponible';
  const capture = state.health?.capture?.status === 'prepared'
    ? 'Captura: preparada' : 'Captura: no disponible';
  const extra = state.health?.capture?.status === 'failed' ? ' · fallo del registrador' : '';
  statusLine.textContent = `${engine} · ${capture}${extra}`;
}

function renderMessages() {
  const detail = state.detail;
  const conversation = detail?.conversation ?? { entries: [], responses: [] };
  const messages = el('ul', { class: 'messages', 'aria-label': 'Mensajes' });
  for (const entry of conversation.entries) {
    messages.append(el('li', { class: 'message user' }, el('h3', {}, 'Encargo'), el('p', {}, entry.text)));
  }
  for (const response of conversation.responses) {
    messages.append(el('li', { class: 'message assistant' }, el('h3', {}, 'Respuesta'), el('p', {}, response.text)));
  }
  if (!conversation.responses.length) {
    const pending = detail?.execution?.status === 'running';
    messages.append(el('li', { class: 'message waiting' }, el('p', {}, pending
      ? 'Sin respuesta observada todavía; la captura puede ir por detrás del trabajo.'
      : 'Sin respuesta observada en la captura; no se reconstruye texto no capturado.')));
  }
  return messages;
}

function renderOptionSelect(name, id, entries, value, placeholder, placeholderEmpty) {
  const select = el('select', { id, 'aria-label': name });
  if (state.options === null) {
    select.append(el('option', { value: '' }, 'Cargando opciones…'));
    select.setAttribute('disabled', '');
  } else if (state.options.state !== 'ready') {
    select.append(el('option', { value: '' }, 'No se pudieron consultar las opciones'));
    select.setAttribute('disabled', '');
  } else if (!entries.length) {
    select.append(el('option', { value: '' }, placeholderEmpty));
    select.setAttribute('disabled', '');
  } else {
    select.append(el('option', { value: '' }, placeholder));
    for (const entry of entries) {
      select.append(el('option', { value: entry.id }, entry.label));
    }
  }
  if (value) select.value = value;
  select.addEventListener('change', event => {
    state[id] = event.target.value;
    if (id === 'command') {
      const notice = document.querySelector('#composer-notice');
      if (notice) notice.textContent = state.command
        ? `El comando «${state.command}» se ejecuta por la interfaz pública de OpenCode; el texto son sus argumentos.`
        : 'La conversación admite un único envío inicial en este incremento.';
    }
  });
  return el('label', { for: id }, name, select);
}

function optionsStatus() {
  if (state.optionsLoading && state.options === null) {
    return el('p', { id: 'options-status', class: 'notice' }, 'Cargando agentes, modelos y comandos de la instancia…');
  }
  if (state.options === null) return null;
  if (state.options.state === 'engine-unreachable') {
    return el('p', { id: 'options-status', class: 'notice' }, 'Motor no disponible: no se pudieron consultar las opciones del proyecto.');
  }
  if (state.options.state !== 'ready') {
    return el('p', { id: 'options-status', class: 'notice' }, 'No se pudieron consultar las opciones del proyecto.');
  }
  const empty = ['agents', 'models', 'commands'].filter(kind => !state.options[kind].length);
  if (!empty.length) return null;
  return el('p', { id: 'options-status', class: 'notice' },
    `La instancia no expone ${empty.join(', ')} para el proyecto configurado.`);
}

function renderComposer() {
  const entries = {
    agents: state.options?.state === 'ready'
      ? state.options.agents.map(agent => ({ id: agent.id, label: agent.name ?? agent.id })) : [],
    models: state.options?.state === 'ready'
      ? state.options.models.map(model => ({ id: model.value, label: model.name })) : [],
    commands: state.options?.state === 'ready'
      ? state.options.commands.map(command => ({ id: command.name,
        label: command.name + (command.description ? ` — ${command.description}` : '') })) : [],
  };
  const form = el('form', { id: 'composer' },
    renderOptionSelect('Agente', 'agent', entries.agents, state.agent,
      'Sin selección: agente por defecto de la sesión', 'Sin agentes expuestos'),
    renderOptionSelect('Modelo', 'model', entries.models, state.model,
      'Sin selección: modelo por defecto de la sesión', 'Sin modelos expuestos'),
    renderOptionSelect('Comando', 'command', entries.commands, state.command,
      'Sin comando: el texto se envía como encargo', 'La instancia no expone comandos'),
    el('label', { for: 'draft' }, 'Encargo'),
    el('textarea', { id: 'draft', 'aria-label': 'Encargo', rows: '5', maxlength: '20000' }),
    el('button', { id: 'send', type: 'submit', ...(state.sending ? { disabled: '' } : {}) }, 'Enviar'),
    state.command
      ? el('p', { id: 'composer-notice', class: 'notice' }, `El comando «${state.command}» se ejecuta por la interfaz pública de OpenCode; el texto son sus argumentos.`)
      : el('p', { id: 'composer-notice', class: 'notice' }, 'La conversación admite un único envío inicial en este incremento.'),
  );
  const status = optionsStatus();
  if (status) form.append(status);
  if (state.error) form.append(el('p', { role: 'alert', class: 'error' }, state.error));
  form.addEventListener('input', event => {
    if (event.target.id === 'draft') state.draft = event.target.value;
  });
  form.addEventListener('submit', submitDraft);
  conversationPanel.replaceChildren(el('h2', {}, 'Nuevo encargo'), form);
  const textarea = form.querySelector('#draft');
  textarea.value = state.draft;
}

async function submitDraft(event) {
  event.preventDefault();
  if (state.sending || !state.draft.trim()) return;
  state.sending = true;
  state.error = null;
  renderComposer();
  const body = { requestKey: state.requestKey };
  if (state.command) body.command = { name: state.command, arguments: state.draft.trim() };
  else body.text = state.draft.trim();
  if (state.agent) body.agent = state.agent;
  if (state.model) body.model = state.model;
  try {
    const { execution } = await api('/api/executions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    state.selected = execution.id;
    state.detail = null;
    state.draft = '';
    state.agent = '';
    state.model = '';
    state.command = '';
    state.requestKey = crypto.randomUUID();
    state.error = null;
  } catch (error) {
    const unavailable = error?.status === 422 && error?.body?.error === 'selection-unavailable';
    state.error = unavailable
      ? `La opción elegida (${error?.body?.kind}: ${error?.body?.option}) ya no está disponible para este proyecto. No se ha lanzado nada; las opciones se han vuelto a consultar.`
      : error?.body?.error === 'project-busy'
        ? 'El proyecto está ocupado por otra ejecución. Espera a su desenlace antes de lanzar otro encargo.'
        : 'No se pudo lanzar la ejecución. Reintenta el mismo encargo: un envío repetido no duplica el trabajo.';
    if (unavailable) {
      state.options = null;
      refreshOptions();
    }
  } finally {
    state.sending = false;
    renderConversation();
  }
}

async function refreshOptions() {
  if (state.optionsLoading) return;
  state.optionsLoading = true;
  if (state.options === null) renderConversation();
  try { state.options = await api('/api/options'); }
  catch { state.options = null; }
  state.optionsLoading = false;
  if (state.selected === null) renderConversation();
}

function renderExecution() {
  const detail = state.detail;
  const execution = detail?.execution;
  if (!execution) {
    conversationPanel.replaceChildren(
      el('h2', {}, `Ejecución ${state.selected.slice(0, 8)}`),
      el('p', {}, 'Consultando la evidencia persistida…'));
    return;
  }
  const capture = detail.capture;
  const selectionRows = [];
  const knownAgent = execution.knownAgent
    ? `${execution.knownAgent} (procedencia: API pública de la sesión)`
    : execution.requestedAgent ? 'sin confirmar todavía' : 'sin selección';
  const knownModel = execution.knownModel
    ? `${execution.knownModel.value} (procedencia: API pública de la sesión)`
    : execution.requestedModel ? 'sin confirmar todavía' : 'sin selección';
  selectionRows.push(el('dt', {}, 'Agente'),
    el('dd', {}, `Elegido: ${execution.requestedAgent ?? 'ninguno'} · Conocido: ${knownAgent}`));
  selectionRows.push(el('dt', {}, 'Modelo'),
    el('dd', {}, `Elegido: ${execution.requestedModel ?? 'ninguno'} · Conocido: ${knownModel}`));
  selectionRows.push(el('dt', {}, 'Comando'),
    el('dd', {}, execution.requestedCommand
      ? `${execution.requestedCommand.name} · argumentos: ${execution.requestedCommand.arguments}`
      : 'encargo directo sin comando'));
  const panel = [
    el('h2', {}, `Ejecución ${execution.id.slice(0, 8)}`),
    el('p', { id: 'execution-status' }, `Estado: ${STATUS_LABELS[execution.status] ?? execution.status}`),
    el('p', { class: 'dispatch' }, DISPATCH_LABELS[execution.dispatch] ?? DISPATCH_LABELS.unconfirmed),
    renderMessages(),
    el('dl', { class: 'identity' },
      el('dt', {}, 'Ejecución'), el('dd', {}, execution.id),
      ...selectionRows,
      el('dt', {}, 'Sesión raíz'), el('dd', {}, execution.sessionID ?? 'sin sesión confirmada'),
      el('dt', {}, 'Capturas'), el('dd', {}, capture?.readable
        ? (capture.captureIDs.length ? capture.captureIDs.join(', ') : 'sin filas de captura de esta ejecución')
        : `no consultable: ${capture?.reason ?? 'desconocido'}`),
      el('dt', {}, 'Alcance de evidencia'), el('dd', {}, capture?.readable
        ? `Árbol de sesiones observado: ${capture.scope.sessionIDs.join(', ')}` : 'desconocido'),
      el('dt', {}, 'Evidencia hasta'), el('dd', {}, capture?.readable
        ? (capture.horizon ?? 'sin eventos observados') : 'horizonte desconocido')),
    el('p', { class: 'notice' }, 'Este corte permite un único envío inicial por ejecución; no hay cierre manual.'),
  ];
  if (state.health?.engine?.reachable === false && !TERMINAL.includes(execution.status)) {
    panel.splice(2, 0, el('p', { id: 'engine-offline', class: 'notice' },
      'Motor no disponible: desenlace pendiente de comprobar; el encargo no se reenviará.'));
  }
  if (capture?.recorderFailed) {
    panel.splice(2, 0, el('p', { role: 'alert', class: 'error' },
      'Fallo del registrador: revisar antes de volver a ejecutar.'));
  }
  if (capture?.gaps?.length) {
    panel.push(el('section', { 'aria-label': 'Lagunas conocidas' },
      el('h3', {}, 'Lagunas del destino de captura'),
      el('p', {}, 'Sin atribución a esta ejecución: la captura no identifica la sesión afectada. No hay replay ni relleno de texto.'),
      el('ul', {}, ...capture.gaps.map(gap => el('li', {},
        `${gap.captureID} · fila ${gap.arrival} · ${new Date(gap.observedAt).toISOString()}: ${gap.reason}`)))));
  }
  if (capture?.omissions?.length) {
    panel.push(el('details', { 'aria-label': 'Omisiones observadas' },
      el('summary', {}, 'Omisiones observadas en el árbol de sesiones'),
      el('ul', {}, ...capture.omissions.map(row => el('li', {},
        `${row.sessionID} · ${row.captureID} · fila ${row.arrival} · ${row.type}: ${row.omissions.join(', ')}`)))));
  }
  conversationPanel.replaceChildren(...panel);
}

function renderConversation() {
  if (state.selected === null) renderComposer();
  else renderExecution();
}

function renderHistory() {
  historyList.replaceChildren();
  if (!state.executions.length) {
    historyList.append(el('li', { class: 'empty' }, 'Sin ejecuciones todavía.'));
    return;
  }
  for (const execution of state.executions) {
    const label = `Ejecución ${execution.id.slice(0, 8)} · ${STATUS_LABELS[execution.status] ?? execution.status}`;
    const button = el('button', { type: 'button', 'data-id': execution.id,
      ...(state.selected === execution.id ? { 'aria-current': 'true' } : {}) }, label);
    button.addEventListener('click', () => {
      state.selected = execution.id;
      state.detail = null;
      state.error = null;
      renderConversation();
      refreshDetail();
    });
    historyList.append(el('li', {}, button));
  }
}

document.querySelector('#new-chat').addEventListener('click', () => {
  state.selected = null;
  state.detail = null;
  state.error = null;
  state.draft = '';
  state.agent = '';
  state.model = '';
  state.command = '';
  state.requestKey = crypto.randomUUID();
  renderConversation();
  refreshOptions();
});

async function refreshHealth() {
  try {
    state.health = await api('/api/health');
    state.connected = true;
  } catch {
    state.connected = false;
  }
  renderStatus();
}

async function refreshDetail() {
  if (state.selected === null) return;
  try { state.detail = await api(`/api/executions/${state.selected}`); }
  catch { return; }
  renderConversation();
}

async function refreshExecutions() {
  try { state.executions = (await api('/api/executions')).executions; }
  catch { return; }
  renderHistory();
}

async function tick() {
  await refreshHealth();
  if (state.selected === null) {
    await refreshExecutions();
    if (state.options === null && !state.optionsLoading) await refreshOptions();
  } else await refreshDetail();
}

renderConversation();
renderHistory();
tick();
setInterval(tick, 1500);
