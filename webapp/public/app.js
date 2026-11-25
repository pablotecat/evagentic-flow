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
  'session-not-confirmed': 'Todavía no hay sesión confirmada para detener; no se ha interrumpido nada.',
  unknown: 'No se pudo procesar la detención; el desenlace queda sin confirmar y el encargo no se reenvía.',
};

const STOP_REQUEST_LABELS = {
  accepted: 'aceptada',
  'not-running': 'sesión no activa',
  error: 'fallo de la solicitud',
  'already-interrupted': 'interrumpida antes de esta solicitud',
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
      ? execution.requestedCommand.name
      : 'encargo directo sin comando'));
  const panel = [
    el('h2', {}, `Ejecución ${execution.id.slice(0, 8)}`),
    el('p', { id: 'execution-status' }, `Estado: ${STATUS_LABELS[execution.status] ?? execution.status}`),
    el('p', { class: 'dispatch' }, DISPATCH_LABELS[execution.dispatch] ?? DISPATCH_LABELS.unconfirmed),
    renderMessages(),
    ...renderInteractions(),
    ...renderStop(execution),
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
      el('p', {}, 'Revisión requerida según la evidencia pública del motor. Se conserva el bloqueo durable de la captura: no hay desbloqueo automático, ni por recargar ni por reparar la ruta.'),
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
  state.interactionError = null;
  state.interactionAnswers = {};
  state.stopError = null;
  state.stopRequest = null;
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
