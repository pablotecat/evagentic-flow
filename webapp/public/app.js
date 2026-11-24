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
};

const state = {
  health: null,
  executions: [],
  selected: null,
  detail: null,
  draft: '',
  requestKey: crypto.randomUUID(),
  sending: false,
  error: null,
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
  if (!conversation.responses.length && detail?.execution?.status === 'running') {
    messages.append(el('li', { class: 'message waiting' }, el('p', {}, 'Sin respuesta observada todavía.')));
  }
  return messages;
}

function renderComposer() {
  const form = el('form', { id: 'composer' },
    el('label', { for: 'draft' }, 'Encargo'),
    el('textarea', { id: 'draft', 'aria-label': 'Encargo', rows: '5', maxlength: '20000' }),
    el('button', { id: 'send', type: 'submit', ...(state.sending ? { disabled: '' } : {}) }, 'Enviar'),
    el('p', { class: 'notice' }, 'La conversación admite un único envío inicial en este incremento.'),
  );
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
  try {
    const { execution } = await api('/api/executions', {
      method: 'POST',
      body: JSON.stringify({ requestKey: state.requestKey, text: state.draft.trim() }),
    });
    state.selected = execution.id;
    state.detail = null;
    state.draft = '';
    state.requestKey = crypto.randomUUID();
    state.error = null;
  } catch (error) {
    state.error = error?.body?.error === 'project-busy'
      ? 'El proyecto está ocupado por otra ejecución. Espera a su desenlace antes de lanzar otro encargo.'
      : 'No se pudo lanzar la ejecución. Reintenta el mismo encargo: un envío repetido no duplica el trabajo.';
  } finally {
    state.sending = false;
    renderConversation();
  }
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
  const panel = [
    el('h2', {}, `Ejecución ${execution.id.slice(0, 8)}`),
    el('p', { id: 'execution-status' }, `Estado: ${STATUS_LABELS[execution.status] ?? execution.status}`),
    el('p', { class: 'dispatch' }, DISPATCH_LABELS[execution.dispatch] ?? DISPATCH_LABELS.unconfirmed),
    renderMessages(),
    el('dl', { class: 'identity' },
      el('dt', {}, 'Ejecución'), el('dd', {}, execution.id),
      el('dt', {}, 'Sesión raíz'), el('dd', {}, execution.sessionID ?? 'sin sesión confirmada'),
      el('dt', {}, 'Capturas'), el('dd', {}, capture?.readable && capture.captureIDs.length
        ? capture.captureIDs.join(', ') : 'sin evidencia de captura registrada')),
    el('p', { class: 'notice' }, 'Este corte permite un único envío inicial por ejecución; no hay cierre manual.'),
  ];
  if (capture?.recorderFailed) {
    panel.splice(2, 0, el('p', { role: 'alert', class: 'error' },
      'Fallo del registrador: revisar antes de volver a ejecutar.'));
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
  state.requestKey = crypto.randomUUID();
  renderConversation();
});

async function refreshHealth() {
  try { state.health = await api('/api/health'); }
  catch { state.health = null; }
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
  if (state.selected === null) await refreshExecutions();
  else await refreshDetail();
}

renderConversation();
renderHistory();
tick();
setInterval(tick, 1500);
