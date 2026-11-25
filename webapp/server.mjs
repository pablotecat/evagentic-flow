import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createEngine } from './engine.mjs';
import { createStore, isTerminal } from './store.mjs';
import { latestLifecycle, readRows, readSession } from './evidence.mjs';

const TERMINAL_PHASES = ['succeeded', 'failed', 'interrupted'];
const CONFIG_KEYS = ['version', 'opencodeURL', 'opencodePassword', 'projectDirectory', 'captureDirectory', 'dataDirectory'];
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const root = dirname(fileURLToPath(import.meta.url));

export async function loadAppConfig(filename) {
  let config;
  try { config = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new Error('App: cannot read local configuration.'); }
  const invalid = message => { throw new Error(`App: invalid local configuration: ${message}`); };
  if (config?.version !== 1) invalid('version must be 1');
  for (const key of CONFIG_KEYS) {
    if (key !== 'version' && typeof config[key] !== 'string') invalid(`${key} must be a string`);
  }
  if (Object.keys(config).some(key => !CONFIG_KEYS.includes(key))) invalid('unknown keys');
  for (const key of ['projectDirectory', 'captureDirectory', 'dataDirectory']) {
    if (!isAbsolute(config[key])) invalid(`${key} must be absolute`);
  }
  if (!/^[a-z]+:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(config.opencodeURL)) {
    invalid('opencodeURL must target loopback');
  }
  return { ...config, projectKey: await realpath(config.projectDirectory) };
}

export async function startApp({ configPath, port: requestedPort }) {
  const config = await loadAppConfig(configPath);
  const engine = createEngine({ baseURL: config.opencodeURL, password: config.opencodePassword });
  const store = createStore(config.dataDirectory);
  await store.load();
  const locks = new Map();
  for (const execution of store.list()) if (!isTerminal(execution)) locks.set(execution.project, execution.id);
  const lifecycle = new AbortController();
  let closing = false;
  let closed = false;
  let port;
  let operations = Promise.resolve();
  const exclusive = task => {
    const pending = operations.then(task);
    operations = pending.catch(() => {});
    return pending;
  };

  const modelName = (model, variant) => `${model.name}${variant ? ` #${variant}` : ''}`;
  const modelValue = (providerID, modelID, variant) => `${providerID}/${modelID}`
    + `${variant && variant !== 'default' ? `#${variant}` : ''}`;
  const publicModel = model => (model ? {
    value: modelValue(model.providerID, model.modelID ?? model.id, model.variant),
    providerID: model.providerID,
    modelID: model.modelID ?? model.id,
    variant: model.variant ?? null,
  } : null);

  const publicOptions = options => ({
    agents: options.agents.map(agent => ({ id: agent.id, name: agent.name, description: agent.description ?? null, mode: agent.mode })),
    models: options.models.flatMap(model => (model.variants?.length ? model.variants : [undefined]).map(variant => ({
      value: modelValue(model.providerID, model.modelID ?? model.id, variant?.id),
      name: modelName(model, variant?.id),
      providerID: model.providerID,
      modelID: model.modelID ?? model.id,
      variant: variant?.id ?? null,
    }))),
    commands: options.commands.map(command => ({ name: command.name, description: command.description ?? null })),
  });

  const publicExecution = execution => ({
    id: execution.id,
    requestKey: execution.requestKey,
    project: execution.project,
    status: execution.status,
    dispatch: execution.dispatch,
    createdAt: execution.createdAt,
    dispatchedAt: execution.dispatchedAt,
    finishedAt: execution.finishedAt,
    sessionID: execution.sessionID,
    promptMessageID: execution.promptMessageID,
    requestedAgent: execution.requestedAgent ?? null,
    requestedModel: execution.requestedModel ?? null,
    requestedCommand: execution.requestedCommand ?? null,
    knownAgent: execution.knownAgent ?? null,
    knownAgentSource: execution.knownAgentSource ?? null,
    knownModel: publicModel(execution.knownModel),
    knownModelSource: execution.knownModelSource ?? null,
    selectionObservedAt: execution.selectionObservedAt ?? null,
  });

  const releaseIfHeld = execution => {
    if (locks.get(execution.project) === execution.id) locks.delete(execution.project);
  };

  const observeSelection = async (execution, sessionID) => {
    const deadline = Date.now() + 5000;
    let knownAgent = null;
    let knownModel = null;
    while (Date.now() < deadline && !lifecycle.signal.aborted) {
      try {
        const [session, messages] = await Promise.all([engine.session(sessionID, lifecycle.signal),
          engine.messages(sessionID, lifecycle.signal)]);
        const switched = messages.filter(message => message.type === 'agent-switched')
          .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0];
        knownAgent = session?.agent ?? switched?.agent ?? null;
        knownModel = session?.model ?? null;
        const agentReady = !execution.requestedAgent || knownAgent === execution.requestedAgent;
        const modelReady = !execution.requestedModel
          || (knownModel && publicModel(knownModel)?.value === execution.requestedModel);
        if (agentReady && modelReady) break;
      } catch { }
      await delay(250);
    }
    try {
      await exclusive(() => store.update(execution, { knownAgent, knownAgentSource: knownAgent ? 'public-session' : null,
        knownModel, knownModelSource: knownModel ? 'public-session' : null, selectionObservedAt: Date.now() }));
    } catch { }
  };

  const dispatch = async (execution, text) => {
    let session;
    try {
      session = await engine.createSession({ location: { directory: config.projectDirectory },
        title: `Flujo en Proyecto · ${execution.id.slice(0, 8)}` }, lifecycle.signal);
      if (!session?.id) return;
      await exclusive(() => store.update(execution, { sessionID: session.id, dispatch: 'session-confirmed' }));
    } catch {
      return;
    }
    const failClosed = async dispatchReason => {
      await exclusive(async () => {
        if (isTerminal(execution) || execution.dispatch === 'admitted') return;
        await store.update(execution, { status: 'failed', dispatch: dispatchReason, finishedAt: Date.now() });
        releaseIfHeld(execution);
      });
    };
    if (execution.requestedAgent || execution.requestedModel || execution.requestedCommand) {
      let listed;
      try { listed = publicOptions(await engine.options(config.projectDirectory, lifecycle.signal)); }
      catch { return; }
      const missingAgent = execution.requestedAgent
        && !listed.agents.some(agent => agent.id === execution.requestedAgent);
      const modelEntry = execution.requestedModel
        ? listed.models.find(model => model.value === execution.requestedModel) : null;
      const missingCommand = execution.requestedCommand
        && !listed.commands.some(command => command.name === execution.requestedCommand.name);
      if (missingAgent || missingCommand || (execution.requestedModel && !modelEntry)) {
        return failClosed('selection-unavailable');
      }
      if (execution.requestedAgent) {
        try {
          const result = await engine.setAgent(session.id, execution.requestedAgent, lifecycle.signal);
          if (!result.ok) return failClosed('selection-unavailable');
        } catch { return; }
      }
      if (execution.requestedModel) {
        try {
          const result = await engine.setModel(session.id, {
            id: modelEntry.modelID, providerID: modelEntry.providerID,
            ...(modelEntry.variant ? { variant: modelEntry.variant } : {}),
          }, lifecycle.signal);
          if (!result.ok) return failClosed('selection-unavailable');
        } catch { return; }
      }
      await observeSelection(execution, session.id);
    }
    let prompt = null;
    try {
      await exclusive(() => store.update(execution, { dispatch: 'possibly-sent' }));
      if (execution.requestedCommand) {
        const result = await engine.runCommand(session.id, execution.requestedCommand.name,
          execution.requestedCommand.arguments, lifecycle.signal);
        if (result.status === 404) return await failClosed('command-unavailable');
        return;
      }
      prompt = await engine.prompt(session.id, text, lifecycle.signal);
    }
    catch { prompt = null; }
    if (prompt?.id && !lifecycle.signal.aborted) {
      await exclusive(() => {
        if (isTerminal(execution) || execution.dispatch === 'admitted') return;
        return store.update(execution, { dispatch: 'admitted', status: 'running',
          promptMessageID: prompt.id, dispatchedAt: Date.now() });
      });
    }
  };

  const reconcile = async execution => {
    if (store.failed() || isTerminal(execution) || !execution.sessionID) return;
    const evidence = await readSession(config.captureDirectory, execution.sessionID);
    if (!evidence.ok) return;
    if (evidence.admission && execution.dispatch !== 'admitted') {
      await store.update(execution, { dispatch: 'admitted', status: 'running',
        promptMessageID: evidence.admission.messageID, dispatchedAt: evidence.admission.observedAt });
    }
    const phase = latestLifecycle(evidence.rows.filter(row => row.sessionID === execution.sessionID));
    if (!TERMINAL_PHASES.includes(phase) || !evidence.admission || evidence.recorderFailed) return;
    const knownIDs = new Set(evidence.scope.sessionIDs);
    let scope;
    try { scope = await engine.scope(config.projectDirectory, execution.sessionID, knownIDs); }
    catch { return; }
    if (!scope.clear) return;
    for (const sessionID of scope.sessionIDs) {
      const rows = evidence.rows.filter(row => row.sessionID === sessionID);
      if (!TERMINAL_PHASES.includes(latestLifecycle(rows))) return;
      const pending = new Set();
      for (const row of rows.sort((a, b) => (a.sourceSequence ?? 0) - (b.sourceSequence ?? 0))) {
        if (!row.interaction?.requestID) continue;
        const key = `${row.interaction.kind}:${row.interaction.requestID}`;
        if (row.interaction.phase === 'requested') pending.add(key);
        else pending.delete(key);
      }
      if (pending.size) return;
    }
    await store.update(execution, { status: phase, finishedAt: Date.now() });
    releaseIfHeld(execution);
  };

  const json = (response, code, body) => {
    response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(body));
  };

  const readBody = request => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 100000) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

  const allowed = request => {
    const host = request.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
    const origin = request.headers.origin;
    return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  };

  async function handle(request, response) {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (!allowed(request)) return json(response, 403, { error: 'origin-not-allowed' });
    if (request.method === 'GET' && STATIC.has(url.pathname)) {
      const [file, type] = STATIC.get(url.pathname);
      response.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
      response.end(await readFile(join(root, 'public', file)));
      return;
    }
    if (url.pathname === '/api/health' && request.method === 'GET') {
      const read = await readRows(config.captureDirectory, null).catch(error => ({ ok: false, reason: error.message }));
      const engineHealth = await engine.info();
      let capture;
      if (!read.ok) capture = { status: 'unavailable', reason: read.reason };
      else {
        const declarations = read.rows.filter(row => row.type === 'recorder.ready' || row.type === 'recorder.failed');
        const latest = declarations.reduce((best, row) => best === null || row.observedAt >= best.observedAt ? row : best, null);
        capture = { status: latest === null ? 'no-evidence' : latest.type === 'recorder.failed' ? 'failed' : 'prepared' };
      }
      return json(response, 200, {
        engine: engineHealth.ok ? { reachable: true, version: engineHealth.data?.version ?? null }
          : { reachable: false, version: null },
        capture,
        index: { status: store.failed() ? 'review-required' : 'available' },
      });
    }
    if (url.pathname === '/api/options' && request.method === 'GET') {
      const health = await engine.info();
      if (!health.ok) {
        return json(response, 200, { state: 'engine-unreachable', engine: { reachable: false, version: null },
          agents: null, models: null, commands: null });
      }
      try {
        const listed = publicOptions(await engine.options(config.projectDirectory));
        return json(response, 200, { state: 'ready', engine: { reachable: true,
          version: health.data?.version ?? null }, ...listed });
      } catch {
        return json(response, 200, { state: 'unavailable', engine: { reachable: true, version: null },
          agents: null, models: null, commands: null });
      }
    }
    if (url.pathname === '/api/executions' && request.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(request)); }
      catch { return json(response, 400, { error: 'invalid-json' }); }
      const text = typeof body?.text === 'string' ? body.text : null;
      const hasCommandField = body?.command !== undefined && body?.command !== null;
      const command = hasCommandField && typeof body.command === 'object'
        && typeof body.command.name === 'string' && typeof body.command.arguments === 'string' ? body.command : null;
      const agent = typeof body?.agent === 'string' ? body.agent : null;
      const model = typeof body?.model === 'string' ? body.model : null;
      const validCommand = command && command.name.length >= 1 && command.name.length <= 100
        && command.arguments.length >= 0 && command.arguments.length <= 20000;
      const validSelections = (agent === null || (agent.length >= 1 && agent.length <= 100))
        && (model === null || (model.length >= 1 && model.length <= 150));
      const validRequest = typeof body?.requestKey === 'string' && body.requestKey.length >= 1
        && body.requestKey.length <= 200 && (text !== null) !== (command !== null)
        && (!hasCommandField || validCommand)
        && (text === null || (text.length >= 1 && text.length <= 20000))
        && validSelections;
      if (!validRequest) {
        return json(response, 400, { error: 'invalid-request' });
      }
      if (agent || model || command) {
        const health = await engine.info();
        if (health.ok) {
          let listed;
          try { listed = publicOptions(await engine.options(config.projectDirectory)); }
          catch { return json(response, 503, { error: 'options-unavailable' }); }
          if (agent && !listed.agents.some(entry => entry.id === agent)) {
            return json(response, 422, { error: 'selection-unavailable', kind: 'agent', option: agent });
          }
          if (model && !listed.models.some(entry => entry.value === model)) {
            return json(response, 422, { error: 'selection-unavailable', kind: 'model', option: model });
          }
          if (command && !listed.commands.some(entry => entry.name === command.name)) {
            return json(response, 422, { error: 'selection-unavailable', kind: 'command', option: command.name });
          }
        }
      }
      const existing = store.byKey(body.requestKey);
      if (existing) {
        await reconcile(existing);
        return json(response, 200, { execution: publicExecution(existing) });
      }
      if (store.failed()) return json(response, 503, { error: 'index-review-required' });
      if (locks.has(config.projectKey)) {
        const owned = store.byId(locks.get(config.projectKey));
        if (owned) await reconcile(owned);
      }
      if (locks.has(config.projectKey)) {
        const owned = store.byId(locks.get(config.projectKey));
        return json(response, 409, { error: 'project-busy', execution: owned ? publicExecution(owned) : null });
      }
      const execution = {
        id: randomUUID(),
        requestKey: body.requestKey,
        project: config.projectKey,
        createdAt: Date.now(),
        status: 'pending',
        dispatch: 'unconfirmed',
        sessionID: null,
        promptMessageID: null,
        dispatchedAt: null,
        finishedAt: null,
        requestedAgent: agent,
        requestedModel: model,
        requestedCommand: command,
        knownAgent: null,
        knownAgentSource: null,
        knownModel: null,
        knownModelSource: null,
        selectionObservedAt: null,
      };
      locks.set(config.projectKey, execution.id);
      try {
        store.add(execution);
        await store.save();
      } catch (error) {
        if (locks.get(config.projectKey) === execution.id) locks.delete(config.projectKey);
        store.remove(execution);
        throw error;
      }
      if (!closing) dispatch(execution, text).catch(error => console.error('App dispatch state could not be persisted:', error));
      return json(response, 201, { execution: publicExecution(execution) });
    }
    if (url.pathname === '/api/executions' && request.method === 'GET') {
      for (const execution of store.list()) await reconcile(execution);
      const executions = store.list().sort((a, b) => b.createdAt - a.createdAt).map(publicExecution);
      return json(response, 200, { executions });
    }
    const detail = url.pathname.match(/^\/api\/executions\/([^/]+)$/);
    if (detail && request.method === 'GET') {
      const execution = store.byId(detail[1]);
      if (!execution) return json(response, 404, { error: 'unknown-execution' });
      await reconcile(execution);
      const evidence = execution.sessionID
        ? await readSession(config.captureDirectory, execution.sessionID) : null;
      return json(response, 200, {
        execution: publicExecution(execution),
        conversation: evidence?.ok ? { entries: evidence.entries, responses: evidence.responses }
          : { entries: [], responses: [] },
        capture: evidence?.ok
          ? { readable: true, captureIDs: evidence.captureIDs, recorderFailed: evidence.recorderFailed,
            horizon: evidence.horizon, scope: evidence.scope, gaps: evidence.gaps, omissions: evidence.omissions }
          : { readable: false, reason: evidence?.reason ?? 'session-not-confirmed',
            captureIDs: [], recorderFailed: false, horizon: null },
      });
    }
    return json(response, 404, { error: 'not-found' });
  }

  const server = createServer((request, response) => {
    exclusive(() => handle(request, response)).catch(error => {
      console.error(error);
      if (!response.headersSent) json(response, 500, { error: 'internal' });
      else response.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort ?? 0, '127.0.0.1', resolve);
  });
  port = server.address().port;

  const close = async () => {
    if (closed) return;
    closed = true;
    closing = true;
    lifecycle.abort();
    await new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await operations;
    await store.close();
  };

  return { url: `http://127.0.0.1:${port}`, port, close, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = process.argv[2] ?? process.env.EVAGENTIC_APP_CONFIG;
  if (!configPath || !isAbsolute(configPath)) {
    console.error('Usage: node webapp/server.mjs <absolute-config-path> (or EVAGENTIC_APP_CONFIG)');
    process.exitCode = 1;
  } else {
    const app = await startApp({ configPath });
    console.log(app.url);
  }
}
