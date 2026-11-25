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
};

const INTERACTION_ERRORS = {
  'invalid-json': 'La respuesta enviada no tenía un formato válido.',
  'invalid-request': 'La respuesta no era válida para la solicitud pendiente; no se ha enviado nada.',
  'invalid-answer': 'El tipo de una respuesta no coincide con el campo público admitido.',
  'answer-fields-not-authorized': 'La respuesta incluía campos no autorizados por la solicitud observada.',
  'missing-required-field': 'Falta una respuesta obligatoria de la solicitud.',
  'request-not-observable': 'La captura no permite comprobar los campos admisibles; no se ha respondido nada.',
  'unknown-interaction': 'No existe esa solicitud pendiente para esta ejecución.',
  'interaction-resolved': 'La solicitud ya estaba resuelta o desaparecida; no se ha vuelto a responder.',
  'session-not-in-execution': 'La solicitud pertenece a otra sesión o ejecución; no se ha respondido nada ajeno.',
  'execution-terminal': 'La ejecución ya está cerrada; ya no se admite responder aquí.',
  'evidence-unavailable': 'La evidencia no está consultable; no se ha respondido nada.',
  'engine-unreachable': 'No se pudo consultar la solicitud en el motor; esta petición no llegó a intentar la respuesta.',
  'reply-unconfirmed': 'Respuesta posiblemente enviada: no se pudo confirmar el resultado. El permiso pudo aplicarse; pendiente de reconciliar con la evidencia y el motor. No se repetirá automáticamente.',
};

const STOP_ERRORS = {
  'execution-terminal': 'La ejecución ya está cerrada; la detención ya no aplica.',
  'unknown-execution': 'La ejecución no existe; no se ha interrumpido nada.',
  'session-not-confirmed': 'Todavía no hay sesión confirmada para detener; no se ha interrumpido nada.',
  unknown: 'No se pudo procesar la detención; el desenlace queda sin confirmar y el encargo no se reenvía.',
};

const STOP_REQUEST_LABELS = {
  accepted: 'aceptada',
  'not-running': 'sesión no activa',
  error: 'fallo de la solicitud',
  'already-interrupted': 'interrumpida antes de esta solicitud',
};

const DELIVERABLE_ROLE_LABELS = {
  input: 'entrada en la frontera pública',
  intermediate: 'intermedio en la frontera pública',
  output: 'salida en la frontera de la herramienta',
};

const DELIVERABLE_ACQUISITION_LABELS = {
  'runtime-content': 'contenido capturado del propio evento del runtime',
  'post-event-file-read': 'lectura posterior al evento o hook',
  'not-acquired': 'no adquirido',
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
  interactionAnswers: {},
  interactionError: null,
  replying: false,
  stopping: false,
  stopError: null,
  stopRequest: null,
  trace: null,
  selectedSession: null,
  deliverables: null,
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
  const body = await response.json();
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

const sessionLabel = (execution, sessionID) => sessionID === execution.sessionID
  ? 'Sesión raíz' : `Subejecución ${sessionID}`;

const interactionKey = item => JSON.stringify([item.kind, item.sessionID, item.requestID]);

function onInteractionInput(event) {
  const target = event.target;
  const fieldKey = target.dataset?.field;
  const wrap = target.closest('[data-request]');
  if (!fieldKey || !wrap) return;
  const key = interactionKey({ kind: wrap.dataset.kind, sessionID: wrap.dataset.session,
    requestID: wrap.dataset.request });
  const answers = state.interactionAnswers[key] ?? (state.interactionAnswers[key] = {});
  if (target.type === 'checkbox' && target.dataset.group === 'multiselect') {
    const values = new Set(Array.isArray(answers[fieldKey]) ? answers[fieldKey] : []);
    if (target.checked) values.add(target.value);
    else values.delete(target.value);
    answers[fieldKey] = [...values];
  } else if (target.type === 'checkbox') answers[fieldKey] = target.checked;
  else answers[fieldKey] = target.value;
}

function renderInteractionField(key, field) {
  const stored = state.interactionAnswers[key]?.[field.key];
  const label = `${field.title ?? field.key}${field.required ? ' *' : ''}`;
  if (field.type === 'boolean') {
    const input = el('input', { type: 'checkbox', 'data-field': field.key });
    input.checked = stored === true;
    return [el('label', {}, label, input)];
  }
  if (field.type === 'multiselect') {
    const group = el('fieldset', {}, el('legend', {}, label));
    for (const option of Array.isArray(field.options) ? field.options : []) {
      const value = typeof option?.value === 'string' ? option.value
        : typeof option?.label === 'string' ? option.label : null;
      if (value === null) continue;
      const input = el('input', { type: 'checkbox', 'data-field': field.key, value, 'data-group': 'multiselect' });
      input.checked = Array.isArray(stored) && stored.includes(value);
      group.append(el('label', {}, option.label ?? value, input));
    }
    return [group];
  }
  if (field.type === 'number' || field.type === 'integer') {
    const input = el('input', { type: 'number', 'data-field': field.key, step: 'any' });
    if (typeof stored === 'string' && stored) input.value = stored;
    return [el('label', {}, label, input)];
  }
  if (Array.isArray(field.options) && field.options.length) {
    const select = el('select', { 'data-field': field.key }, el('option', { value: '' }, '— elegir respuesta —'));
    for (const option of field.options) {
      const value = typeof option?.value === 'string' ? option.value : String(option?.label ?? '');
      select.append(el('option', { value }, option?.label ?? value));
    }
    if (typeof stored === 'string' && stored) select.value = stored;
    const rows = [el('label', {}, label, select)];
    if (field.custom) {
      const input = el('input', { type: 'text', 'data-field': field.key, placeholder: 'Respuesta propia' });
      if (typeof stored === 'string' && stored) input.value = stored;
      rows.push(el('label', {}, `Respuesta propia para ${field.title ?? field.key}`, input));
    }
    return rows;
  }
  const input = el('input', { type: 'text', 'data-field': field.key });
  if (typeof stored === 'string') input.value = stored;
  return [el('label', {}, label, input)];
}

function renderQuestion(execution, item) {
  const requestID = item.requestID;
  const fields = Array.isArray(item.request?.fields) ? item.request.fields : [];
  if (!fields.length) {
    return el('section', { 'data-kind': 'form', 'data-session': item.sessionID, 'data-request': requestID },
      el('h4', {}, `Pregunta nativa · ${sessionLabel(execution, item.sessionID)}`),
      el('p', {}, item.request?.title ?? 'Sin título observable'),
      el('p', { class: 'notice' }, 'La captura no expone los campos admitidos de esta pregunta; no se puede responder desde la app.'));
  }
  const form = el('form', { 'data-kind': 'form', 'data-session': item.sessionID, 'data-request': requestID },
    el('h4', {}, `Pregunta nativa · ${sessionLabel(execution, item.sessionID)}`),
    el('p', {}, item.request?.title ?? 'Sin título observable'),
    ...fields.flatMap(field => renderInteractionField(interactionKey(item), field)),
    el('button', { type: 'submit', ...(state.replying ? { disabled: '' } : {}) }, 'Responder pregunta'));
  form.addEventListener('input', onInteractionInput);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const answers = state.interactionAnswers[interactionKey(item)] ?? {};
    const answer = {};
    for (const field of fields) {
      const raw = answers[field.key] ?? (field.type === 'boolean' ? false : undefined);
      if (raw === undefined || raw === '') continue;
      answer[field.key] = field.type === 'number' || field.type === 'integer' ? Number(raw) : raw;
    }
    replyInteraction({ kind: 'form', sessionID: item.sessionID, requestID, answer });
  });
  return form;
}

function renderPermission(execution, item) {
  const request = item.request ?? {};
  const section = el('section', { 'data-kind': 'permission', 'data-session': item.sessionID, 'data-request': item.requestID },
    el('h4', {}, `Permiso nativo · ${sessionLabel(execution, item.sessionID)}`),
    el('p', {}, `Acción: ${typeof request.action === 'string' ? request.action : 'desconocida'}`),
    el('p', {}, `Alcance: ${Array.isArray(request.resources) && request.resources.length
      ? request.resources.join(' · ') : 'desconocido'}`),
    typeof request.message === 'string' ? el('p', {}, `Mensaje: ${request.message}`) : null,
    el('p', { class: 'notice' },
      'La decisión se envía como decisión nativa de OpenCode; «Permitir siempre» sólo persiste el permiso si el runtime lo admite para esa acción.'),
    el('div', { class: 'permission-actions' },
      el('button', { type: 'button', 'data-decision': 'once', ...(state.replying ? { disabled: '' } : {}) }, 'Permitir una vez'),
      el('button', { type: 'button', 'data-decision': 'always', ...(state.replying ? { disabled: '' } : {}) }, 'Permitir siempre'),
      el('button', { type: 'button', 'data-decision': 'reject', ...(state.replying ? { disabled: '' } : {}) }, 'Rechazar')));
  for (const button of section.querySelectorAll('button')) {
    button.addEventListener('click', () => replyInteraction({ kind: 'permission',
      sessionID: item.sessionID, requestID: item.requestID, decision: button.dataset.decision }));
  }
  return section;
}

function renderInteractions() {
  const detail = state.detail;
  const execution = detail?.execution;
  const interactions = detail?.interactions ?? { pending: [], resolved: [] };
  if (!execution) return [];
  const sections = [];
  for (const error of interactions.readErrors ?? []) {
    sections.push(el('p', { role: 'alert', class: 'error' },
      `No se pudieron leer las solicitudes pendientes${error.sessionID ? ` de ${error.sessionID}` : ''}. `
      + 'Las solicitudes capturadas se conservan, pero su vigencia no está comprobada. La consulta no envía respuestas.'));
  }
  if (interactions.pending.length) {
    sections.push(el('section', { id: 'interactions', 'aria-label': 'Intervención' },
      el('h3', {}, 'Esperando intervención'),
      el('p', { class: 'notice' },
        'La ejecución espera intervención: conserva su identidad, no se cierra ni falla por esperar, y responder no lanza otro encargo.'),
      ...interactions.pending.map(item => item.kind === 'form'
        ? renderQuestion(execution, item) : renderPermission(execution, item)),
      state.interactionError ? el('p', { role: 'alert', class: 'error' }, state.interactionError) : null));
  } else if (state.interactionError) {
    sections.push(el('p', { role: 'alert', class: 'error' }, state.interactionError));
  }
  if (interactions.resolved.length) {
    sections.push(el('details', { 'aria-label': 'Respuestas registradas' },
      el('summary', {}, 'Respuestas registradas en la captura'),
      el('ul', {}, ...interactions.resolved.map(item => el('li', {},
        `${item.kind === 'permission' ? 'Permiso' : 'Pregunta'} · ${sessionLabel(execution, item.sessionID)} · ${item.phase === 'cancelled' ? 'cancelada' : 'respondida'} · ${JSON.stringify(item.response ?? {})}`))),
      el('p', { class: 'notice' },
        'La captura no atribuye las respuestas a una persona autenticada: su procedencia es cliente externo no identificado.')));
  }
  return sections;
}

async function replyInteraction(payload) {
  if (state.replying || state.selected === null) return;
  state.replying = true;
  state.interactionError = null;
  try {
    await api(`/api/executions/${state.selected}/interactions`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    delete state.interactionAnswers[interactionKey(payload)];
    await refreshDetail();
  } catch (error) {
    state.interactionError = INTERACTION_ERRORS[error?.body?.error]
      ?? INTERACTION_ERRORS['reply-unconfirmed'];
  } finally {
    state.replying = false;
    renderConversation();
  }
}

async function requestStop() {
  if (state.stopping || state.selected === null) return;
  state.stopping = true;
  state.stopError = null;
  renderConversation();
  try {
    const body = await api(`/api/executions/${state.selected}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    state.stopRequest = body.stop;
  } catch (error) {
    state.stopError = STOP_ERRORS[error?.body?.error] ?? STOP_ERRORS.unknown;
  } finally {
    state.stopping = false;
  }
  await refreshDetail();
}

function renderStop(execution) {
  if (!execution) return [];
  const stop = state.detail?.stop;
  const sections = [];
  if (stop?.requested) {
    const requested = state.stopRequest?.sessions ?? [];
    sections.push(el('section', { id: 'stop-requested', 'aria-label': 'Detención' },
      el('h3', {}, 'Detención solicitada'),
      el('p', { class: 'notice' },
        'La detención actúa sólo sobre el alcance verificado de esta ejecución. Una solicitud aceptada no es una detención confirmada: no hay interrupción instantánea, pausa, reanudación ni reversión de efectos externos, y el encargo no se reenvía.'),
      el('ul', {}, ...(stop.sessions ?? []).map(session => {
        const request = requested.find(item => item.sessionID === session.sessionID);
        return el('li', {}, `${sessionLabel(execution, session.sessionID)} · Solicitud: ${
          request ? STOP_REQUEST_LABELS[request.result] ?? request.result : 'sin comprobar'} · Detención: ${
          session.stop === 'confirmed' ? 'confirmada' : 'no confirmada'}`);
      })),
      stop.treeVerified === false ? el('p', { role: 'alert', class: 'error' },
        'No se pudo verificar el árbol de sesiones; los descendientes nuevos no pudieron comprobarse.') : null,
      stop.readError ? el('p', { role: 'alert', class: 'error' },
        'No se pudo comprobar el desenlace público de la detención; se mantiene no confirmada y el trabajo no se relanza.') : null));
  }
  if (!TERMINAL.includes(execution.status) && execution.sessionID) {
    const button = el('button', { id: 'stop', type: 'button', ...(state.stopping ? { disabled: '' } : {}) }, 'Detener');
    button.addEventListener('click', requestStop);
    sections.push(button);
  }
  if (state.stopError) {
    sections.push(el('p', { role: 'alert', class: 'error' }, state.stopError));
  }
  return sections;
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
    state.trace = null;
    state.selectedSession = null;
    state.deliverables = null;
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

const OUTCOME_LABELS = {
  success: 'éxito observado',
  error: 'error observado',
  'not-observed': 'sin desenlace observado: desconocido; puede ser trabajo en curso y no acredita fallo, éxito ni consumo cero',
};

const INTERVAL_STATE_LABELS = {
  concluded: 'concluida',
  failed: 'fallida',
  interrupted: 'interrumpida',
  unknown: 'desconocida',
};

const formatMs = value => value === null || value === undefined
  ? 'no observado' : new Date(value).toISOString();

const evidenceText = refs => (Array.isArray(refs) ? refs : [refs])
  .map(ref => `${ref.captureID} · fila ${ref.arrival}${ref.eventID ? ` · evento ${ref.eventID}` : ''}${ref.type ? ` (${ref.type})` : ''}`)
  .join(' | ');

function selectSession(sessionID) {
  if (state.selectedSession === sessionID) return;
  state.selectedSession = sessionID;
  state.trace = null;
  state.deliverables = null;
  renderConversation();
  refreshTrace();
  refreshDeliverables();
}

async function refreshTrace() {
  const executionID = state.selected;
  const sessionID = state.selectedSession;
  if (executionID === null) return;
  const query = sessionID ? `?session=${encodeURIComponent(sessionID)}` : '';
  let trace;
  try { trace = await api(`/api/executions/${executionID}/trace${query}`); }
  catch { trace = { readable: false, reason: 'trace-unavailable' }; }
  if (state.selected !== executionID || state.selectedSession !== sessionID) return;
  state.trace = trace;
  renderConversation();
}

async function refreshDeliverables() {
  const executionID = state.selected;
  const sessionID = state.selectedSession;
  if (executionID === null) return;
  const query = sessionID ? `?session=${encodeURIComponent(sessionID)}` : '';
  let body;
  try { body = await api(`/api/executions/${executionID}/deliverables${query}`); }
  catch { body = { readable: false, reason: 'deliverables-unavailable' }; }
  if (state.selected !== executionID || state.selectedSession !== sessionID) return;
  state.deliverables = body;
  renderConversation();
}

function renderTraceTree(execution, trace) {
  const nodes = trace.tree.nodes;
  const byID = new Map(nodes.map(node => [node.sessionID, node]));
  const children = new Map();
  const roots = [];
  for (const node of nodes) {
    const parentID = node.delegations[0]?.parentSessionID
      ?? node.observedParents.find(id => id !== node.sessionID) ?? null;
    if (parentID && parentID !== node.sessionID && byID.has(parentID)) {
      if (!children.has(parentID)) children.set(parentID, []);
      children.get(parentID).push(node);
    } else roots.push(node);
  }
  const renderNode = node => {
    const title = node.sessionID === execution.sessionID
      ? `Sesión raíz ${node.sessionID}` : `Subejecución ${node.sessionID}`
        + (node.isViewRoot ? ' (raíz de la vista)' : '');
    const button = el('button', { type: 'button', 'data-session': node.sessionID,
      ...(trace.selectedSessionID === node.sessionID ? { 'aria-current': 'true' } : {}) }, title);
    button.addEventListener('click', () => selectSession(node.sessionID));
    const agent = node.agentIDs.length ? `agente: ${node.agentIDs.join(', ')}` : 'agente no observado';
    const relation = node.relation === 'view-root' ? 'raíz de la vista actual'
      : node.relation === 'delegation-call-observed'
        ? `hija por ${node.delegations.length} llamada(s) observada(s): ${node.delegations.map(delegation =>
          `${delegation.parentSessionID} · ${delegation.callID ?? 'sin id de llamada'} · evidencia: ${
            evidenceText(delegation.evidence)}`).join(' | ')}`
        : node.relation === 'parent-observed-call-unknown'
          ? `padre observado ${node.observedParents.join(', ')}; llamada creadora no observada`
          : 'relación desconocida o excluida';
    return el('li', {}, el('div', { class: 'tree-node' }, button,
      el('span', { class: 'tree-relation' }, `${agent} · ${relation}`)),
      el('ul', {}, ...(children.get(node.sessionID) ?? []).map(renderNode)));
  };
  return el('section', { 'aria-label': 'Árbol de subejecuciones' },
    el('h4', {}, 'Árbol de subejecuciones'),
    el('p', { class: 'notice' },
      'Sólo aparecen sesiones relacionadas por evidencia: una llamada de delegación observada o un padre observado. «Relación desconocida» significa relación no observada o excluida, no una asociación deducida.'),
    el('ul', { class: 'tree', role: 'tree' }, ...roots.map(renderNode)));
}

function renderTimeline(execution, trace) {
  const intervals = trace.timeline.intervals;
  const waits = trace.timeline.waits;
  const bySession = new Map();
  for (const interval of intervals) {
    if (!bySession.has(interval.sessionID)) bySession.set(interval.sessionID, []);
    bySession.get(interval.sessionID).push(interval);
  }
  for (const wait of waits) {
    if (!bySession.has(wait.sessionID)) bySession.set(wait.sessionID, []);
  }
  const finite = intervals.filter(interval => interval.startedAt !== null && interval.endedAt !== null);
  const first = finite.length ? Math.min(...finite.map(interval => interval.startedAt)) : 0;
  const last = finite.length ? Math.max(...finite.map(interval => interval.endedAt)) : 1;
  const span = Math.max(last - first, 1);
  const sessionBlock = sessionID => {
    const track = el('div', { class: 'timeline' });
    for (const interval of bySession.get(sessionID)) {
      if (interval.startedAt === null || interval.endedAt === null) continue;
      track.append(el('span', { class: `bar${interval.state === 'concluded' ? '' : ' bar-open'}`,
        style: `left:${(((interval.startedAt - first) / span) * 100).toFixed(3)}%;`
          + `width:${(Math.max((interval.endedAt - interval.startedAt) / span, 0.004) * 100).toFixed(3)}%` }));
    }
    const rows = bySession.get(sessionID).map(interval => el('li', {},
      `Intervalo: ${INTERVAL_STATE_LABELS[interval.state] ?? interval.state ?? 'desconocida'}`
      + ` · inicio: ${formatMs(interval.startedAt)} · fin: ${formatMs(interval.endedAt)}`
      + ` · transcurrido: ${interval.elapsedMs === null || interval.elapsedMs === undefined
        ? 'desconocido' : `${interval.elapsedMs} ms`}`
      + ` · procedencia: ${interval.durationSource ?? 'desconocida'}`
      + ` · evidencia: ${evidenceText(interval.evidence)}`));
    for (const wait of waits.filter(item => item.sessionID === sessionID)) {
      rows.push(el('li', {},
        `Espera de decisión externa (${wait.kind === 'permission' ? 'permiso' : 'pregunta'})`
        + ` · estado: ${wait.state === 'waiting-external-decision' ? 'esperando decisión externa' : wait.state ?? 'desconocido'}`
        + ` · inicio: ${formatMs(wait.startedAt)} · fin: ${formatMs(wait.endedAt)}`
        + ` · transcurrido: ${wait.elapsedMs === null || wait.elapsedMs === undefined
          ? 'desconocido' : `${wait.elapsedMs} ms`}`
        + ` · evidencia: ${evidenceText(wait.evidence)}`));
    }
    return el('li', {}, el('h5', {}, sessionLabel(execution, sessionID)), track, el('ul', {}, ...rows));
  };
  return el('section', { 'aria-label': 'Línea temporal' },
    el('h4', {}, 'Línea temporal'),
    el('p', { class: 'notice' },
      'Intervalos realmente observados, por sesión: pueden solaparse, no se suman ramas concurrentes como duración total y no hay orden causal global entre diarios. Las posiciones usan el reloj público del runtime, no una cronología causal.'),
    bySession.size
      ? el('ul', { class: 'timeline-sessions' }, ...[...bySession.keys()].map(sessionBlock))
      : el('p', { class: 'notice' }, 'Sin intervalos ni esperas observados en el alcance actual de la evidencia.'));
}

function renderTraceTools(execution, trace) {
  const attempts = trace.tools.attempts;
  const list = el('ul', {}, ...attempts.map(attempt => el('li', {},
    el('h5', {}, `Herramienta: ${attempt.toolName ?? 'nombre no observado'}`),
    el('p', {}, `Desenlace: ${OUTCOME_LABELS[attempt.outcome] ?? attempt.outcome ?? 'desconocido'}`),
    el('p', {}, `Identidad: sesión ${attempt.sessionID} · mensaje ${attempt.messageID ?? 'desconocido'} · llamada ${attempt.callID ?? 'desconocida'}`),
    el('p', {}, `Tiempos: inicio ${formatMs(attempt.startedAt)} · llamada ${formatMs(attempt.calledAt)} · fin ${formatMs(attempt.endedAt)}`),
    attempt.input !== null || attempt.inputText !== null
      ? el('details', {}, el('summary', {}, 'Entrada autorizada'),
        el('pre', {}, JSON.stringify(attempt.input ?? attempt.inputText, null, 2))) : null,
    attempt.output !== null && attempt.output !== undefined
      ? el('details', {}, el('summary', {}, 'Resultado autorizado'),
        el('pre', {}, JSON.stringify(attempt.output, null, 2))) : null,
    attempt.error ? el('p', { class: 'error' },
      `Error observado: ${attempt.error.type}: ${attempt.error.message}${attempt.error.status ? ` (HTTP ${attempt.error.status})` : ''}`) : null,
    el('p', { class: 'notice' },
      'Consumo: desconocido, no cero. No se agrupan reintentos por nombre, argumentos ni proximidad: este runtime no expone el enlace (retryOf y operationID desconocidos).'),
    attempt.incident ? el('p', {}, `Incidente: ${attempt.incident.kind} (causa desconocida)`) : null,
    el('p', {}, `Evidencia: ${evidenceText(attempt.evidence)}`),
    attempt.omissions?.length ? el('p', { class: 'notice' }, `Omisiones: ${attempt.omissions.join(', ')}`) : null)));
  return el('details', { 'aria-label': 'Herramientas e intentos' },
    el('summary', {}, `Herramientas e intentos · ${sessionLabel(execution, trace.selectedSessionID)}`),
    attempts.length ? list : el('p', { class: 'notice' }, 'Sin llamadas de herramienta observadas en la sesión seleccionada.'),
    el('p', { class: 'notice' },
      'La vista muestra las llamadas de la sesión seleccionada; para ver las de una subejecución, selecciónala en el árbol.'));
}

function renderTraceMetrics(trace) {
  const metrics = trace.metrics;
  const metricLine = (name, metric, note) => {
    if (!metric) return `${name}: desconocido`;
    const value = metric.value === null || metric.value === undefined ? 'desconocido'
      : name === 'Coste' ? `${metric.value} USD (estimación del runtime; no es una factura)` : JSON.stringify(metric.value);
    return `${name}: ${value} · estado: ${metric.status} · fuente: ${metric.source ?? 'ninguna'}`
      + ` · alcance: ${metric.scope ?? 'desconocido'}${note ? ` · ${note}` : ''}`;
  };
  const steps = el('ul', {}, ...metrics.steps.map(step => el('li', {},
    el('h5', {}, `Paso de modelo · sesión ${step.sessionID} · mensaje ${step.messageID ?? 'desconocido'}`),
    el('p', {}, `Modelo: ${step.model?.value ? `${step.model.value.providerID}/${step.model.value.id}` : 'desconocido'} (estado ${step.model?.status ?? 'unknown'})`),
    el('p', {}, metricLine('Tokens', step.tokens, 'valor normalizado que informa el runtime; no prueba el consumo original del proveedor')),
    el('p', {}, metricLine('Coste', step.costUSD, 'estimación; un coste cero no demuestra gratuidad')),
    el('p', {}, `Transcurrido: ${step.elapsedMs === null || step.elapsedMs === undefined ? 'desconocido' : `${step.elapsedMs} ms`} · desenlace: ${step.outcome ?? 'desconocido'}${step.finish ? ` · fin: ${step.finish}` : ''}`),
    step.dispatches?.length ? el('p', { class: 'notice' },
      `Despachos observados: ${step.dispatches.length} (${step.dispatches.map(dispatch => formatMs(dispatch.startedAt)).join(', ')}); no se atribuye consumo por proximidad.`) : null,
    step.retries?.length ? el('p', { class: 'notice' },
      `Reintentos de modelo observados: ${step.retries.length}; consumo y espera real por intento desconocidos.`) : null,
    step.omissions?.length ? el('p', { class: 'notice' }, `Omisiones: ${step.omissions.join(', ')}`) : null)));
  const measurements = el('ul', {}, ...metrics.measurements.map(item => el('li', {},
    `${item.kind ?? 'medición'} (${item.phase ?? 'fase desconocida'}) · sesión ${item.sessionID ?? 'desconocida'}`,
    el('p', {}, metricLine('Tokens', item.tokens, 'valor normalizado que informa el runtime')),
    el('p', {}, metricLine('Coste', item.costUSD, 'estimación; no es una factura')))));
  const pending = el('ul', {}, ...metrics.pendingInbox.map(item => el('li', {},
    `Admisión sin entrega observada · estado: ${item.state ?? 'desconocido'} · sesión ${item.sessionID} · mensaje ${item.messageID}`)));
  return el('details', { 'aria-label': 'Métricas' },
    el('summary', {}, 'Métricas con fuente y alcance'),
    metrics.steps.length ? steps : el('p', { class: 'notice' }, 'Sin pasos de modelo observados en el alcance.'),
    metrics.measurements.length ? measurements : null,
    metrics.pendingInbox.length ? pending : null,
    metrics.coverage ? el('p', { class: 'notice' },
      `La duración total del flujo no se expone (flowElapsedMs desconocido) y no se suman ramas concurrentes. Omisiones de métricas: ${(metrics.coverage.omissions ?? []).join(', ')}.`) : null,
    el('p', { class: 'notice' },
      'Un valor ausente permanece desconocido, nunca cero; el consumo es el valor normalizado de OpenCode y el coste una estimación, no una factura.'));
}

function renderTraceSkills(trace) {
  const skills = trace.skills;
  const provenance = item => el('p', { class: 'notice' },
    `Procedencia: ${item.source ? `fuente ${item.source} · ` : ''}${item.observationTime !== undefined
      ? `observada ${formatMs(item.observationTime)} · ` : ''}evidencia: ${evidenceText(item.evidence)}`);
  const observed = el('ul', {}, ...skills.observed.map(item => el('li', {},
    el('p', {}, `Skill observada: ${item.skill.name ?? item.skill.id ?? 'identidad no expuesta'}`),
    el('p', { class: 'notice' },
      `Origen: ${item.skill.origin === 'successful-skill-tool-result'
        ? 'resultado correcto de una llamada de skill' : 'evento público de activación del runtime'}`
      + ` · sesión ${item.sessionID} · mensaje ${item.messageID ?? 'desconocido'} · llamada ${item.callID ?? 'desconocida'}`),
    provenance(item),
    el('p', { class: 'notice' }, `SHA-256 del contenido filtrado: ${item.skill.sha256}`),
    el('details', {}, el('summary', {}, 'Contenido autorizado'), el('pre', {}, item.skill.text)))));
  const admitted = el('ul', {}, ...skills.admitted.map(item => el('li', {},
    `Skill admitida ${item.value?.id ?? 'desconocida'}${item.value?.name ? ` (${item.value.name})` : ''}`
    + ` · mensaje ${item.messageID ?? 'desconocido'} · la admisión no prueba despacho por el modelo`,
    provenance(item))));
  const available = el('ul', {}, ...skills.available.flatMap(observation =>
    (Array.isArray(observation.value) ? observation.value : []).map(skill => el('li', {},
      `${skill.id}${skill.name ? ` (${skill.name})` : ''}`, provenance(observation)))));
  const definitions = el('ul', {}, ...skills.definitions.map(item => el('li', {},
    el('p', {}, `Definición observada (${item.source}): ${item.value?.id ?? item.identity ?? 'identidad desconocida'}${item.value?.name ? ` (${item.value.name})` : ''}`),
    el('p', { class: 'notice' },
      `Leída después del hecho (${new Date(item.observationTime).toISOString()}); no es una foto histórica de ninguna activación.`
      + `${item.value?.path ? ` Ruta: ${item.value.path}.` : ''}`),
    provenance(item),
    item.value?.content !== undefined && item.value?.content !== null
      ? el('details', {}, el('summary', {}, 'Contenido autorizado'), el('pre', {}, item.value.content)) : null,
    item.omissions?.length ? el('p', { class: 'notice' }, `Omisiones: ${item.omissions.join(', ')}`) : null)));
  const environment = el('ul', {}, ...skills.environment.map(item => el('li', {},
    (Array.isArray(item.value?.plugins) ? item.value.plugins : []).map(plugin =>
      `${plugin.id} · fuente ${plugin.source} · versión ${plugin.version ?? 'desconocida'} · estado ${plugin.status}`).join(' · ')
    || 'Sin plugins observados')));
  return el('details', { 'aria-label': 'Skills y definiciones' },
    el('summary', {}, 'Skills y definiciones'),
    el('section', { 'aria-label': 'Skills observadas' },
      el('h5', {}, 'Skills observadas (activación o carga efectiva)'),
      skills.observed.length ? observed : el('p', { class: 'notice' }, 'Ninguna skill fue observada en uso.')),
    skills.admitted.length ? el('section', { 'aria-label': 'Skills admitidas' },
      el('h5', {}, 'Skills admitidas con el encargo'), admitted) : null,
    el('section', { 'aria-label': 'Skills disponibles' },
      el('h5', {}, 'Skills disponibles (disponibilidad; no prueba uso)'),
      skills.available.length ? available : el('p', { class: 'notice' }, 'Sin observaciones de disponibilidad.'),
      el('p', { class: 'notice' },
        'Disponibilidad observada en un punto del hook; no garantiza selección final, permisos ni activación de las skills disponibles.')),
    el('section', { 'aria-label': 'Definiciones observadas' },
      el('h5', {}, 'Definiciones observadas'),
      skills.definitions.length ? definitions : el('p', { class: 'notice' }, 'Sin definiciones observadas.')),
    el('section', { 'aria-label': 'Entorno de plugins' },
      el('h5', {}, 'Entorno de plugins (disponibilidad instalada)'),
      skills.environment.length ? environment : el('p', { class: 'notice' }, 'Sin observaciones de entorno.'),
      el('p', { class: 'notice' },
        'El listado no atribuye cada transformación a su autor, orden ni versión local; esos datos quedan desconocidos.')));
}

function renderTraceCoverage(trace) {
  const coverage = trace.captureDiagnostics;
  if (!coverage) return el('section', { 'aria-label': 'Cobertura de captura' },
    el('h4', {}, 'Diagnóstico técnico y cobertura de captura'),
    el('p', { class: 'notice' }, 'Sin diagnóstico de cobertura disponible.'));
  const declarations = el('ul', {}, ...(coverage.declarations ?? []).map(declaration => el('li', {},
    `runtime ${declaration.runtimeVersion} · SDK ${declaration.sdkVersion ?? 'desconocida'}`
    + ` · registrador ${declaration.recorderVersion ?? 'desconocida'} · orden ${declaration.coverage?.ordering ?? 'desconocido'}`)));
  const observed = el('ul', {}, ...(coverage.observed ?? []).map(shape => el('li', {},
    `${shape.type}${shape.stage ? ` · ${shape.stage}` : ''}${shape.status ? ` · ${shape.status}` : ''} × ${shape.count}`)));
  const omissions = el('ul', {}, ...(coverage.omissions ?? []).map(omission => el('li', {}, omission)));
  const diagnostics = el('ul', {}, ...(coverage.diagnostics ?? []).map(row => el('li', {},
    `${row.type}: ${row.reason ?? 'sin motivo'} · ${row.captureID} · fila ${row.arrival}`
    + `${row.sessionID ? ` · sesión ${row.sessionID}` : ' · sesión no identificada'}`)));
  const horizons = el('ul', {}, ...(coverage.horizons ?? []).map(horizon => el('li', {},
    `${horizon.captureID} · hasta la fila ${horizon.arrival} · ${new Date(horizon.observedAt).toISOString()}`)));
  return el('section', { 'aria-label': 'Cobertura de captura y diagnósticos' },
    el('h4', {}, 'Diagnóstico técnico y cobertura de captura'),
    el('p', {}, `Disposición: sin evaluar (readiness: ${coverage.readiness}).`),
    el('p', { class: 'notice' },
      'Los diagnósticos técnicos y la cobertura de captura no son una evaluación: la ausencia de incidentes no equivale a una aceptación ni acredita el piloto.'),
    el('p', {}, `Sesiones con evidencia en el alcance: ${coverage.sessions?.length ? coverage.sessions.join(', ') : 'ninguna'}`),
    el('h5', {}, 'Declaraciones de preparación'),
    (coverage.declarations?.length ?? 0) ? declarations : el('p', { class: 'notice' }, 'Sin declaraciones de preparación en el alcance.'),
    el('details', {}, el('summary', {}, 'Tipos y etapas observados'), observed),
    el('details', {}, el('summary', {}, 'Omisiones observadas'),
      (coverage.omissions?.length ?? 0) ? omissions : el('p', { class: 'notice' }, 'Sin omisiones registradas.')),
    el('details', {}, el('summary', {}, 'Diagnósticos del registrador en el alcance'),
      (coverage.diagnostics?.length ?? 0) ? diagnostics : el('p', { class: 'notice' }, 'Sin fallos ni lagunas registrados.')),
    el('details', {}, el('summary', {}, 'Horizonte de lectura por diario'),
      el('p', { class: 'notice' }, 'El horizonte global de la traza es el máximo observado entre los diarios del alcance, no un corte común; los horizontes de cada diario figuran aquí.'),
      horizons));
}

function renderDeliverableItem(group, item) {
  const value = item.value;
  const rows = [
    el('p', {}, `Ruta: ${value?.path ?? 'no expuesta o no admitida'}`),
    el('p', {}, `Papel: ${value ? DELIVERABLE_ROLE_LABELS[value.role] ?? value.role : 'desconocido'}`
      + ` (procedencia del papel: ${value?.roleSource ?? 'desconocida'})`),
    el('p', {}, `Adquisición: ${DELIVERABLE_ACQUISITION_LABELS[value?.acquisition] ?? value?.acquisition ?? 'desconocida'}`),
    el('p', { class: 'notice' }, `Fuente: ${item.source ?? 'desconocida'} · mensaje ${item.messageID ?? 'desconocido'}`
      + ` · llamada ${value?.callID ?? 'no expuesta'} · evidencia: ${evidenceText(item.evidence)}`),
    el('p', { class: 'notice' }, `Momentos: frontera ${formatMs(value?.sourceTime ?? null)}`
      + ` (${value?.sourceTimeBasis ?? 'base desconocida'}) · observación ${formatMs(item.observationTime)}`),
    el('p', { class: 'notice' }, `SHA-256 (${item.hashBasis ?? 'base desconocida'}): ${item.sha256 ?? 'no disponible'}`),
  ];
  if (item.status !== 'captured') {
    rows.push(el('p', { class: 'notice' },
      'Proyección no reconocida: la captura conservó el registro, pero no contenido, forma ni hash; no se reconstruye contenido no capturado.'));
  } else if (value.content === null) {
    rows.push(el('p', { class: 'notice' },
      'Contenido no adquirido: la captura conserva la referencia y su motivo, no unos bytes ni una versión.'));
  } else {
    rows.push(el('details', {}, el('summary', {}, 'Contenido conservado (filtrado)'),
      el('pre', {}, value.content)));
    if (value.acquisition === 'post-event-file-read') {
      rows.push(el('p', { class: 'notice' },
        'Lectura posterior al hecho: no acredita qué bytes produjo o utilizó la acción original.'));
    }
    if (value.acquisition === 'runtime-content') {
      rows.push(el('p', { class: 'notice' },
        'Contenido observado del propio evento del runtime, no una lectura del archivo actual.'));
    }
  }
  if (item.omissions?.length) rows.push(el('p', { class: 'notice' }, `Omisiones: ${item.omissions.join(', ')}`));
  if (item.redactions?.length) rows.push(el('p', { class: 'notice' }, `Filtrados: ${item.redactions.join(', ')}`));
  return el('li', { 'data-session': group.sessionID }, ...rows);
}

function renderDeliverables(execution) {
  const head = el('h3', {}, 'Resultados y entregables');
  const wrap = children => [el('section', { id: 'deliverables', 'aria-label': 'Resultados y entregables' },
    head, ...children)];
  const body = state.deliverables;
  if (!body) return wrap([
    el('p', { class: 'notice' }, 'Consultando las respuestas autorizadas y los snapshots conservados en la captura…')]);
  if (!body.readable) return wrap([
    el('p', { class: 'notice' },
      `Los entregables no están consultables (${body.reason ?? 'desconocido'}); no se reconstruye contenido no capturado.`)]);
  const groups = body.sessions.map(group => el('li', { 'data-session': group.sessionID },
    el('h4', {}, sessionLabel(execution, group.sessionID)),
    el('p', { class: 'notice' }, `Respuestas autorizadas: ${group.responses.length
      ? group.responses.map(response => response.text).join(' | ') : 'ninguna observada en la captura'}`),
    el('p', {}, `Snapshots conservados: ${group.deliverables.length}`),
    ...group.deliverables.length
      ? [el('ul', {}, ...group.deliverables.map(item => renderDeliverableItem(group, item)))]
      : [el('p', { class: 'notice' },
        'Sin entregables capturados para esta sesión; la ausencia no acredita que no existieran archivos en el proyecto.')]));
  return wrap([
    el('p', { class: 'notice' },
      'Se consulta la versión conservada en la captura, no el archivo actual: cambiar o eliminar el original no altera lo mostrado. La app no recorre el proyecto ni abre sus archivos.'),
    el('p', { class: 'notice' },
      'Cada snapshot conserva contenido filtrado, procedencia, momento y hash de la proyección conservada. La finalidad global no está acreditada: un papel de salida en una herramienta no acredita que este contenido sea el resultado final del flujo.'),
    body.query?.mode === 'selected-session'
      ? el('p', { class: 'notice' },
        `Consulta de una sola sesión (${body.selectedSessionID}): no incluye los entregables de sus descendientes.`)
      : el('p', { class: 'notice' },
        'Vista de conjunto: reúne explícitamente las sesiones conocidas del árbol acreditado, consultadas una a una; una consulta de raíz no incluye descendientes.'),
    ...['failed', 'interrupted'].includes(execution.status)
      ? [el('p', { class: 'notice' },
        'Resultados parciales de una ejecución fallida o interrumpida: consultarlos no equivale a éxito ni a aceptación.')]
      : [],
    el('ul', { class: 'deliverable-sessions' }, ...groups),
  ]);
}

function traceSection() {
  const detail = state.detail;
  const execution = detail?.execution;
  if (!execution) return [];
  const head = el('h3', {}, 'Traza y diagnóstico técnico');
  const trace = state.trace;
  if (!trace) return [el('section', { id: 'trace' }, head,
    el('p', { class: 'notice' }, 'Consultando la traza y el diagnóstico técnico en la captura…'))];
  if (!trace.readable) return [el('section', { id: 'trace' }, head,
    el('p', { class: 'notice' },
      `La traza no está consultable (${trace.reason ?? 'desconocido'}); no se reconstruye contenido no capturado.`))];
  return [el('section', { id: 'trace' }, head,
    el('p', { class: 'notice' },
      'Proyección conservadora del lector independiente sobre la captura autorizada: árbol, línea temporal, herramientas, métricas, skills y cobertura tal como fueron observados, sin rellenar datos desconocidos.'),
    renderTraceTree(execution, trace),
    renderTimeline(execution, trace),
    renderTraceTools(execution, trace),
    renderTraceMetrics(trace),
    renderTraceSkills(trace),
    renderTraceCoverage(trace))];
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
      ? execution.requestedCommand.name
      : 'encargo directo sin comando'));
  const panel = [
    el('h2', {}, `Ejecución ${execution.id.slice(0, 8)}`),
    el('p', { id: 'execution-status' }, `Estado: ${STATUS_LABELS[execution.status] ?? execution.status}`),
    el('p', { class: 'dispatch' }, DISPATCH_LABELS[execution.dispatch] ?? DISPATCH_LABELS.unconfirmed),
    renderMessages(),
    ...renderDeliverables(execution),
    ...renderInteractions(),
    ...renderStop(execution),
    ...traceSection(),
    el('dl', { class: 'identity' },
      el('dt', {}, 'Ejecución'), el('dd', {}, execution.id),
      ...selectionRows,
      el('dt', {}, 'Sesión raíz'), el('dd', {}, execution.sessionID ?? 'sin sesión confirmada'),
      el('dt', {}, 'Capturas'), el('dd', {}, capture?.readable
        ? (capture.captureIDs.length ? capture.captureIDs.join(', ') : 'sin filas de captura de esta ejecución')
        : `no consultable: ${capture?.reason ?? 'desconocido'}`),
      el('dt', {}, 'Alcance de evidencia'), el('dd', {}, capture?.readable
        ? `Árbol de sesiones observado: ${capture.scope.sessionIDs.join(', ')}` : 'desconocido'),
      el('dt', {}, 'Evidencia hasta (máximo observado)'), el('dd', {}, capture?.readable
        ? `${capture.horizon ?? 'sin eventos observados'} · máximo observado en el árbol; los horizontes por diario están en la cobertura`
        : 'horizonte desconocido')),
    el('p', { class: 'notice' }, 'Este corte permite un único envío inicial por ejecución; no hay cierre manual.'),
  ];
  if (state.health?.engine?.reachable === false && !TERMINAL.includes(execution.status)) {
    panel.splice(2, 0, el('p', { id: 'engine-offline', class: 'notice' },
      'Motor no disponible: desenlace pendiente de comprobar; el encargo no se reenviará.'));
  }
  const recorder = detail.recorder;
  const recorderFailed = capture?.recorderFailed
    || (recorder?.readable === true && recorder.status === 'failed');
  if (recorderFailed) {
    const captureState = capture?.readable
      ? (capture.recorderFailed ? 'fallo del registrador declarado en la captura' : 'consultable')
      : `no consultable (${capture?.reason ?? 'desconocido'})`;
    panel.splice(2, 0, el('section', { id: 'recorder-failure', role: 'alert', 'aria-label': 'Fallo del registrador', class: 'error' },
      el('h3', {}, 'Fallo del registrador'),
      el('p', {}, `Aviso: revisar antes de volver a ejecutar. Estado de captura: ${captureState}.`),
      el('p', {}, `${recorder?.readable === true && recorder.reviewRequired === false
        ? 'Revisión no declarada como requerida por el motor.' : 'Revisión requerida según la evidencia pública del motor.'} Se conserva el bloqueo durable de la captura: no hay desbloqueo automático, ni por recargar ni por reparar la ruta.`),
      recorder?.readable === true && recorder.notice ? el('p', { class: 'notice' }, recorder.notice) : null,
      recorder?.readable === true && recorder.interruption
        ? el('p', { class: 'notice' }, `Interrupción: ${recorder.interruption.requested ? 'solicitada' : 'no solicitada'}, detención ${
          recorder.interruption.stop === 'confirmed' ? 'confirmada' : 'no confirmada'}.`) : null,
      recorder?.readable === true && recorder.reason
        ? el('p', { class: 'notice' }, `Motivo público declarado: ${recorder.reason}.`) : null));
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
      state.interactionError = null;
      state.interactionAnswers = {};
      state.stopError = null;
      state.stopRequest = null;
      state.trace = null;
      state.selectedSession = null;
      state.deliverables = null;
      renderConversation();
      refreshDetail();
      refreshTrace();
      refreshDeliverables();
    });
    historyList.append(el('li', {}, button));
  }
}

document.querySelector('#new-chat').addEventListener('click', () => {
  state.selected = null;
  state.detail = null;
  state.error = null;
  state.interactionError = null;
  state.interactionAnswers = {};
  state.stopError = null;
  state.stopRequest = null;
  state.trace = null;
  state.selectedSession = null;
  state.deliverables = null;
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
  } else {
    await Promise.allSettled([refreshDetail(), refreshTrace(), refreshDeliverables()]);
    renderConversation();
  }
}

renderConversation();
renderHistory();
tick();
setInterval(tick, 1500);
