import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  });

  const releaseIfHeld = execution => {
    if (locks.get(execution.project) === execution.id) locks.delete(execution.project);
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
    let prompt;
    try {
      await exclusive(() => store.update(execution, { dispatch: 'possibly-sent' }));
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
    if (url.pathname === '/api/executions' && request.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(request)); }
      catch { return json(response, 400, { error: 'invalid-json' }); }
      if (typeof body?.requestKey !== 'string' || body.requestKey.length < 1 || body.requestKey.length > 200
        || typeof body?.text !== 'string' || body.text.length < 1 || body.text.length > 20000) {
        return json(response, 400, { error: 'invalid-request' });
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
      if (!closing) dispatch(execution, body.text).catch(error => console.error('App dispatch state could not be persisted:', error));
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
