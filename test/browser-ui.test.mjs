import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startApp } from '../webapp/server.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'webapp', 'dist');

const jsonResponse = (body, status = 200) => ({ status, contentType: 'application/json',
  body: JSON.stringify(body) });

const execution = (id, overrides = {}) => ({
  id,
  requestKey: `synthetic-key-${id}`,
  project: 'synthetic-project',
  status: 'succeeded',
  dispatch: 'admitted',
  createdAt: Date.now() - 60000,
  dispatchedAt: null,
  finishedAt: null,
  sessionID: `ses_${id.slice(0, 8)}`,
  promptMessageID: null,
  requestedAgent: null,
  requestedModel: null,
  requestedCommand: null,
  knownAgent: null,
  knownAgentSource: null,
  knownModel: null,
  knownModelSource: null,
  selectionObservedAt: null,
  stop: { requested: false, requestedAt: null },
  ...overrides,
});

const detail = id => ({
  execution: execution(id),
  recorder: { readable: true, status: null, reason: null, reviewRequired: false,
    pilotReady: true, interruption: null, source: 'public-session-metadata' },
  conversation: { entries: [{ text: 'Encargo sintético de la interfaz.' }],
    responses: [{ text: 'Respuesta autorizada sintética.' }] },
  capture: { readable: true, captureIDs: ['cap-synthetic'], recorderFailed: false, horizon: null,
    scope: { sessionIDs: [`ses_${id.slice(0, 8)}`] }, gaps: [], omissions: [] },
  interactions: { pending: [], resolved: [], readErrors: [] },
  stop: { requested: false },
});

const healthy = {
  engine: { reachable: true, version: '2.1.2-synthetic' },
  capture: { status: 'prepared' },
  index: { status: 'available' },
};

const readyOptions = {
  state: 'ready',
  engine: { reachable: true, version: '2.1.2-synthetic' },
  agents: [{ id: 'build', name: 'Agente sintético', description: null, mode: 'subagent' },
    { id: 'generalist', name: 'Agente general', description: null, mode: 'primary' }],
  models: [{ value: 'synthetic/model-a', name: 'Modelo sintético A', providerID: 'synthetic',
    modelID: 'model-a', variant: null }],
  commands: [{ name: 'verificar', description: 'Verifica el piloto' }],
};

async function startUiApp(t) {
  try { await access(join(dist, 'index.html')); }
  catch { assert.fail('webapp/dist/index.html does not exist: run npm run build before this test'); }
  const temporary = process.env.OPENCODE_TEST_TMP ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir());
  const root = await mkdtemp(join(temporary, 'browser-ui-'));
  const directories = ['project', 'capture', 'data'].map(name => join(root, name));
  await Promise.all(directories.map(directory => mkdir(directory, { recursive: true })));
  const configPath = join(root, 'app.local.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    opencodeURL: 'http://127.0.0.1:1',
    opencodePassword: 'synthetic-password',
    projectDirectory: directories[0],
    captureDirectory: directories[1],
    dataDirectory: directories[2],
  }));
  const app = await startApp({ configPath });
  t.after(() => app.close());
  return app;
}

const waitForText = (page, text) => page.waitForFunction(value =>
  document.body.innerText.includes(value), text, { timeout: 20000 });

async function openUi(t, overrides = {}) {
  const app = await startUiApp(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const posts = [];
  const stopCalls = [];
  const replyCalls = [];
  const calls = { options: 0 };
  const negotiate = {
    health: () => jsonResponse(healthy),
    options: () => jsonResponse(readyOptions),
    list: () => jsonResponse({ executions: [] }),
    detail: id => jsonResponse(detail(id)),
    post: () => jsonResponse({ execution: execution('created-synthetic-1') }, 201),
    stop: () => jsonResponse({ stop: { requested: true, requestedAt: Date.now(), sessions: [] } }),
    interaction: () => jsonResponse({ interaction: { kind: 'form', sessionID: 'ses_root_exec', requestID: 'form-synthetic', phase: 'replied' } }),
    rubrics: () => jsonResponse({ source: 'none', state: 'ready', rubrics: [] }),
    evaluations: id => jsonResponse({ executionID: id, source: 'none', state: 'ready', evaluations: [] }),
    ...overrides,
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const respond = async value => {
      if (value === null) return route.abort('failed');
      return route.fulfill(await value);
    };
    if (url.pathname === '/api/health') return respond(negotiate.health());
    if (url.pathname === '/api/options') {
      calls.options++;
      return respond(negotiate.options());
    }
    if (url.pathname === '/api/executions' && request.method() === 'GET') return respond(negotiate.list());
    const stop = url.pathname.match(/^\/api\/executions\/([^/]+)\/stop$/);
    if (stop && request.method() === 'POST') {
      stopCalls.push({ id: decodeURIComponent(stop[1]), body: JSON.parse(request.postData() ?? '{}') });
      return respond(negotiate.stop(decodeURIComponent(stop[1])));
    }
    const interaction = url.pathname.match(/^\/api\/executions\/([^/]+)\/interactions$/);
    if (interaction && request.method() === 'POST') {
      replyCalls.push({ id: decodeURIComponent(interaction[1]), body: JSON.parse(request.postData() ?? '{}') });
      return respond(negotiate.interaction(decodeURIComponent(interaction[1])));
    }
    const trace = url.pathname.match(/^\/api\/executions\/([^/]+)\/trace$/);
    if (trace && request.method() === 'GET') {
      const traceId = decodeURIComponent(trace[1]);
      return negotiate.trace
        ? respond(negotiate.trace(traceId, url))
        : route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not-mocked"}' });
    }
    if (url.pathname === '/api/rubrics' && request.method() === 'GET') {
      return negotiate.rubrics
        ? respond(negotiate.rubrics())
        : route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not-mocked"}' });
    }
    const evaluations = url.pathname.match(/^\/api\/executions\/([^/]+)\/evaluations$/);
    if (evaluations && request.method() === 'GET') {
      const evaluationsId = decodeURIComponent(evaluations[1]);
      return negotiate.evaluations
        ? respond(negotiate.evaluations(evaluationsId, url))
        : route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not-mocked"}' });
    }
    const deliverables = url.pathname.match(/^\/api\/executions\/([^/]+)\/deliverables$/);
    if (deliverables && request.method() === 'GET') {
      const deliverablesId = decodeURIComponent(deliverables[1]);
      return negotiate.deliverables
        ? respond(negotiate.deliverables(deliverablesId, url))
        : route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not-mocked"}' });
    }
    const match = url.pathname.match(/^\/api\/executions\/([^/]+)$/);
    if (match && request.method() === 'GET') return respond(negotiate.detail(decodeURIComponent(match[1])));
    if (url.pathname === '/api/executions' && request.method() === 'POST') {
      posts.push(JSON.parse(request.postData() ?? '{}'));
      return respond(negotiate.post());
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not-mocked"}' });
  });
  await page.goto(`${app.url}/#/`);
  return { app, page, negotiate, posts, calls, stopCalls, replyCalls };
}

test('UI: barra lateral, navegación e histórico, y cajón adaptable en pantallas estrechas', { timeout: 120000 }, async t => {
  const { page, negotiate } = await openUi(t, {
    list: () => jsonResponse({ executions: [
      execution('11111111-1111-1111-1111-111111111111', { status: 'running', requestedAgent: 'generalist' }),
      execution('22222222-2222-2222-2222-222222222222', { status: 'succeeded',
        requestedCommand: { name: 'verificar' } }),
    ] }),
  });
  await page.getByRole('heading', { name: 'Nuevo encargo' }).waitFor();
  await page.getByLabel('Filtrar ejecuciones').waitFor();

  await page.getByRole('link', { name: 'Rúbricas' }).click();
  assert.equal(await page.evaluate(() => location.hash), '#/rubrics');
  await page.getByRole('heading', { name: 'Rúbricas', exact: true }).waitFor();

  await page.getByRole('link', { name: 'Nuevo encargo' }).click();
  await page.getByRole('heading', { name: 'Nuevo encargo' }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/');

  await page.locator('[data-id="11111111-1111-1111-1111-111111111111"]').click();
  assert.equal(await page.evaluate(() => location.hash),
    '#/executions/11111111-1111-1111-1111-111111111111/conversation');
  await page.getByRole('heading', { name: 'Ejecución 11111111' }).waitFor();
  await page.getByRole('tablist').waitFor();
  const tabs = await page.getByRole('tab').allInnerTexts();
  assert.deepEqual(tabs, ['Conversación', 'Entregables', 'Traza', 'Evaluación']);
  await page.waitForFunction(() =>
    document.querySelector('[aria-selected="true"]')?.textContent === 'Conversación');
  assert.equal((await page.getByRole('tabpanel').innerText()).includes('Encargo sintético de la interfaz.'), true);

  await page.setViewportSize({ width: 700, height: 800 });
  const sidebar = page.locator('aside');
  await sidebar.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Abrir menú' }).click();
  await sidebar.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Cerrar menú' }).click();
  await sidebar.waitFor({ state: 'hidden' });

  await page.setViewportSize({ width: 1280, height: 800 });
  await sidebar.waitFor({ state: 'visible' });
});

test('UI: conmutador de tema Claro, Oscuro y Sistema persistente', { timeout: 120000 }, async t => {
  const { page } = await openUi(t);
  await page.getByRole('heading', { name: 'Nuevo encargo' }).waitFor();

  await page.getByRole('radio', { name: 'Oscuro' }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await page.reload();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  assert.equal(await page.evaluate(() => localStorage.getItem('flujo-en-proyecto-tema')), 'oscuro');
  assert.equal(await page.getByRole('radio', { name: 'Oscuro' }).getAttribute('aria-checked'), 'true');

  await page.getByRole('radio', { name: 'Claro' }).click();
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
  await page.reload();
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
  assert.equal(await page.evaluate(() => localStorage.getItem('flujo-en-proyecto-tema')), 'claro');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('radio', { name: 'Sistema' }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await page.reload();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  assert.equal(await page.evaluate(() => localStorage.getItem('flujo-en-proyecto-tema')), 'sistema');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
});

test('UI: salud compacta expandible con motor, captura, índice y desconexión local', { timeout: 120000 }, async t => {
  let healthBody = healthy;
  const { page, negotiate } = await openUi(t, { health: () => jsonResponse(healthBody) });
  await waitForText(page, 'Motor disponible');
  await waitForText(page, 'Captura preparada');
  await waitForText(page, 'Índice disponible');

  await page.getByRole('button', { name: 'Salud del sistema' }).click();
  await page.getByRole('list', { name: 'Detalle de salud del sistema' }).waitFor();
  const detailText = await page.getByRole('list', { name: 'Detalle de salud del sistema' }).innerText();
  assert.ok(detailText.includes('La conexión con la app local está activa.'));
  assert.ok(detailText.includes('El motor responde en la interfaz pública'));
  assert.ok(detailText.includes('La captura del destino configurado está preparada.'));

  healthBody = { ...healthy, capture: { status: 'failed' } };
  await waitForText(page, 'Fallo del registrador');
  await waitForText(page, 'El registrador declaró fallo');

  healthBody = { ...healthy, index: { status: 'review-required' } };
  await waitForText(page, 'Índice: revisión requerida');
  await waitForText(page, 'El índice persistente requiere revisión');

  negotiate.health = () => null;
  await waitForText(page, 'Sin conexión con la app local');
  await waitForText(page, 'datos reflejan la última respuesta conocida');
});

test('UI: histórico en vivo mientras se inspecciona una ejecución y filtrado por texto y estado', { timeout: 120000 }, async t => {
  let list = { executions: [
    execution('aaaaaaaa-0000-0000-0000-000000000001', { status: 'running', requestedAgent: 'generalist' }),
    execution('bbbbbbbb-0000-0000-0000-000000000002', { status: 'succeeded',
      requestedCommand: { name: 'verificar' } }),
  ] };
  const { page } = await openUi(t, { list: () => jsonResponse(list) });
  await page.locator('[data-id="aaaaaaaa-0000-0000-0000-000000000001"]').click();
  await page.getByRole('heading', { name: 'Ejecución aaaaaaaa' }).waitFor();

  list = { executions: [
    execution('aaaaaaaa-0000-0000-0000-000000000001', { status: 'failed', requestedAgent: 'generalist' }),
    execution('bbbbbbbb-0000-0000-0000-000000000002', { status: 'succeeded',
      requestedCommand: { name: 'verificar' } }),
    execution('cccccccc-0000-0000-0000-000000000003', { status: 'running',
      requestedCommand: { name: 'desplegar' } }),
  ] };
  await page.locator('[data-id="cccccccc-0000-0000-0000-000000000003"]').waitFor();
  await page.waitForFunction(() =>
    document.querySelector('[data-id="aaaaaaaa-0000-0000-0000-000000000001"]')?.textContent?.includes('Fallida') ?? false);
  assert.equal(await page.evaluate(() =>
    document.querySelector('[data-id="cccccccc-0000-0000-0000-000000000003"]')?.textContent?.includes('desplegar') ?? false), true);

  await page.getByLabel('Filtrar ejecuciones').fill('desplegar');
  await page.locator('[data-id="bbbbbbbb-0000-0000-0000-000000000002"]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-id="aaaaaaaa-0000-0000-0000-000000000001"]').count(), 0);
  assert.equal(await page.locator('[data-id="cccccccc-0000-0000-0000-000000000003"]').count(), 1);

  await page.getByLabel('Filtrar ejecuciones').fill('generalist');
  await page.locator('[data-id="aaaaaaaa-0000-0000-0000-000000000001"]').waitFor();
  assert.equal(await page.locator('[data-id="cccccccc-0000-0000-0000-000000000003"]').count(), 0);

  await page.getByLabel('Filtrar ejecuciones').fill('');
  await page.getByLabel('Filtrar por estado').selectOption('succeeded');
  assert.equal(await page.locator('[data-id="aaaaaaaa-0000-0000-0000-000000000001"]').count(), 0);
  assert.equal(await page.locator('[data-id="bbbbbbbb-0000-0000-0000-000000000002"]').count(), 1);
  assert.equal(await page.locator('[data-id="cccccccc-0000-0000-0000-000000000003"]').count(), 0);
  assert.ok((await page.getByLabel('Histórico de ejecuciones').innerText()).includes('Finalizada'));
});

test('UI: compositor con estados de opciones, envío idempotente y avisos contextuales', { timeout: 180000 }, async t => {
  let releaseOptions;
  const gate = new Promise(resolve => { releaseOptions = resolve; });
  let optionsPayload = readyOptions;
  const optionsBody = () => optionsPayload;
  const overrides = {
    options: async () => jsonResponse(await gate.then(() => optionsBody())),
    post: () => jsonResponse({ execution: execution('created-synthetic-1') }, 201),
  };
  const { page, negotiate, posts, calls } = await openUi(t, overrides);

  await page.getByRole('heading', { name: 'Nuevo encargo' }).waitFor();
  assert.ok((await page.getByLabel('Agente').innerText()).includes('Cargando opciones…'));

  optionsPayload = { state: 'engine-unreachable', engine: { reachable: false, version: null },
    agents: null, models: null, commands: null };
  releaseOptions();
  await waitForText(page, 'Motor no disponible: no se pudieron consultar las opciones del proyecto.');

  optionsPayload = readyOptions;
  await page.getByRole('link', { name: 'Rúbricas' }).click();
  await page.getByRole('heading', { name: 'Rúbricas', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Nuevo encargo' }).click();
  await page.waitForFunction(() => document.querySelectorAll('select[aria-label="Agente"] option').length > 1);
  assert.equal(await page.getByLabel('Agente').isDisabled(), false);

  optionsPayload = { ...readyOptions, agents: [], models: [], commands: [] };
  await page.getByRole('link', { name: 'Rúbricas' }).click();
  await page.getByRole('link', { name: 'Nuevo encargo' }).click();
  await waitForText(page, 'Sin agentes expuestos');
  assert.ok((await page.getByLabel('Comando').innerText()).includes('La instancia no expone comandos'));

  negotiate.options = () => ({ status: 500, contentType: 'application/json', body: '{}' });
  await page.getByRole('link', { name: 'Rúbricas' }).click();
  await page.getByRole('link', { name: 'Nuevo encargo' }).click();
  await waitForText(page, 'Error al consultar opciones');
  negotiate.options = () => jsonResponse(readyOptions);
  await page.getByRole('button', { name: 'Recargar opciones' }).click();
  await page.waitForFunction(() => document.querySelectorAll('select[aria-label="Agente"] option').length > 1);

  await page.getByLabel('Comando').selectOption('verificar');
  await waitForText(page, 'El comando «verificar» se ejecuta por la interfaz pública de OpenCode');
  await page.getByLabel('Encargo', { exact: true }).fill('Argumentos sintéticos del comando.');

  negotiate.post = () => ({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' });
  await page.getByLabel('Encargo', { exact: true }).press('Control+Enter');
  await waitForText(page, 'No se pudo lanzar la ejecución');

  negotiate.post = () => jsonResponse({ error: 'selection-unavailable', kind: 'model',
    option: 'synthetic/model-gone' }, 422);
  await page.getByLabel('Encargo', { exact: true }).press('Control+Enter');
  await waitForText(page, 'La opción elegida (model: synthetic/model-gone) ya no está disponible');
  const optionsAfter422 = calls.options;
  await page.waitForFunction(value => value >= 2, optionsAfter422);

  negotiate.post = () => jsonResponse({ error: 'index-review-required' }, 503);
  await page.getByLabel('Encargo', { exact: true }).press('Control+Enter');
  await waitForText(page, 'El índice persistente requiere revisión');

  negotiate.post = () => jsonResponse({ error: 'project-busy',
    execution: execution('dddddddd-0000-0000-0000-000000000004', { status: 'running' }) }, 409);
  await page.getByLabel('Encargo', { exact: true }).press('Control+Enter');
  await waitForText(page, 'El proyecto de ejecución está ocupado por otra ejecución en marcha');
  const link = page.getByRole('link', { name: 'Ver la ejecución activa' });
  assert.equal(await link.getAttribute('href'), '#/executions/dddddddd-0000-0000-0000-000000000004/conversation');
  await link.click();
  await page.getByRole('heading', { name: 'Ejecución dddddddd' }).waitFor();
  await page.getByRole('link', { name: 'Nuevo encargo' }).click();
  await page.getByRole('heading', { name: 'Nuevo encargo' }).waitFor();
  await page.getByLabel('Encargo', { exact: true }).fill('Encargo directo sin comando.');

  negotiate.post = () => jsonResponse({ execution: execution('eeeeeeee-0000-0000-0000-000000000005') }, 201);
  await page.getByLabel('Encargo', { exact: true }).press('Control+Enter');
  await page.getByRole('heading', { name: 'Ejecución eeeeeeee' }).waitFor();
  await page.getByRole('tablist').waitFor();
  assert.equal(posts.length, 5);
  const retryKeys = posts.slice(0, 4).map(post => post.requestKey);
  assert.ok(retryKeys.every(key => key === retryKeys[0]),
    'a retry after failure must preserve the request key of the same draft');
  assert.notEqual(posts[4].requestKey, retryKeys[0],
    'a new assignment after navigating away must rotate the request key');
  assert.equal(posts[0].command.name, 'verificar');
  assert.equal(posts[0].command.arguments, 'Argumentos sintéticos del comando.');
  assert.equal('text' in posts[0], false);

  await page.getByRole('link', { name: 'Nuevo encargo' }).click();
  await page.getByLabel('Encargo', { exact: true }).fill('Encargo directo sin comando.');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await page.getByRole('heading', { name: 'Ejecución eeeeeeee' }).waitFor();
  assert.equal(posts.length, 6);
  assert.notEqual(posts[5].requestKey, posts[0].requestKey);
  assert.notEqual(posts[5].requestKey, posts[4].requestKey);
  assert.equal(posts[5].text, 'Encargo directo sin comando.');
  assert.equal('command' in posts[5], false);
});

test('UI: enrutado por hash con recarga, subejecución y atrás/adelante del navegador', { timeout: 120000 }, async t => {
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution('aaaaaaaa-1111-1111-1111-111111111111')] }),
  });
  await page.getByRole('heading', { name: 'Nuevo encargo' }).waitFor();

  await page.locator('[data-id="aaaaaaaa-1111-1111-1111-111111111111"]').click();
  await page.getByRole('heading', { name: 'Ejecución aaaaaaaa' }).waitFor();
  await page.getByRole('tablist').waitFor();
  await page.getByRole('tab', { name: 'Traza' }).click();
  await page.waitForFunction(() => location.hash.endsWith('/trace')
    && document.querySelector('[aria-selected="true"]')?.textContent === 'Traza');

  await page.evaluate(() => {
    location.hash = '#/executions/aaaaaaaa-1111-1111-1111-111111111111/deliverables?session=ses_sub_sintetica';
  });
  await page.waitForFunction(() => location.hash.includes('/deliverables?session=ses_sub_sintetica')
    && document.querySelector('[aria-selected="true"]')?.textContent === 'Entregables');
  await waitForText(page, 'Subejecución: ses_sub_sintetica');

  await page.reload();
  await page.getByRole('heading', { name: 'Ejecución aaaaaaaa' }).waitFor();
  await page.getByRole('tablist').waitFor();
  assert.equal(await page.evaluate(() => location.hash),
    '#/executions/aaaaaaaa-1111-1111-1111-111111111111/deliverables?session=ses_sub_sintetica');
  await waitForText(page, 'Subejecución: ses_sub_sintetica');
  assert.equal(await page.getByRole('tab', { name: 'Entregables' }).getAttribute('aria-selected'), 'true');

  await page.goBack();
  await page.waitForFunction(() => location.hash.endsWith('/trace'));
  await page.waitForFunction(() => document.querySelector('[aria-selected="true"]')?.textContent === 'Traza');
  await page.goBack();
  await page.waitForFunction(() => location.hash.endsWith('/conversation'));
  await page.goForward();
  await page.waitForFunction(() => location.hash.endsWith('/trace')
    && document.querySelector('[aria-selected="true"]')?.textContent === 'Traza');
  assert.equal(await page.locator('[data-subexecution]').count(), 0);
});

test('UI: salud colapsada distingue fallo de subsistema de desconexión local', { timeout: 120000 }, async t => {
  let healthBody = { ...healthy, engine: { reachable: false, version: null } };
  const { page, negotiate } = await openUi(t, { health: () => jsonResponse(healthBody) });
  const button = page.getByRole('button', { name: 'Salud del sistema' });
  await waitForText(page, 'Motor no disponible');
  const engineCollapsed = await button.innerText();
  assert.ok(!engineCollapsed.includes('Sin conexión con la app local'));
  assert.ok(engineCollapsed.includes('Motor no disponible'));

  healthBody = { ...healthy, capture: { status: 'failed' } };
  await waitForText(page, 'Fallo del registrador');
  const captureCollapsed = await button.innerText();
  assert.ok(!captureCollapsed.includes('Sin conexión con la app local'));
  assert.ok(captureCollapsed.includes('Fallo del registrador'));

  healthBody = { ...healthy, index: { status: 'review-required' } };
  await waitForText(page, 'Índice: revisión requerida');
  const indexCollapsed = await button.innerText();
  assert.ok(!indexCollapsed.includes('Sin conexión con la app local'));
  assert.ok(indexCollapsed.includes('Índice: revisión requerida'));

  negotiate.health = () => null;
  await waitForText(page, 'Sin conexión con la app local');
  assert.ok((await button.innerText()).includes('Sin conexión con la app local'));
});

test('UI: aviso proactivo de índice, project-busy sin ejecución, epistemología y hash malformado', { timeout: 120000 }, async t => {
  const unconfirmed = execution('11111111-aaaa-1111-1111-111111111111', {
    requestedAgent: 'generalist',
    requestedModel: 'synthetic/model-req',
  });
  const diverged = execution('22222222-bbbb-2222-2222-222222222222', {
    requestedAgent: 'generalist',
    knownAgent: 'build',
    requestedModel: 'synthetic/model-req',
    knownModel: { value: 'synthetic/model-real', providerID: 'synthetic', modelID: 'model-real', variant: null },
  });
  const byId = new Map([[unconfirmed.id, unconfirmed], [diverged.id, diverged]]);
  const { page, posts } = await openUi(t, {
    health: () => jsonResponse({ ...healthy, index: { status: 'review-required' } }),
    list: () => jsonResponse({ executions: [unconfirmed, diverged] }),
    detail: id => jsonResponse({ ...detail(id), execution: byId.get(id) ?? execution(id) }),
    post: () => jsonResponse({ error: 'project-busy', execution: null }, 409),
  });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error));

  await page.getByRole('heading', { name: 'Nuevo encargo' }).waitFor();
  await waitForText(page, 'El índice persistente requiere revisión');
  assert.equal(posts.length, 0);

  await page.getByLabel('Encargo', { exact: true }).fill('Encargo con proyecto ocupado sin detalle.');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await waitForText(page, 'El proyecto de ejecución está ocupado por otra ejecución en marcha');
  assert.equal(await page.getByRole('link', { name: 'Ver la ejecución activa' }).count(), 0);
  assert.equal((await page.locator('main').innerText()).includes('No se pudo lanzar la ejecución'), false);

  const unconfirmedItem = await page.locator(`[data-id="${unconfirmed.id}"]`).innerText();
  assert.ok(unconfirmedItem.includes('generalist (solicitado)'));
  assert.ok(unconfirmedItem.includes('synthetic/model-req (solicitado)'));
  const divergedItem = await page.locator(`[data-id="${diverged.id}"]`).innerText();
  assert.ok(divergedItem.includes('build'));
  assert.ok(!divergedItem.includes('build (solicitado)'));
  assert.ok(divergedItem.includes('synthetic/model-real'));

  await page.locator(`[data-id="${unconfirmed.id}"]`).click();
  await waitForText(page, 'Agente: generalist (solicitado, sin confirmar)');
  await waitForText(page, 'Modelo: synthetic/model-req (solicitado, sin confirmar)');

  await page.locator(`[data-id="${diverged.id}"]`).click();
  await waitForText(page, 'Agente: build (solicitado: generalist)');
  await waitForText(page, 'Modelo: synthetic/model-real (solicitado: synthetic/model-req)');

  await page.evaluate(() => { location.hash = '#/executions/%E0%A4%A/conversation'; });
  await page.getByRole('heading', { name: 'Nuevo encargo' }).waitFor();
  assert.equal(pageErrors.length, 0);
});

test('UI: cabecera de ejecución con Detener, chips y cajón de metadatos forenses copiable', { timeout: 120000 }, async t => {
  const running = 'aaaaaaaa-2222-2222-2222-222222222222';
  const terminal = 'bbbbbbbb-3333-3333-3333-333333333333';
  const runningDetail = {
    ...detail(running),
    execution: execution(running, {
      status: 'running',
      sessionID: 'ses_root_exec',
      requestedAgent: 'generalist',
      requestedModel: 'synthetic/model-req',
      knownAgent: 'build',
      knownAgentSource: 'public-session',
      knownModel: { value: 'synthetic/model-real', providerID: 'synthetic', modelID: 'model-real', variant: null },
    }),
    capture: {
      readable: true,
      captureIDs: ['cap-001', 'cap-002'],
      recorderFailed: false,
      horizon: '2026-11-27T10:00:00.000Z',
      scope: { kind: 'observed-session-tree', rootSessionID: 'ses_root_exec', sessionIDs: ['ses_root_exec', 'ses_sub_exec'] },
      gaps: [{ captureID: 'cap-glob', arrival: 12, observedAt: 1700000000000, scope: 'capture', reason: 'laguna del destino sintética' }],
      omissions: [{ sessionID: 'ses_sub_exec', captureID: 'cap-002', arrival: 7, type: 'recorder.observation', omissions: ['non-text-fields-not-captured'] }],
    },
  };
  let phase = 'running';
  const stopUnconfirmed = { requested: true, requestedAt: 1700000000000,
    sessions: [{ sessionID: 'ses_root_exec', result: 'accepted', stop: 'unconfirmed' }] };
  const stopConfirmed = { requested: true, requestedAt: 1700000000000,
    sessions: [{ sessionID: 'ses_root_exec', result: 'accepted', stop: 'confirmed' }] };
  const { app, page, stopCalls } = await openUi(t, {
    list: () => jsonResponse({ executions: [
      execution(running, runningDetail.execution),
      execution(terminal, { status: 'succeeded' }),
    ] }),
    detail: id => {
      if (id !== running) return jsonResponse(detail(id));
      if (phase === 'running') return jsonResponse(runningDetail);
      if (phase === 'stopping') {
        return jsonResponse({ ...runningDetail,
          execution: { ...runningDetail.execution, status: 'running', stop: { requested: true, requestedAt: 1700000000000 } },
          stop: stopUnconfirmed });
      }
      return jsonResponse({ ...runningDetail,
        execution: { ...runningDetail.execution, status: 'interrupted', stop: { requested: true, requestedAt: 1700000000000 } },
        stop: stopConfirmed });
    },
    stop: () => {
      if (phase === 'running') {
        phase = 'stopping';
        return jsonResponse({ stop: stopUnconfirmed });
      }
      phase = 'interrupted';
      return jsonResponse({ stop: stopConfirmed });
    },
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url });

  await page.locator(`[data-id="${running}"]`).click();
  await page.getByRole('heading', { name: 'Ejecución aaaaaaaa' }).waitFor();
  await waitForText(page, 'Agente: build (solicitado: generalist)');
  await waitForText(page, 'Modelo: synthetic/model-real (solicitado: synthetic/model-req)');
  await waitForText(page, 'En ejecución');
  const detener = page.getByRole('button', { name: 'Detener' });
  await detener.waitFor();

  await page.getByText('Metadatos y evidencia').click();
  await waitForText(page, running);
  await waitForText(page, 'cap-001, cap-002');
  await waitForText(page, 'ses_root_exec');
  await waitForText(page, 'ses_sub_exec');
  await waitForText(page, 'Evidencia hasta');
  await waitForText(page, '2026-11-27T10:00:00.000Z');
  await waitForText(page, 'máximo observado en el árbol');
  await waitForText(page, 'Elegido: generalist');
  await waitForText(page, 'Conocido: build (procedencia: API pública de la sesión)');
  await waitForText(page, 'Conocido: synthetic/model-real (procedencia: API pública de la sesión)');
  await waitForText(page, 'Lagunas del destino de captura');
  await waitForText(page, 'Sin atribución a esta ejecución: la captura no identifica la sesión afectada. No hay replay ni relleno de texto.');
  await waitForText(page, 'cap-glob · fila 12');
  await waitForText(page, 'laguna del destino sintética');
  await waitForText(page, 'Omisiones observadas');
  await waitForText(page, 'ses_sub_exec · cap-002 · fila 7 · recorder.observation: non-text-fields-not-captured');
  await page.getByRole('button', { name: 'Copiar identificador completo' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), running);
  await page.getByRole('button', { name: 'Copiar capturas' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'cap-001, cap-002');

  await detener.click();
  await waitForText(page, 'Detención solicitada');
  await waitForText(page, 'Solicitud: aceptada');
  await waitForText(page, 'Detención: no confirmada');
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0].id, running);
  assert.deepEqual(stopCalls[0].body, {});
  assert.equal(await page.getByRole('button', { name: 'Detener' }).count(), 1);

  await page.getByRole('button', { name: 'Detener' }).click();
  await waitForText(page, 'Detención: confirmada');
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(el => el.textContent?.trim() === 'Detener'));
  assert.equal(stopCalls.length, 2);
  assert.equal(await page.getByRole('button', { name: 'Detener' }).count(), 0);

  await page.locator(`[data-id="${terminal}"]`).click();
  await page.getByRole('heading', { name: 'Ejecución bbbbbbbb' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Detener' }).count(), 0);
});

test('UI: banda prioritaria con fallo del registrador visible en todas las pestañas', { timeout: 120000 }, async t => {
  const failing = 'cccccccc-4444-4444-4444-444444444444';
  let mode = 'failed-readable';
  const failingDetail = () => {
    if (mode === 'failed-readable') {
      return {
        ...detail(failing),
        execution: execution(failing, { status: 'running', sessionID: 'ses_root_f' }),
        recorder: { readable: true, status: 'failed', reason: 'Razón pública sintética', notice: 'Aviso público sintético',
          reviewRequired: true, pilotReady: false, interruption: { requested: true, stop: 'unconfirmed' },
          source: 'public-session-metadata' },
        capture: { readable: true, captureIDs: ['cap-f'], recorderFailed: false, horizon: null,
          scope: { sessionIDs: ['ses_root_f'] }, gaps: [], omissions: [] },
      };
    }
    if (mode === 'capture-failed-unreadable') {
      return {
        ...detail(failing),
        execution: execution(failing, { status: 'running', sessionID: 'ses_root_f' }),
        recorder: { readable: false, reason: 'engine-unreachable' },
        capture: { readable: false, reason: 'destino de captura roto', recorderFailed: true, captureIDs: [], horizon: null },
      };
    }
    return {
      ...detail(failing),
      execution: execution(failing, { status: 'running', sessionID: 'ses_root_f' }),
      recorder: { readable: true, status: 'ready', reason: 'Revisión pendiente sintética', notice: null,
        reviewRequired: true, pilotReady: false, interruption: null, source: 'public-session-metadata' },
      capture: { readable: true, captureIDs: ['cap-f'], recorderFailed: false, horizon: null,
        scope: { sessionIDs: ['ses_root_f'] }, gaps: [], omissions: [] },
    };
  };
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(failing, { status: 'running', sessionID: 'ses_root_f' })] }),
    detail: () => jsonResponse(failingDetail()),
  });
  await page.locator(`[data-id="${failing}"]`).click();
  const banner = page.getByRole('region', { name: 'Atención prioritaria' });
  await banner.waitFor();
  const text = await banner.innerText();
  assert.ok(text.includes('Fallo del registrador'));
  assert.ok(text.includes('Estado de captura: consultable.'));
  assert.ok(text.includes('Revisión requerida según la evidencia pública del motor.'));
  assert.ok(text.includes('Se conserva el bloqueo durable de la captura: no hay desbloqueo automático, ni por recargar ni por reparar la ruta.'));
  assert.ok(text.includes('Interrupción: solicitada, detención no confirmada.'));
  assert.ok(text.includes('Motivo público declarado: Razón pública sintética.'));
  assert.ok(text.includes('Aviso público sintético'));

  for (const tab of ['Entregables', 'Traza', 'Evaluación']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForFunction(value =>
      document.querySelector('[aria-selected="true"]')?.textContent === value, tab);
    assert.ok((await banner.innerText()).includes('Fallo del registrador'));
  }

  mode = 'capture-failed-unreadable';
  await waitForText(page, 'Estado de captura: no consultable (destino de captura roto)');
  const unreadableText = await banner.innerText();
  assert.ok(unreadableText.includes('No se pudieron leer los metadatos públicos del registrador en el motor (engine-unreachable)'));
  assert.equal(unreadableText.includes('Revisión requerida según la evidencia pública del motor.'), false);

  mode = 'review-required-ready';
  await waitForText(page, 'Motivo público declarado: Revisión pendiente sintética.');
  const reviewOnlyText = await banner.innerText();
  assert.ok(reviewOnlyText.includes('Fallo del registrador'));
  assert.ok(reviewOnlyText.includes('Revisión requerida según la evidencia pública del motor.'));
});

test('UI: banda prioritaria con motor inaccesible en ejecución no terminal', { timeout: 120000 }, async t => {
  const active = 'dddddddd-5555-5555-5555-555555555555';
  const done = 'eeeeeeee-6666-6666-6666-666666666666';
  const { page } = await openUi(t, {
    health: () => jsonResponse({ ...healthy, engine: { reachable: false, version: null } }),
    list: () => jsonResponse({ executions: [
      execution(active, { status: 'running', sessionID: 'ses_root_act' }),
      execution(done, { status: 'succeeded', sessionID: 'ses_root_done' }),
    ] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: id === active ? 'running' : 'succeeded' }) }),
  });
  await page.locator(`[data-id="${active}"]`).click();
  const banner = page.getByRole('region', { name: 'Atención prioritaria' });
  await banner.waitFor();
  await waitForText(page, 'Motor no disponible: desenlace pendiente de comprobar; el encargo no se reenviará.');
  await page.getByRole('tab', { name: 'Traza' }).click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-selected="true"]')?.textContent === 'Traza');
  assert.ok((await banner.innerText()).includes('desenlace pendiente de comprobar'));

  await page.locator(`[data-id="${done}"]`).click();
  await page.getByRole('heading', { name: 'Ejecución eeeeeeee' }).waitFor();
  await banner.waitFor({ state: 'detached' });
  await page.waitForTimeout(2000);
  assert.equal(await page.getByRole('region', { name: 'Atención prioritaria' }).count(), 0);

  await page.locator(`[data-id="${active}"]`).click();
  await banner.waitFor();
  assert.ok((await banner.innerText()).includes('desenlace pendiente de comprobar'));
});

test('UI: banda prioritaria con detención solicitada por sesión y árbol no verificado', { timeout: 120000 }, async t => {
  const stopping = 'ffffffff-7777-7777-7777-777777777777';
  const stopDetail = {
    ...detail(stopping),
    execution: execution(stopping, { status: 'running', sessionID: 'ses_root_s',
      stop: { requested: true, requestedAt: 1700000000000 } }),
    stop: {
      requested: true,
      requestedAt: 1700000000000,
      sessions: [
        { sessionID: 'ses_root_s', outcome: 'interrupted', stop: 'confirmed' },
        { sessionID: 'ses_sub_s', outcome: null, stop: 'unconfirmed' },
      ],
      readError: 'engine-unreachable',
      treeVerified: false,
    },
  };
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(stopping, { status: 'running', sessionID: 'ses_root_s' })] }),
    detail: () => jsonResponse(stopDetail),
  });
  await page.locator(`[data-id="${stopping}"]`).click();
  const banner = page.getByRole('region', { name: 'Atención prioritaria' });
  await banner.waitFor();
  const text = await banner.innerText();
  assert.ok(text.includes('Detención solicitada'));
  assert.ok(text.includes('La detención actúa sólo sobre el alcance verificado de esta ejecución.'));
  assert.ok(text.includes('no hay interrupción instantánea, pausa, reanudación ni reversión de efectos externos'));
  assert.ok(text.includes('Sesión raíz · Solicitud: sin comprobar · Detención: confirmada · desenlace público: interrupted'));
  assert.ok(text.includes('Subejecución ses_sub_s · Solicitud: sin comprobar · Detención: no confirmada · desenlace público: desconocido'));
  assert.ok(text.includes('No se pudo verificar el árbol de sesiones; los descendientes nuevos no pudieron comprobarse.'));
  assert.ok(text.includes('No se pudo comprobar el desenlace público de la detención; se mantiene no confirmada y el trabajo no se relanza.'));
  assert.equal(await page.getByRole('button', { name: 'Detener' }).count(), 1);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[role="alert"] [role="alert"]').length), 0);
});

test('UI: banda prioritaria con intervenciones pendientes, salto directo y errores de lectura', { timeout: 120000 }, async t => {
  const waiting = '11111111-8888-8888-8888-888888888888';
  const waitingDetail = {
    ...detail(waiting),
    execution: execution(waiting, { status: 'running', sessionID: 'ses_root_i' }),
    capture: { readable: true, captureIDs: ['cap-i'], recorderFailed: false, horizon: null,
      scope: { sessionIDs: ['ses_root_i', 'ses_sub_i'] }, gaps: [], omissions: [] },
    interactions: {
      pending: [
        { kind: 'form', sessionID: 'ses_root_i', requestID: 'form-root',
          request: { title: 'Pregunta raíz sintética', fields: [{ key: 'answer', type: 'string', title: 'Respuesta' }] },
          observedAt: 1700000000000 },
        { kind: 'permission', sessionID: 'ses_sub_i', requestID: 'perm-sub',
          request: { action: 'Escribir archivo', resources: ['salida.txt'], message: '¿Autorizar la escritura?' },
          observedAt: 1700000000000 },
      ],
      resolved: [],
      readErrors: [{ sessionID: 'ses_sub_i', error: 'engine-unreachable' }],
    },
  };
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(waiting, { status: 'running', sessionID: 'ses_root_i' })] }),
    detail: () => jsonResponse(waitingDetail),
  });
  await page.locator(`[data-id="${waiting}"]`).click();
  const banner = page.getByRole('region', { name: 'Atención prioritaria' });
  await banner.waitFor();
  const text = await banner.innerText();
  assert.ok(text.includes('Esperando intervención'));
  assert.ok(text.includes('Pregunta nativa · Sesión raíz'));
  assert.ok(text.includes('Permiso nativo · Subejecución ses_sub_i'));
  assert.ok(text.includes('La ejecución espera intervención: conserva su identidad, no se cierra ni falla por esperar, y responder no lanza otro encargo.'));
  assert.ok(text.includes('No se pudieron leer las solicitudes pendientes de ses_sub_i.'));
  assert.ok(text.includes('su vigencia no está comprobada'));

  await page.getByRole('tab', { name: 'Evaluación' }).click();
  await page.waitForFunction(() =>
    document.querySelector('[aria-selected="true"]')?.textContent === 'Evaluación');
  assert.ok((await banner.innerText()).includes('Permiso nativo'));

  await page.getByRole('button', { name: 'Ir a la solicitud' }).first().click();
  await page.waitForFunction(() => location.hash.endsWith('/conversation'));
  await page.locator('[data-request="form-root"]').waitFor();
  await page.getByRole('button', { name: 'Responder pregunta' }).waitFor();
  assert.ok((await page.getByRole('tabpanel').innerText()).includes('Pregunta raíz sintética'));
  assert.ok((await page.getByRole('tabpanel').innerText()).includes('¿Autorizar la escritura?'));
});

test('UI: Conversación en Markdown seguro con bloques copiables y conmutador a texto plano', { timeout: 120000 }, async t => {
  const shown = 'aaaaaaaa-9999-9999-9999-999999999999';
  const fenced = '```js\nconst sintetico = 1;\n```';
  const markdownText = [
    '# Encabezado sintético',
    '',
    '- punto uno',
    '- punto dos',
    '',
    '| Columna A | Columna B |',
    '| --- | --- |',
    '| celda 1 | celda 2 |',
    '',
    fenced,
    '',
    '[enlace seguro](https://example.com) y [enlace peligroso](javascript:alert(1)).',
    '',
    '<script>window.__pwned = true;</script>',
    '',
    '<img src=x onerror="window.__pwned2 = true">',
  ].join('\n');
  let dispatchState = 'admitted';
  const { app, page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(shown)] }),
    detail: () => jsonResponse({ ...detail(shown),
      execution: execution(shown, { dispatch: dispatchState }),
      conversation: { entries: [], responses: [{ text: markdownText }] } }),
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url });
  await page.locator(`[data-id="${shown}"]`).click();
  await page.getByRole('heading', { name: 'Ejecución aaaaaaaa' }).waitFor();

  await waitForText(page, 'Despacho: encargo admitido.');
  await page.getByRole('heading', { name: 'Encabezado sintético' }).waitFor();
  await page.getByText('punto uno', { exact: true }).waitFor();
  await page.getByText('punto dos', { exact: true }).waitFor();
  await page.getByRole('table').waitFor();
  await page.getByRole('cell', { name: 'celda 1' }).waitFor();
  await page.getByRole('cell', { name: 'celda 2' }).waitFor();
  await page.locator('pre').waitFor();
  assert.ok((await page.locator('pre').innerText()).includes('const sintetico = 1;'));
  await page.getByRole('button', { name: 'Copiar código' }).click();
  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes('const sintetico = 1;'));

  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.evaluate(() => window.__pwned2), undefined);
  assert.equal(await page.evaluate(() => document.querySelectorAll('main img, main script').length), 0);
  const safeLink = page.getByRole('link', { name: 'enlace seguro' });
  await safeLink.waitFor();
  assert.equal(await safeLink.getAttribute('href'), 'https://example.com');
  assert.equal(await safeLink.getAttribute('target'), '_blank');
  assert.equal(await page.getByRole('link', { name: 'enlace peligroso' }).count(), 0);
  const unsafeText = page.getByText('enlace peligroso', { exact: true });
  await unsafeText.waitFor();
  const unsafeInfo = await unsafeText.evaluate(el => ({
    href: el.getAttribute('href'),
    target: el.getAttribute('target'),
    anchorAncestor: Boolean(el.closest('a')),
  }));
  assert.equal(unsafeInfo.href, null);
  assert.equal(unsafeInfo.target, null);
  assert.equal(unsafeInfo.anchorAncestor, false);

  dispatchState = 'possibly-sent';
  await waitForText(page, 'Despacho: envío posible; admisión sin confirmar. El encargo no se reenviará automáticamente.');
  dispatchState = 'admitted';
  await waitForText(page, 'Despacho: encargo admitido.');

  await page.getByRole('button', { name: 'Texto sin formato' }).click();
  await waitForText(page, '# Encabezado sintético');
  await waitForText(page, '<script>window.__pwned = true;</script>');
  assert.equal(await page.locator('pre').count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'Encabezado sintético' }).count(), 0);
  assert.ok((await page.getByRole('tabpanel').innerText()).includes('javascript:alert(1)'));

  await page.getByRole('button', { name: 'Markdown' }).click();
  await page.getByRole('heading', { name: 'Encabezado sintético' }).waitFor();
  await page.locator('pre').waitFor();
});

const formFields = [
  { key: 'answer', type: 'string', title: 'Respuesta', required: true },
  { key: 'choice', type: 'string', title: 'Elección', options: [{ value: 'a', label: 'Opción A' }, { value: 'b', label: 'Opción B' }], custom: true },
  { key: 'extra', type: 'string', title: 'Extra condicional', when: { field: 'choice', equals: 'a' } },
  { key: 'flag', type: 'boolean', title: 'Confirmación', required: true },
  { key: 'whenUnchecked', type: 'string', title: 'Visible sin marcar', when: { field: 'flag', equals: false } },
  { key: 'count', type: 'integer', title: 'Cantidad' },
  { key: 'whenFortyTwo', type: 'string', title: 'Visible con 42', when: { field: 'count', equals: 42 } },
];

const formPending = [
  { kind: 'form', sessionID: 'ses_root_c', requestID: 'form-root',
    request: { title: 'Pregunta raíz sintética', fields: formFields }, observedAt: 1700000000000 },
  { kind: 'form', sessionID: 'ses_sub_c', requestID: 'form-shared',
    request: { title: 'Pregunta de subejecución', fields: [{ key: 'answer', type: 'string' }] }, observedAt: 1700000000000 },
];

test('UI: preguntas nativas con borradores aislados, valor propio, booleano false explícito y condicional', { timeout: 120000 }, async t => {
  const drafting = 'bbbbbbbb-aaaa-4bbb-8bbb-bbbbbbbbbbbb';
  const { page, replyCalls } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(drafting, { status: 'running', sessionID: 'ses_root_c' })] }),
    detail: () => jsonResponse({ ...detail(drafting),
      execution: execution(drafting, { status: 'running', sessionID: 'ses_root_c' }),
      capture: { readable: true, captureIDs: ['cap-c'], recorderFailed: false, horizon: null,
        scope: { sessionIDs: ['ses_root_c', 'ses_sub_c'] }, gaps: [], omissions: [] },
      interactions: { pending: formPending, resolved: [], readErrors: [] } }),
  });
  await page.locator(`[data-id="${drafting}"]`).click();
  const panel = page.getByRole('tabpanel');
  await panel.waitFor();
  const rootForm = page.locator('[data-request="form-root"]');
  const subForm = page.locator('[data-request="form-shared"]');
  await rootForm.waitFor();
  await subForm.waitFor();

  assert.equal(await page.locator('[data-request="form-root"] [data-field="extra"]').count(), 0);
  await page.locator('[data-request="form-root"] select[data-field="choice"]').selectOption('a');
  await page.locator('[data-request="form-root"] [data-field="extra"]').waitFor();
  assert.equal(await page.locator('[data-request="form-root"] input[data-field="choice"]').inputValue(), 'a');
  await page.locator('[data-request="form-root"] input[data-field="choice"]').fill('propio');
  assert.equal(await page.locator('[data-request="form-root"] [data-field="extra"]').count(), 0);

  await page.locator('[data-request="form-root"] input[data-field="answer"]').fill('respuesta raíz');
  await page.locator('[data-request="form-shared"] input[data-field="answer"]').fill('respuesta sub');
  assert.equal(await page.locator('[data-request="form-root"] input[data-field="answer"]').inputValue(), 'respuesta raíz');
  assert.equal(await page.locator('[data-request="form-shared"] input[data-field="answer"]').inputValue(), 'respuesta sub');
  assert.equal(await page.locator('[data-request="form-root"] input[data-field="flag"]').isChecked(), false);
  await page.locator('[data-request="form-root"] [data-field="whenUnchecked"]').waitFor();
  await page.locator('[data-request="form-root"] input[data-field="flag"]').check();
  assert.equal(await page.locator('[data-request="form-root"] [data-field="whenUnchecked"]').count(), 0);
  await page.locator('[data-request="form-root"] input[data-field="flag"]').uncheck();
  await page.locator('[data-request="form-root"] [data-field="whenUnchecked"]').waitFor();

  assert.equal(await page.locator('[data-request="form-root"] [data-field="whenFortyTwo"]').count(), 0);
  await page.locator('[data-request="form-root"] input[data-field="count"]').fill('42');
  await page.locator('[data-request="form-root"] [data-field="whenFortyTwo"]').waitFor();
  await page.locator('[data-request="form-root"] input[data-field="count"]').fill('7');
  assert.equal(await page.locator('[data-request="form-root"] [data-field="whenFortyTwo"]').count(), 0);

  await rootForm.getByRole('button', { name: 'Responder pregunta' }).click();
  await page.waitForTimeout(500);
  assert.equal(replyCalls.length, 1);
  assert.deepEqual(replyCalls[0].body, {
    kind: 'form',
    sessionID: 'ses_root_c',
    requestID: 'form-root',
    answer: { answer: 'respuesta raíz', choice: 'propio', flag: false, count: 7 },
  });
  assert.equal(typeof replyCalls[0].body.answer.count, 'number');
  assert.ok('flag' in replyCalls[0].body.answer);
});

test('UI: permisos con decisión explícita, errores honestos, pérdida de transporte y respuestas registradas legibles', { timeout: 120000 }, async t => {
  const granting = 'cccccccc-bbbb-4ccc-8ccc-cccccccccccc';
  const interactionDetail = {
    ...detail(granting),
    execution: execution(granting, { status: 'running', sessionID: 'ses_root_g' }),
    capture: { readable: true, captureIDs: ['cap-g'], recorderFailed: false, horizon: null,
      scope: { sessionIDs: ['ses_root_g', 'ses_sub_g'] }, gaps: [], omissions: [] },
    interactions: {
      pending: [
        { kind: 'permission', sessionID: 'ses_root_g', requestID: 'perm-root',
          request: { action: 'Escribir archivo', resources: ['salida.txt'], message: '¿Autorizar la escritura?' },
          observedAt: 1700000000000 },
      ],
      resolved: [
        { kind: 'permission', sessionID: 'ses_root_g', requestID: 'perm-old', phase: 'replied',
          response: { decision: 'once' } },
        { kind: 'form', sessionID: 'ses_sub_g', requestID: 'form-old', phase: 'cancelled',
          response: { picked: ['a', 'b'], flag: true, frequency: 'once' } },
      ],
      readErrors: [{ error: 'engine-unreachable' }],
    },
  };
  const { page, replyCalls, negotiate } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(granting, { status: 'running', sessionID: 'ses_root_g' })] }),
    detail: () => jsonResponse(interactionDetail),
  });
  await page.locator(`[data-id="${granting}"]`).click();
  const panel = page.getByRole('tabpanel');
  await panel.waitFor();
  await page.getByText('Acción: Escribir archivo').waitFor();
  await page.getByText('Alcance: salida.txt').waitFor();
  await page.getByText('Mensaje: ¿Autorizar la escritura?').waitFor();
  await page.getByText('su vigencia no está comprobada').first().waitFor();
  assert.equal(await page.locator('[role="alert"]', { hasText: 'su vigencia no está comprobada' }).count(), 1);
  assert.equal(replyCalls.length, 0);

  await page.getByRole('button', { name: 'Permitir siempre' }).click();
  await page.waitForTimeout(500);
  assert.deepEqual(replyCalls[0]?.body, { kind: 'permission', sessionID: 'ses_root_g', requestID: 'perm-root', decision: 'always' });

  negotiate.interaction = () => jsonResponse({ error: 'interaction-resolved' }, 409);
  await page.getByRole('button', { name: 'Permitir una vez' }).click();
  await waitForText(page, 'La solicitud ya estaba resuelta o desaparecida; no se ha vuelto a responder.');

  negotiate.interaction = () => jsonResponse({ error: 'engine-unreachable' }, 503);
  await page.getByRole('button', { name: 'Permitir siempre' }).click();
  await waitForText(page, 'No se pudo consultar la solicitud en el motor; esta petición no llegó a intentar la respuesta.');

  negotiate.interaction = () => null;
  await page.getByRole('button', { name: 'Rechazar' }).click();
  await waitForText(page, 'Respuesta posiblemente enviada: no se pudo confirmar el resultado. El permiso pudo aplicarse; pendiente de reconciliar con la evidencia y el motor. No se repetirá automáticamente.');
  await page.waitForTimeout(3500);
  assert.equal(replyCalls.length, 4);

  const resolved = page.locator('details[aria-label="Respuestas registradas"]');
  await resolved.waitFor();
  assert.equal(await resolved.getAttribute('open'), null);
  await resolved.getByText('Respuestas registradas en la captura').click();
  await resolved.getByText('Permitir una vez').waitFor();
  const resolvedText = await resolved.innerText();
  assert.ok(resolvedText.includes('Permiso · Sesión raíz · respondida'));
  assert.ok(resolvedText.includes('Pregunta · Subejecución ses_sub_g · cancelada'));
  assert.ok(resolvedText.includes('a · b'));
  assert.ok(resolvedText.includes('sí'));
  const resolvedFormText = await resolved.locator('[data-resolved="ses_sub_g:form:form-old"]').innerText();
  assert.ok(resolvedFormText.includes('once'));
  assert.equal(resolvedFormText.includes('Permitir una vez'), false);
  const resolvedPermText = await resolved.locator('[data-resolved="ses_root_g:permission:perm-old"]').innerText();
  assert.ok(resolvedPermText.includes('Permitir una vez'));
  assert.ok(resolvedText.includes('La captura no atribuye las respuestas a una persona autenticada: su procedencia es cliente externo no identificado.'));
  assert.ok(!resolvedText.includes('{"decision"'));
  assert.ok(!resolvedText.includes('["a","b"]'));
});

test('UI: sondeo en segundo plano no destructivo con foco, borrador y desplegable intactos', { timeout: 180000 }, async t => {
  const polled = 'dddddddd-cccc-4ddd-8ddd-dddddddddddd';
  let tick = 0;
  const polledDetail = () => {
    tick++;
    return {
      ...detail(polled),
      execution: execution(polled, { status: 'running', sessionID: 'ses_root_p' }),
      conversation: { entries: [{ text: 'Encargo sintético de la interfaz.' }], responses: [{ text: `Respuesta número ${tick}.` }] },
      capture: { readable: true, captureIDs: ['cap-p'], recorderFailed: false, horizon: null,
        scope: { sessionIDs: ['ses_root_p'] }, gaps: [], omissions: [] },
      interactions: { pending: [formPending[0]], resolved: [], readErrors: [] },
    };
  };
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(polled, { status: 'running', sessionID: 'ses_root_p' })] }),
    detail: () => jsonResponse(polledDetail()),
  });
  await page.locator(`[data-id="${polled}"]`).click();
  await waitForText(page, 'Respuesta número 1.');
  const reach = target => page.waitForFunction(value =>
    parseInt(document.body.innerText.match(/Respuesta número (\d+)/)?.[1] ?? '0', 10) >= value, target, { timeout: 20000 });
  const draft = page.locator('[data-request="form-root"] input[data-field="answer"]');
  await draft.waitFor();
  await page.getByText('Metadatos y evidencia').click();
  await draft.fill('borrador estable');
  await draft.evaluate(el => {
    el.focus();
    el.setSelectionRange(0, 8);
  });
  await reach(4);
  const stable = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      focused: active instanceof HTMLInputElement && active.matches('[data-field="answer"]'),
      value: active instanceof HTMLInputElement ? active.value : null,
      selectionStart: active instanceof HTMLInputElement ? active.selectionStart : null,
      selectionEnd: active instanceof HTMLInputElement ? active.selectionEnd : null,
      drawerOpen: document.querySelector('details')?.hasAttribute('open') ?? false,
    };
  });
  assert.equal(stable.focused, true);
  assert.equal(stable.value, 'borrador estable');
  assert.equal(stable.selectionStart, 0);
  assert.equal(stable.selectionEnd, 8);
  assert.equal(stable.drawerOpen, true);
  await reach(6);
  assert.ok(tick >= 5);
});

test('UI: protección contra respuestas obsoletas al cambiar de ejecución', { timeout: 120000 }, async t => {
  const execA = 'eeeeeeee-dddd-4eee-8eee-eeeeeeeeeeee';
  const execB = 'ffffffff-eeee-4fff-8fff-ffffffffffff';
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [
      execution(execA, { status: 'running', sessionID: 'ses_root_a' }),
      execution(execB, { status: 'succeeded', sessionID: 'ses_root_b' }),
    ] }),
    detail: async id => {
      if (id === execA) await new Promise(resolve => setTimeout(resolve, 1500));
      return jsonResponse({ ...detail(id),
        execution: execution(id, { status: id === execA ? 'running' : 'succeeded' }),
        conversation: { entries: [{ text: `Entrada exclusiva de la ejecución ${id}` }], responses: [] } });
    },
  });
  await page.locator(`[data-id="${execA}"]`).click();
  await page.locator(`[data-id="${execB}"]`).click();
  await page.getByRole('heading', { name: 'Ejecución ffffffff' }).waitFor();
  await waitForText(page, `Entrada exclusiva de la ejecución ${execB}`);
  await page.waitForTimeout(2500);
  const panelText = await page.getByRole('tabpanel').innerText();
  assert.ok(panelText.includes(`Entrada exclusiva de la ejecución ${execB}`));
  assert.ok(!panelText.includes(`Entrada exclusiva de la ejecución ${execA}`));
  assert.ok((await page.getByRole('heading', { name: 'Ejecución ffffffff' }).innerText()).includes('ffffffff'));
});

test('UI: salto directo con identificadores con dos puntos y foco en clics repetidos', { timeout: 120000 }, async t => {
  const execId = '12121212-aaaa-4121-8121-121212121212';
  const colonDetail = {
    ...detail(execId),
    execution: execution(execId, { status: 'running', sessionID: 'ses:root:1' }),
    capture: { readable: true, captureIDs: ['cap-colon'], recorderFailed: false, horizon: null,
      scope: { sessionIDs: ['ses:root:1'] }, gaps: [], omissions: [] },
    interactions: {
      pending: [
        { kind: 'form', sessionID: 'ses:root:1', requestID: 'req:form:42',
          request: { title: 'Pregunta con dos puntos', fields: [{ key: 'note', type: 'string', title: 'Nota' }] },
          observedAt: 1700000000000 },
      ],
      resolved: [],
      readErrors: [],
    },
  };
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(execId, { status: 'running', sessionID: 'ses:root:1' })] }),
    detail: () => jsonResponse(colonDetail),
  });
  await page.locator(`[data-id="${execId}"]`).click();
  await page.getByRole('tab', { name: 'Traza' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-selected="true"]')?.textContent === 'Traza');

  const jumpButton = page.getByRole('button', { name: 'Ir a la solicitud' });
  await jumpButton.click();
  await page.waitForFunction(() => location.hash.endsWith('/conversation'));
  await page.waitForFunction(() =>
    document.activeElement?.closest('[data-session="ses:root:1"][data-request="req:form:42"]') !== null);

  await page.getByRole('tab', { name: 'Conversación' }).focus();
  assert.equal(await page.evaluate(() =>
    document.activeElement?.closest('[data-session="ses:root:1"][data-request="req:form:42"]') !== null), false);

  await jumpButton.click();
  await page.waitForFunction(() =>
    document.activeElement?.closest('[data-session="ses:root:1"][data-request="req:form:42"]') !== null);
});

test('UI: sondeo lento de detalle (>1,5 s) no solapa peticiones ni deja de actualizar', { timeout: 120000 }, async t => {
  const slowId = '34343434-bbbb-4343-8343-343434343434';
  let inFlight = 0;
  let maxInFlight = 0;
  let completed = 0;
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(slowId, { status: 'running', sessionID: 'ses_slow' })] }),
    detail: async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise(resolve => setTimeout(resolve, 1800));
      inFlight--;
      completed++;
      return jsonResponse({
        ...detail(slowId),
        execution: execution(slowId, { status: 'running', sessionID: 'ses_slow' }),
        conversation: { entries: [{ text: 'Encargo lento.' }], responses: [{ text: `Respuesta lenta ${completed}.` }] },
      });
    },
  });
  await page.locator(`[data-id="${slowId}"]`).click();
  await waitForText(page, 'Respuesta lenta 1.');
  await waitForText(page, 'Respuesta lenta 2.');
  assert.equal(maxInFlight, 1);
  assert.ok(completed >= 2);
});

const sessions = {
  root: 'ses_root_t',
  childA: 'ses_child_a',
  childB: 'ses_child_b',
  grandchild: 'ses_grandchild',
  orphan: 'ses_orphan_x',
};

const evRef = (arrival, eventID, type) => ({ captureID: 'cap-t', arrival, eventID, type });

const traceNode = (sessionID, overrides = {}) => ({
  sessionID,
  isViewRoot: false,
  agentIDs: [],
  observedParents: [],
  delegations: [],
  relation: 'unknown',
  ...overrides,
});

const fullNodes = () => [
  traceNode(sessions.root, { isViewRoot: true, relation: 'view-root', agentIDs: ['general-prime'] }),
  traceNode(sessions.childA, { agentIDs: ['build'], relation: 'delegation-call-observed',
    delegations: [{ parentSessionID: sessions.root, callID: 'call-a', evidence: evRef(1, 'evt-1', 'session.tool.success') }] }),
  traceNode(sessions.childB, { relation: 'parent-observed-call-unknown', observedParents: [sessions.root] }),
  traceNode(sessions.grandchild, { relation: 'delegation-call-observed',
    delegations: [{ parentSessionID: sessions.childB, callID: 'call-g', evidence: evRef(9, 'evt-9', 'session.tool.success') }] }),
  traceNode(sessions.orphan),
];

const traceInterval = (sessionID, startedAt, endedAt, state, evidence) => ({
  diagnosticVersion: 1,
  type: 'diagnostic.execution-interval',
  projectID: 'prj-t',
  sessionID,
  executionID: null,
  messageID: null,
  callID: null,
  intervalRef: evidence[0] ?? null,
  startedAt,
  endedAt,
  elapsedMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
  durationSource: 'opencode.event.sourceTime',
  outcome: endedAt === null ? 'not-observed' : 'succeeded',
  state,
  reason: null,
  error: null,
  pendingWork: null,
  evidence,
  omissions: [],
});

const traceWait = (sessionID, kind, requestID, startedAt, endedAt, state, evidence) => ({
  diagnosticVersion: 1,
  type: 'diagnostic.wait',
  projectID: 'prj-t',
  sessionID,
  executionID: null,
  messageID: null,
  callID: null,
  kind,
  requestID,
  startedAt,
  endedAt,
  outcome: endedAt === null ? 'not-observed' : 'replied',
  elapsedMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
  durationSource: 'opencode.event.sourceTime',
  state,
  evidence,
  omissions: ['external-actor-not-exposed', 'wait-is-not-proof-that-all-work-stopped'],
});

const fullTrace = executionID => ({
  executionID,
  rootSessionID: sessions.root,
  readable: true,
  selectedSessionID: sessions.root,
  tree: { nodes: fullNodes(), sessionIDs: Object.values(sessions) },
  timeline: {
    intervals: [
      traceInterval(sessions.root, 1000, 3000, 'concluded',
        [evRef(2, 'evt-2', 'session.execution.started'), evRef(3, 'evt-3', 'session.execution.ended')]),
      traceInterval(sessions.childA, 1500, 2500, 'concluded',
        [evRef(4, 'evt-4', 'session.execution.started'), evRef(5, 'evt-5', 'session.execution.ended')]),
      traceInterval(sessions.childB, 1200, 3600, 'concluded',
        [evRef(6, 'evt-6', 'session.execution.started'), evRef(7, 'evt-7', 'session.execution.ended')]),
      traceInterval(sessions.childB, 3700, null, 'unknown', [evRef(8, 'evt-8', 'session.execution.started')]),
      traceInterval(sessions.grandchild, 2000, 2200, 'concluded',
        [evRef(10, 'evt-10', 'session.execution.started'), evRef(11, 'evt-11', 'session.execution.ended')]),
    ],
    waits: [
      traceWait(sessions.root, 'permission', 'perm-1', 3000, 5000, 'not-waiting-or-unknown',
        [evRef(12, 'evt-12', 'permission.asked'), evRef(13, 'evt-13', 'permission.replied')]),
      traceWait(sessions.childB, 'form', 'form-1', 3800, null, 'waiting-external-decision',
        [evRef(14, 'evt-14', 'form.created')]),
    ],
  },
  tools: { attempts: [] },
  metrics: { steps: [], measurements: [], pendingInbox: [],
    coverage: { diagnosticVersion: 1, type: 'diagnostic.metric-coverage', flowElapsedMs: null,
      omissions: ['no-concurrent-duration-sum'], recorderDiagnostics: [] } },
  captureDiagnostics: { diagnosticVersion: 1, type: 'diagnostic.capture-coverage', readiness: 'not-assessed',
    scope: 'capture', sessionID: null, sessions: Object.values(sessions), declarations: [], observed: [],
    omissions: [], diagnostics: [], horizons: [{ captureID: 'cap-t', arrival: 20, observedAt: 1770000000000 }] },
  skills: { observed: [], admitted: [], available: [], definitions: [], environment: [] },
  horizon: '2026-11-27T12:00:00.000Z',
});

const scopedTrace = (executionID, sessionID, nodes, intervals, waits) => ({
  ...fullTrace(executionID),
  selectedSessionID: sessionID,
  tree: { nodes, sessionIDs: nodes.map(node => node.sessionID) },
  timeline: { intervals, waits },
});

const scopedFor = url => {
  const session = url.searchParams.get('session');
  if (session === sessions.childA) {
    return scopedTrace(null, sessions.childA,
      [traceNode(sessions.childA, { isViewRoot: true, relation: 'view-root', agentIDs: ['build'] })],
      fullTrace(null).timeline.intervals.filter(interval => interval.sessionID === sessions.childA), []);
  }
  if (session === sessions.childB) {
    return scopedTrace(null, sessions.childB,
      [traceNode(sessions.childB, { isViewRoot: true, relation: 'view-root' }), traceNode(sessions.grandchild)],
      fullTrace(null).timeline.intervals.filter(interval =>
        [sessions.childB, sessions.grandchild].includes(interval.sessionID)),
      fullTrace(null).timeline.waits.filter(wait => wait.sessionID === sessions.childB));
  }
  if (session === sessions.root) {
    return scopedTrace(null, sessions.root,
      [traceNode(sessions.root, { isViewRoot: true, relation: 'view-root' })],
      fullTrace(null).timeline.intervals.filter(interval => interval.sessionID === sessions.root),
      fullTrace(null).timeline.waits.filter(wait => wait.sessionID === sessions.root));
  }
  return jsonResponse({ error: 'session-not-in-execution' }, 404);
};

const traceNegotiator = executionID => (traceId, url) => {
  const session = url.searchParams.get('session');
  if (session === null) return jsonResponse(fullTrace(traceId));
  return jsonResponse({ ...scopedFor(url), executionID: traceId });
};

const traceExecutionOverrides = executionID => ({
  list: () => jsonResponse({ executions: [execution(executionID, { status: 'succeeded', sessionID: sessions.root })] }),
  detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
  trace: traceNegotiator(executionID),
});

const openTraceTab = async (t, overrides, executionID) => {
  const opened = await openUi(t, overrides);
  await opened.page.locator(`[data-id="${executionID}"]`).click();
  await opened.page.getByRole('heading', { name: `Ejecución ${executionID.slice(0, 8)}` }).waitFor();
  await opened.page.getByRole('tab', { name: 'Traza' }).click();
  await opened.page.waitForFunction(() =>
    document.querySelector('[aria-selected="true"]')?.textContent === 'Traza');
  return opened;
};

test('UI: traza con barra de alcance, árbol acreditado, selección reversible y árbol raíz conservado', { timeout: 120000 }, async t => {
  const traced = 'aaaa1111-0101-4101-8101-010101010101';
  const { app, page } = await openTraceTab(t, traceExecutionOverrides(traced), traced);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url });

  await waitForText(page, 'Alcance: toda la ejecución · 5 sesiones conocidas');
  await page.getByRole('tree').waitFor();
  assert.equal(await page.getByRole('tree').getAttribute('aria-label'), 'Árbol de subejecuciones de la ejecución');
  assert.equal(await page.locator('[role="tree"] > [role="treeitem"]').count(), 2);
  assert.equal(await page.locator('[data-relation="delegation-call-observed"]').count(), 2);
  assert.equal(await page.locator('[data-relation="parent-observed-call-unknown"]').count(), 1);
  assert.equal(await page.locator('[data-relation="unknown"]').count(), 1);
  assert.equal(await page.locator('[data-tree-node="ses_child_b"] [data-tree-node="ses_grandchild"]').count(), 1);
  assert.ok((await page.locator('[data-select-session="ses_root_t"]').innerText()).includes('Sesión raíz'));
  assert.ok((await page.locator('[data-select-session="ses_child_a"]').innerText()).includes('Subejecución ses_child_a'));
  assert.ok((await page.locator('[data-tree-node="ses_child_a"] > div').innerText()).includes('agente: build'));
  assert.ok((await page.locator('[data-tree-node="ses_root_t"] > div').innerText()).includes('agente: general-prime'));

  await page.locator('[data-tree-node="ses_child_a"] summary').click();
  await waitForText(page, 'Padre ses_root_t · llamada call-a · evidencia: cap-t · fila 1 · evento evt-1 (session.tool.success)');
  await page.locator('[data-tree-node="ses_child_b"] > details > summary').click();
  await waitForText(page, 'Padre observado ses_root_t; llamada creadora no observada.');
  await page.locator('[data-tree-node="ses_orphan_x"] summary').click();
  await waitForText(page, 'Relación no observada o excluida; no se deduce ninguna asociación.');

  const scopeBar = page.locator('[data-trace-scope-bar]');
  const before = await scopeBar.boundingBox();
  await page.evaluate(() => window.scrollTo(0, 600));
  await waitForText(page, 'Árbol de subejecuciones');
  const scrolled = await page.evaluate(() => window.scrollY);
  assert.ok(scrolled > 200, `page must scroll for the sticky check, got ${scrolled}`);
  const after = await scopeBar.boundingBox();
  assert.ok(after !== null && before !== null && after.y <= before.y + 1,
    `scope bar must stay sticky, before=${before?.y} after=${after?.y}`);
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.locator('[data-select-session="ses_child_a"]').click();
  await page.waitForFunction(() => location.hash.endsWith('/trace?session=ses_child_a'));
  await waitForText(page, 'Alcance: subejecución');
  await waitForText(page, 'ses_child_a');
  assert.equal(await page.locator('[data-scope-session="ses_child_a"]').count(), 1);
  const timelineText = await page.locator('section[aria-label="Línea temporal"]').innerText();
  assert.ok(timelineText.includes('Subejecución ses_child_a'));
  assert.ok(!timelineText.includes('ses_child_b'));
  assert.ok(!timelineText.includes('ses_root_t'));
  await page.getByRole('button', { name: 'Copiar subejecución' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'ses_child_a');

  assert.equal(await page.locator('[data-tree-node="ses_root_t"]').count(), 1);
  assert.equal(await page.locator('[data-tree-node="ses_child_b"]').count(), 1);
  assert.equal(await page.locator('[data-tree-node="ses_grandchild"]').count(), 1);

  await page.getByRole('button', { name: 'Ver toda la ejecución' }).click();
  await page.waitForFunction(() => location.hash.endsWith('/trace')
    && !location.hash.includes('session'));
  await waitForText(page, 'Alcance: toda la ejecución · 5 sesiones conocidas');
  const fullTimelineText = await page.locator('section[aria-label="Línea temporal"]').innerText();
  assert.ok(fullTimelineText.includes('ses_child_b'));
  assert.ok(fullTimelineText.includes('Sesión raíz'));
});

test('UI: traza tras recarga directa con subejecución mantiene el árbol raíz y acota los datos', { timeout: 120000 }, async t => {
  const traced = 'bbbb2222-0202-4202-8202-020202020202';
  const overrides = traceExecutionOverrides(traced);
  const { app, page } = await openUi(t, overrides);
  await page.goto(`${app.url}/#/executions/${traced}/trace?session=ses_child_b`);
  await page.getByRole('heading', { name: 'Ejecución bbbb2222' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Ejecución bbbb2222' }).waitFor();
  await waitForText(page, 'Alcance: subejecución');
  assert.equal(await page.evaluate(() => location.hash),
    `#/executions/${traced}/trace?session=ses_child_b`);

  assert.equal(await page.locator('[data-tree-node="ses_root_t"]').count(), 1);
  assert.equal(await page.locator('[data-tree-node="ses_child_a"]').count(), 1);
  assert.equal(await page.locator('[data-tree-node="ses_orphan_x"]').count(), 1);
  assert.equal(await page.locator('[role="tree"] > [role="treeitem"]').count(), 2);

  const scopedTimeline = await page.locator('section[aria-label="Línea temporal"]').innerText();
  assert.ok(scopedTimeline.includes('Subejecución ses_child_b'));
  assert.ok(scopedTimeline.includes('Subejecución ses_grandchild'));
  assert.ok(!scopedTimeline.includes('ses_child_a'));
  assert.ok(!scopedTimeline.includes('Sesión raíz ses_root_t'));
  const scaleText = await page.locator('[data-timeline-scale]').innerText();
  assert.ok(scaleText.includes('0 ms'));
  assert.ok(scaleText.includes('1950 ms'));
  assert.ok(scaleText.includes('2600 ms'));
  assert.ok(!scaleText.includes('2800 ms'));

  await page.getByRole('button', { name: 'Ver toda la ejecución' }).click();
  await page.waitForFunction(value => location.hash === value, `#/executions/${traced}/trace`);
  await waitForText(page, 'Alcance: toda la ejecución · 5 sesiones conocidas');
  const fullTimeline = await page.locator('section[aria-label="Línea temporal"]').innerText();
  assert.ok(fullTimeline.includes('ses_child_a'));
  assert.ok(fullTimeline.includes('Sesión raíz'));
  const fullScale = await page.locator('[data-timeline-scale]').innerText();
  assert.ok(fullScale.includes('0 ms'));
  assert.ok(fullScale.includes('2000 ms'));
  assert.ok(fullScale.includes('4000 ms'));
});

test('UI: línea temporal con escala relativa, leyenda, tooltips exactos y aviso único de solapamiento', { timeout: 120000 }, async t => {
  const traced = 'cccc3333-0303-4303-8303-030303030303';
  const page = (await openTraceTab(t, traceExecutionOverrides(traced), traced)).page;

  const legend = page.getByRole('list', { name: 'Leyenda de la línea temporal' });
  await legend.waitFor();
  const legendText = await legend.innerText();
  assert.ok(legendText.includes('Intervalo concluido'));
  assert.ok(legendText.includes('Intervalo abierto (sin cierre observado)'));
  assert.ok(legendText.includes('Espera externa'));
  assert.equal(await page.locator('[data-timeline-session]').count(), 4);
  const scaleText = await page.locator('[data-timeline-scale]').innerText();
  assert.ok(scaleText.includes('0 ms'));
  assert.ok(scaleText.includes('2000 ms'));
  assert.ok(scaleText.includes('4000 ms'));

  const concluded = page.locator('[data-kind="interval"]').first();
  await concluded.hover();
  const concludedTip = page.locator('[role="tooltip"]:visible');
  await concludedTip.waitFor({ state: 'visible' });
  const concludedText = await concludedTip.innerText();
  assert.ok(concludedText.includes('Intervalo · concluida'));
  assert.ok(concludedText.includes('Inicio: 1970-01-01T00:00:01.000Z'));
  assert.ok(concludedText.includes('Fin: 1970-01-01T00:00:03.000Z'));
  assert.ok(concludedText.includes('Duración: 2000 ms'));
  assert.ok(concludedText.includes('Fuente: opencode.event.sourceTime'));
  assert.ok(concludedText.includes('Evidencia: cap-t · fila 2 · evento evt-2 (session.execution.started) | cap-t · fila 3 · evento evt-3 (session.execution.ended)'));
  await page.mouse.move(0, 0);
  await concludedTip.waitFor({ state: 'hidden' });

  await concluded.focus();
  await concludedTip.waitFor({ state: 'visible' });
  assert.ok((await concludedTip.innerText()).includes('Duración: 2000 ms'));
  await concluded.blur();

  const openInterval = page.locator('[data-kind="interval-open"]').first();
  await openInterval.hover();
  await concludedTip.waitFor({ state: 'visible' });
  const openText = await concludedTip.innerText();
  assert.ok(openText.includes('Fin: no observado'));
  assert.ok(openText.includes('Duración: abierto / sin cierre observado'));
  await page.mouse.move(0, 0);

  const wait = page.locator('[data-kind="wait"]').first();
  await wait.hover();
  await concludedTip.waitFor({ state: 'visible' });
  const waitText = await concludedTip.innerText();
  assert.ok(waitText.includes('Espera externa · permiso'));
  assert.ok(waitText.includes('Estado: no esperando o desconocido'));
  assert.ok(waitText.includes('Duración: 2000 ms'));
  assert.ok(waitText.includes('Evidencia: cap-t · fila 12 · evento evt-12 (permission.asked) | cap-t · fila 13 · evento evt-13 (permission.replied)'));
  await page.mouse.move(0, 0);

  const openWait = page.locator('[data-kind="wait-open"]').first();
  await openWait.hover();
  await concludedTip.waitFor({ state: 'visible' });
  const openWaitText = await concludedTip.innerText();
  assert.ok(openWaitText.includes('Espera externa · pregunta'));
  assert.ok(openWaitText.includes('Estado: esperando decisión externa'));
  assert.ok(openWaitText.includes('Duración: abierto / sin cierre observado'));
  await page.mouse.move(0, 0);

  const bodyText = await page.evaluate(() => document.body.innerText);
  assert.equal((bodyText.match(/orden causal global/g) ?? []).length, 1);
  assert.equal((bodyText.match(/duración total/g) ?? []).length, 1);
  assert.equal((bodyText.match(/Duración total/g) ?? []).length, 0);
  assert.equal((bodyText.match(/Tiempo total/g) ?? []).length, 0);

  const emptyId = 'dddd4444-0404-4404-8404-040404040404';
  const emptyOverrides = {
    list: () => jsonResponse({ executions: [
      execution(traced, { status: 'succeeded', sessionID: sessions.root }),
      execution(emptyId, { status: 'succeeded', sessionID: 'ses_empty_z' }),
    ] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: 'ses_empty_z' }) }),
    trace: (traceId, url) => (url.searchParams.get('session') === null && traceId === emptyId
      ? jsonResponse({ ...fullTrace(traceId), selectedSessionID: 'ses_empty_z',
        rootSessionID: 'ses_empty_z', timeline: { intervals: [], waits: [] },
        tree: { nodes: [traceNode('ses_empty_z', { isViewRoot: true, relation: 'view-root' })], sessionIDs: ['ses_empty_z'] } })
      : traceNegotiator(traceId)(traceId, url)),
  };
  const { page: emptyPage } = await openTraceTab(t, emptyOverrides, emptyId);
  await waitForText(emptyPage, 'Sin intervalos ni esperas observados en el alcance actual de la evidencia.');
});

test('UI: subnavegación de la traza entre sus cuatro dimensiones diagnósticas', { timeout: 120000 }, async t => {
  const traced = 'eeee5555-0505-4505-8505-050505050505';
  const page = (await openTraceTab(t, traceExecutionOverrides(traced), traced)).page;
  const subTabs = ['Árbol y línea temporal', 'Herramientas e intentos', 'Métricas', 'Skills y cobertura'];
  assert.deepEqual(await page.getByRole('tablist', { name: 'Dimensiones diagnósticas de la traza' })
    .getByRole('tab').allInnerTexts(), subTabs);

  const subTab = name => page.getByRole('tablist', { name: 'Dimensiones diagnósticas de la traza' })
    .getByRole('tab', { name });
  await subTab('Herramientas e intentos').click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-tools')?.getAttribute('aria-selected') === 'true');
  await waitForText(page, 'Alcance activo: toda la ejecución · 5 sesiones conocidas');
  await subTab('Métricas').click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-metrics')?.getAttribute('aria-selected') === 'true');
  assert.ok((await page.locator('#traza-panel-metrics').innerText()).includes('Alcance activo: toda la ejecución'));
  await subTab('Skills y cobertura').click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-skills-coverage')?.getAttribute('aria-selected') === 'true');
  await subTab('Árbol y línea temporal').click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-tree')?.getAttribute('aria-selected') === 'true');
  await page.getByRole('tree').waitFor();

  await page.locator('[data-select-session="ses_child_a"]').click();
  await page.waitForFunction(() => location.hash.endsWith('/trace?session=ses_child_a'));
  await subTab('Métricas').click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-metrics')?.getAttribute('aria-selected') === 'true');
  await waitForText(page, 'Alcance activo: subejecución ses_child_a');
});

test('UI: alcance sincronizado con Entregables y reinicio desde su barra', { timeout: 120000 }, async t => {
  const traced = 'ffff6666-0606-4606-8606-060606060606';
  const overrides = {
    ...traceExecutionOverrides(traced),
    deliverables: (id, url) => {
      const session = url.searchParams.get('session');
      if (session === sessions.childA) {
        return jsonResponse(singleSessionDeliverables(id, sessions.childA, deliverablesGroups()[1]));
      }
      return jsonResponse(fullDeliverables(id));
    },
  };
  const page = (await openTraceTab(t, overrides, traced)).page;
  await page.locator('[data-select-session="ses_child_a"]').click();
  await page.waitForFunction(() => location.hash.endsWith('/trace?session=ses_child_a'));

  await page.getByRole('tab', { name: 'Entregables' }).click();
  await page.waitForFunction(value => location.hash === value,
    `#/executions/${traced}/deliverables?session=ses_child_a`);
  const scope = page.getByRole('region', { name: 'Alcance de los entregables' });
  await scope.waitFor();
  await waitForText(page, 'Consulta de una sola sesión (ses_child_a)');
  const scopeText = await scope.innerText();
  assert.ok(scopeText.includes('Alcance: subejecución'));
  assert.ok(scopeText.includes('ses_child_a'));
  assert.ok(scopeText.includes('Consulta de una sola sesión (ses_child_a)'));
  assert.ok(scopeText.includes('no incluye los entregables de sus descendientes'));

  await page.getByRole('button', { name: 'Ver toda la ejecución' }).click();
  await page.waitForFunction(value => location.hash === value, `#/executions/${traced}/deliverables`);
  await waitForText(page, 'Alcance: toda la ejecución');
  assert.equal(await page.getByRole('button', { name: 'Ver toda la ejecución' }).count(), 0);

  await page.getByRole('tab', { name: 'Traza' }).click();
  await page.waitForFunction(value => location.hash === value, `#/executions/${traced}/trace`);
  await waitForText(page, 'Alcance: toda la ejecución · 5 sesiones conocidas');
});

test('UI: respuestas obsoletas de traza no sobrescriben el alcance activo', { timeout: 120000 }, async t => {
  const traced = '11117777-0707-4707-8707-070707070707';
  const overrides = {
    ...traceExecutionOverrides(traced),
    trace: async (traceId, url) => {
      const session = url.searchParams.get('session');
      if (session === sessions.childA) {
        await new Promise(resolve => setTimeout(resolve, 750));
        return jsonResponse({ ...scopedFor(url), executionID: traceId });
      }
      return traceNegotiator(traceId)(traceId, url);
    },
  };
  const page = (await openTraceTab(t, overrides, traced)).page;
  await page.getByRole('tree').waitFor();
  await page.locator('[data-select-session="ses_child_a"]').click();
  await page.locator('[data-select-session="ses_child_b"]').click();
  await page.waitForFunction(() => location.hash.endsWith('/trace?session=ses_child_b'));
  await waitForText(page, '2600 ms');
  assert.equal(await page.locator('[data-scope-session="ses_child_b"]').count(), 1);
  await page.waitForTimeout(1600);
  await waitForText(page, '2600 ms');
  assert.equal(await page.locator('[data-scope-session="ses_child_b"]').count(), 1);
  assert.equal(await page.evaluate(() => location.hash.endsWith('/trace?session=ses_child_b')), true);
  const bodyText = await page.evaluate(() => document.body.innerText);
  assert.ok(!bodyText.includes('750 ms'));
  const timelineText = await page.locator('section[aria-label="Línea temporal"]').innerText();
  assert.ok(!timelineText.includes('ses_child_a'));
  assert.ok(timelineText.includes('Subejecución ses_child_b'));
});

test('UI: traza ilegible manejada con honestidad en alcance, árbol y línea temporal', { timeout: 120000 }, async t => {
  const traced = '22228888-0808-4808-8808-080808080808';
  const overrides = {
    list: () => jsonResponse({ executions: [execution(traced, { status: 'succeeded', sessionID: 'ses_root_t' })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: 'ses_root_t' }) }),
    trace: traceId => jsonResponse({ executionID: traceId, rootSessionID: 'ses_root_t',
      readable: false, reason: 'reader-timeout' }),
  };
  const page = (await openTraceTab(t, overrides, traced)).page;
  await waitForText(page, 'La traza no está consultable (reader-timeout); no se reconstruye contenido no capturado.');
  await waitForText(page, 'El árbol completo de la ejecución no está consultable (reader-timeout); no se deducen relaciones.');
  await waitForText(page, 'Alcance: toda la ejecución · sesiones conocidas: no observadas');
  assert.equal(await page.getByRole('tree').count(), 0);
  assert.equal(await page.locator('[data-timeline-session]').count(), 0);

  await page.getByRole('tab', { name: 'Métricas' }).click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-metrics')?.getAttribute('aria-selected') === 'true');
  await waitForText(page, 'Alcance activo: toda la ejecución');
});

test('UI: cambio a subejecución lenta limpia de inmediato la anterior y raíz no duplica sondeo', { timeout: 120000 }, async t => {
  const traced = '33339999-0909-4909-8909-090909090909';
  let releaseChildB;
  const childBGate = new Promise(resolve => { releaseChildB = resolve; });
  const traceRequests = [];
  const overrides = {
    ...traceExecutionOverrides(traced),
    trace: async (traceId, url) => {
      const session = url.searchParams.get('session');
      traceRequests.push(session);
      if (session === sessions.childB) {
        await childBGate;
        return jsonResponse({ ...scopedFor(url), executionID: traceId });
      }
      return traceNegotiator(traceId)(traceId, url);
    },
  };
  const page = (await openTraceTab(t, overrides, traced)).page;
  await page.getByRole('tree').waitFor();

  await page.locator('[data-select-session="ses_child_a"]').click();
  await page.waitForFunction(() => location.hash.endsWith('/trace?session=ses_child_a'));
  await waitForText(page, 'Subejecución ses_child_a');
  assert.equal(await page.locator('[data-timeline-session="ses_child_a"]').count(), 1);

  await page.locator('[data-select-session="ses_child_b"]').click();
  await page.waitForFunction(() => location.hash.endsWith('/trace?session=ses_child_b'));
  await waitForText(page, 'Consultando la traza de este alcance…');
  assert.equal(await page.locator('[data-scope-session="ses_child_b"]').count(), 1);
  assert.equal(await page.locator('[data-timeline-session="ses_child_a"]').count(), 0);

  releaseChildB();
  await page.locator('[data-timeline-session="ses_child_b"]').waitFor();
  assert.equal(await page.locator('[data-timeline-session="ses_child_a"]').count(), 0);

  const rootScopedBefore = traceRequests.filter(entry => entry === sessions.root).length;
  await page.locator('[data-select-session="ses_root_t"]').click();
  await page.waitForFunction(() => location.hash.endsWith('/trace?session=ses_root_t'));
  await waitForText(page, 'Alcance: sesión raíz');
  await page.waitForTimeout(400);
  const rootScopedAfter = traceRequests.filter(entry => entry === sessions.root).length;
  assert.equal(rootScopedAfter, rootScopedBefore);
});

test('UI: línea temporal honesta con esperas sin inicio, escala cero/vacía, límites, accesibilidad y desenlaces', { timeout: 120000 }, async t => {
  const richId = '4444aaaa-1010-4010-8010-101010101010';
  const zeroId = '5555bbbb-1111-4111-8111-111111111111';
  const unplottedOnlyId = '6666cccc-1212-4212-8212-121212121212';
  const richTrace = {
    ...fullTrace(richId),
    timeline: {
      intervals: [
        traceInterval(sessions.root, 1000, 1400, 'concluded',
          [evRef(1, 'evt-r1', 'session.execution.started'), evRef(2, 'evt-r2', 'session.execution.ended')]),
        { ...traceInterval(sessions.childA, 1200, 1700, 'failed',
          [evRef(3, 'evt-f1', 'session.execution.started'), evRef(4, 'evt-f2', 'session.execution.failed')]),
        outcome: 'failed' },
        { ...traceInterval(sessions.childB, 1400, 1900, 'interrupted',
          [evRef(5, 'evt-i1', 'session.execution.started'), evRef(6, 'evt-i2', 'session.execution.interrupted')]),
        outcome: 'interrupted' },
        traceInterval(sessions.grandchild, 2000, null, 'unknown',
          [evRef(7, 'evt-o1', 'session.execution.started')]),
      ],
      waits: [
        traceWait(sessions.root, 'permission', 'perm-unstarted', null, 5000, 'not-waiting-or-unknown',
          [evRef(8, 'evt-w1', 'permission.replied')]),
      ],
    },
  };
  const zeroSpanTrace = {
    ...fullTrace(zeroId),
    timeline: {
      intervals: [
        traceInterval(sessions.root, 2000, 2000, 'concluded',
          [evRef(1, 'evt-z1', 'session.execution.started'), evRef(2, 'evt-z2', 'session.execution.ended')]),
      ],
      waits: [],
    },
  };
  const unplottedOnlyTrace = {
    ...fullTrace(unplottedOnlyId),
    timeline: {
      intervals: [],
      waits: [
        traceWait(sessions.root, 'form', 'form-unstarted', null, 5000, 'not-waiting-or-unknown',
          [evRef(1, 'evt-u1', 'form.replied')]),
      ],
    },
  };
  const tracesById = new Map([
    [richId, richTrace],
    [zeroId, zeroSpanTrace],
    [unplottedOnlyId, unplottedOnlyTrace],
  ]);
  const overrides = {
    list: () => jsonResponse({ executions: [
      execution(richId, { status: 'succeeded', sessionID: sessions.root }),
      execution(zeroId, { status: 'succeeded', sessionID: sessions.root }),
      execution(unplottedOnlyId, { status: 'succeeded', sessionID: sessions.root }),
    ] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
    trace: traceId => jsonResponse(tracesById.get(traceId)),
  };
  const { page } = await openTraceTab(t, overrides, richId);

  const scaleText = await page.locator('[data-timeline-scale]').innerText();
  assert.ok(scaleText.includes('0 ms'));
  assert.ok(scaleText.includes('1000 ms'));
  assert.ok(!scaleText.includes('4000 ms'));

  const unplotted = page.locator(`[data-timeline-unplotted="${sessions.root}"]`);
  await unplotted.waitFor();
  const unplottedText = await unplotted.innerText();
  assert.ok(unplottedText.includes('1 espera(s) externa(s) de esta sesión sin inicio observado'));
  assert.ok(unplottedText.includes('permiso'));
  assert.ok(unplottedText.includes('perm-unstarted'));
  assert.ok(unplottedText.includes('1970-01-01T00:00:05.000Z'));

  assert.equal(await page.locator('[data-kind="interval-failed"]').count(), 1);
  assert.equal(await page.locator('[data-kind="interval-interrupted"]').count(), 1);
  assert.equal(await page.locator('[data-kind="interval"]').count(), 1);

  const barChecks = await page.evaluate(() => {
    const bars = Array.from(document.querySelectorAll('section[aria-label="Línea temporal"] [data-kind]'));
    return bars.map(bar => {
      const el = bar;
      const tipId = el.getAttribute('aria-describedby');
      const tip = tipId ? document.getElementById(tipId) : null;
      const left = parseFloat(el.style.left);
      const width = parseFloat(el.style.width);
      return {
        kind: el.getAttribute('data-kind'),
        role: el.getAttribute('role'),
        tipId,
        tipRole: tip?.getAttribute('role') ?? null,
        left,
        width,
        right: left + width,
      };
    });
  });
  assert.equal(barChecks.length, 4);
  const tipIds = new Set(barChecks.map(entry => entry.tipId));
  assert.equal(tipIds.size, barChecks.length);
  for (const entry of barChecks) {
    assert.equal(entry.role, 'img');
    assert.equal(entry.tipRole, 'tooltip');
    assert.ok(entry.left >= 0 && entry.right <= 100.001, `bar ${entry.kind} overflows track: left=${entry.left} width=${entry.width}`);
  }

  const relationClasses = await page.evaluate(() => {
    const badges = Array.from(document.querySelectorAll('[data-relation]'));
    const byRelation = {};
    for (const badge of badges) byRelation[badge.getAttribute('data-relation')] = badge.className;
    return byRelation;
  });
  assert.equal(new Set(Object.values(relationClasses)).size, 4);

  await page.locator(`[data-id="${zeroId}"]`).click();
  await page.getByRole('heading', { name: 'Ejecución 5555bbbb' }).waitFor();
  await page.getByRole('tab', { name: 'Traza' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-selected="true"]')?.textContent === 'Traza');
  const zeroScale = await page.locator('[data-timeline-scale]').innerText();
  assert.ok(zeroScale.includes('0 ms'));
  assert.ok(!zeroScale.includes('1 ms'));

  await page.locator(`[data-id="${unplottedOnlyId}"]`).click();
  await page.getByRole('heading', { name: 'Ejecución 6666cccc' }).waitFor();
  await page.getByRole('tab', { name: 'Traza' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-selected="true"]')?.textContent === 'Traza');
  await waitForText(page, '1 espera(s) externa(s) de esta sesión sin inicio observado');
  assert.equal(await page.locator('[data-timeline-scale]').count(), 0);
});

const toolAttempt = (index, overrides = {}) => ({
  diagnosticVersion: 1,
  type: 'diagnostic.tool-attempt',
  projectID: 'prj-t',
  sessionID: sessions.root,
  executionID: null,
  messageID: `msg_${index}`,
  callID: `call_${index}`,
  toolName: 'read',
  input: { path: `entrada-${index}.txt`, mode: 'utf8' },
  inputText: null,
  output: [{ type: 'text', text: `contenido autorizado sintético ${index}` }],
  error: null,
  outcome: 'success',
  startedAt: 1000 + index * 100,
  calledAt: 1010 + index * 100,
  endedAt: 1200 + index * 100,
  retryOf: null,
  operationID: null,
  consumption: null,
  incident: null,
  evidence: [evRef(30 + index, `evt-tool-${index}`, 'session.tool.success')],
  omissions: [],
  horizons: [{ captureID: 'cap-t', arrival: 20, observedAt: 1770000000000 }],
  ...overrides,
});

const toolsAttempts = () => [
  toolAttempt(0),
  toolAttempt(1, {
    toolName: 'write',
    input: null,
    inputText: 'texto plano de entrada sintético',
    output: null,
    error: { type: 'http-error', message: 'fallo sintético de escritura', status: 503 },
    outcome: 'error',
    incident: { kind: 'tool-error', cause: null },
    evidence: [evRef(31, 'evt-tool-1', 'session.tool.failed')],
  }),
  toolAttempt(2, {
    input: { path: 'entrada-0.txt', mode: 'utf8' },
    output: null,
    error: null,
    outcome: 'not-observed',
    endedAt: null,
    incident: { kind: 'outcome-not-observed', cause: null },
    omissions: ['call-start-not-observed'],
    evidence: [evRef(32, 'evt-tool-2', 'session.tool.input.started')],
  }),
  toolAttempt(3, {
    toolName: 'bash',
    input: null,
    inputText: null,
    output: null,
    error: null,
    outcome: 'not-observed',
    startedAt: null,
    endedAt: null,
    incident: { kind: 'outcome-not-observed', cause: null },
    omissions: ['incomplete-call-identity', 'call-start-not-observed'],
    evidence: [evRef(33, 'evt-tool-3', 'session.tool.called')],
  }),
];

const bodyMatches = (page, phrase) => page.evaluate(
  value => (document.body.innerText.match(new RegExp(value, 'g')) ?? []).length, phrase);

test('UI: Herramientas e intentos filtrables con llamadas abiertas, JSON desplegable y aviso único de consumo', { timeout: 120000 }, async t => {
  const traced = 'aaaabbbb-1a1a-4a1a-81a1-1a1a1a1a1a1a';
  let attempts = toolsAttempts();
  const overrides = {
    list: () => jsonResponse({ executions: [execution(traced, { status: 'succeeded', sessionID: sessions.root })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
    trace: traceId => jsonResponse({ ...fullTrace(traceId), tools: { attempts } }),
  };
  const { app, page } = await openTraceTab(t, overrides, traced);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url });
  const subTab = name => page.getByRole('tablist', { name: 'Dimensiones diagnósticas de la traza' })
    .getByRole('tab', { name });
  await subTab('Herramientas e intentos').click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-tools')?.getAttribute('aria-selected') === 'true');
  await page.locator('[data-tool-attempt]').first().waitFor();

  assert.equal(await page.locator('[data-tool-attempt]').count(), 4);
  assert.equal(await page.locator('[data-tool-name="read"]').count(), 2);
  assert.equal(await page.locator('[data-outcome="success"]').count(), 1);
  assert.equal(await page.locator('[data-outcome="error"]').count(), 1);
  assert.equal(await page.locator('[data-outcome="not-observed"]').count(), 2);
  assert.equal(await bodyMatches(page, 'Consumo: desconocido, no cero'), 1);
  assert.equal(await bodyMatches(page, 'No se agrupan reintentos por nombre, argumentos ni proximidad'), 1);
  const openRows = await page.locator('[data-outcome="not-observed"]').allInnerTexts();
  assert.equal(openRows.length, 2);
  assert.ok(openRows.every(row => row.includes('sin desenlace observado')));
  assert.ok(openRows.every(row => !row.includes('éxito observado')));

  await page.getByLabel('Filtrar por nombre de herramienta').fill('write');
  assert.equal(await page.locator('[data-tool-attempt]').count(), 1);
  assert.equal(await page.locator('[data-tool-name="write"]').count(), 1);
  await page.getByLabel('Filtrar por nombre de herramienta').fill('read');
  assert.equal(await page.locator('[data-tool-attempt]').count(), 2);
  await page.getByLabel('Filtrar por desenlace').selectOption('error');
  await waitForText(page, 'Ningún intento coincide con los filtros actuales.');
  await page.getByLabel('Filtrar por nombre de herramienta').fill('');
  assert.equal(await page.locator('[data-tool-attempt]').count(), 1);
  assert.ok((await page.locator('[data-outcome="error"]').innerText()).includes('error observado (fallido)'));
  await page.getByLabel('Filtrar por desenlace').selectOption('not-observed');
  assert.equal(await page.locator('[data-tool-attempt]').count(), 2);
  await page.getByLabel('Filtrar por desenlace').selectOption('');
  assert.equal(await page.locator('[data-tool-attempt]').count(), 4);

  await page.locator('details[data-disclosure="input"] summary').first().click();
  const inputJson = await page.locator('details[data-disclosure="input"] pre').first().innerText();
  assert.ok(inputJson.includes('"path": "entrada-0.txt"'));
  assert.ok(inputJson.includes('"mode": "utf8"'));
  assert.ok(inputJson.includes('\n'));
  await page.locator('details[data-disclosure="input"]').first().getByRole('button', { name: 'Copiar JSON' }).click();
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), inputJson);
  await page.locator('details[data-disclosure="output"] summary').first().click();
  assert.ok((await page.locator('details[data-disclosure="output"] pre').first().innerText()).includes('"type": "text"'));
  await page.locator('[data-outcome="error"] details[data-disclosure="error"] summary').click();
  const errorJson = await page.locator('[data-outcome="error"] details[data-disclosure="error"] pre').innerText();
  assert.ok(errorJson.includes('"status": 503'));
  assert.ok((await page.locator('[data-outcome="error"]').innerText()).includes('Resultado: no observado o no autorizado.'));
  assert.ok((await page.locator('[data-tool-name="bash"]').innerText()).includes('Entrada: no observada o no autorizada.'));

  await page.locator('details[data-disclosure="forensics"] summary').first().click();
  const forensics = await page.locator('details[data-disclosure="forensics"]').first().innerText();
  assert.ok(forensics.includes('ses_root_t'));
  assert.ok(forensics.includes('msg_0'));
  assert.ok(forensics.includes('call_0'));
  assert.ok(forensics.includes('evt-tool-0'));
  assert.ok(forensics.includes('1970-01-01T00:00:01.000Z'));
  await page.locator('details[data-disclosure="forensics"]').first().getByRole('button', { name: 'Copiar llamada' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'call_0');
  await page.locator('details[data-disclosure="forensics"] summary').nth(2).click();
  assert.ok((await page.locator('details[data-disclosure="forensics"]').nth(2).innerText()).includes('Omisiones: call-start-not-observed'));

  await page.getByLabel('Filtrar por nombre de herramienta').fill('read');
  assert.equal(await page.locator('[data-tool-attempt]').count(), 2);
  attempts = [...toolsAttempts(), toolAttempt(9, { toolName: 'read' })];
  await page.waitForFunction(() => document.querySelectorAll('[data-tool-attempt]').length === 3);
  assert.equal(await page.getByLabel('Filtrar por nombre de herramienta').inputValue(), 'read');
  assert.equal(await page.locator('details[data-disclosure="input"]').first().getAttribute('open'), '');
});

const metric = (value, source, scope, status) => ({ value, status: status ?? (value === null ? 'unknown' : 'observed'),
  source: value === null ? null : source, scope });

const metricStep = (index, overrides = {}) => ({
  diagnosticVersion: 1,
  type: 'diagnostic.model-step',
  projectID: 'prj-t',
  sessionID: sessions.root,
  executionID: null,
  messageID: `msg_m${index}`,
  callID: null,
  model: metric({ providerID: 'synthetic', id: `model-${index}` }, 'opencode.event.session.step.started.model', 'model-step'),
  tokens: { ...metric({ input: 120 + index, output: 34, reasoning: 5, cache: { read: 10, write: 2 } },
    'opencode.event.session.step.ended.tokens', 'model-step'), basis: 'runtime-normalized-unverified', providerReported: null },
  costUSD: { ...metric(0.042, 'opencode.event.session.step.ended.cost', 'model-step', 'estimated'), basis: 'runtime-estimate-not-invoice' },
  startedAt: 1000,
  streamedAt: 1100,
  endedAt: 2500,
  elapsedMs: 1500,
  providerBodyMs: 100,
  outcome: 'ended',
  state: 'ended',
  finish: 'stop',
  error: null,
  durationSource: 'opencode.event.session.step.started.started-to-terminal.sourceTime',
  skillConsumption: null,
  dispatches: [],
  retries: [],
  results: [],
  evidence: [evRef(40 + index, `evt-metric-${index}`, 'session.step.ended')],
  omissions: [],
  ...overrides,
});

const metricsFixture = () => ({
  steps: [
    metricStep(0),
    metricStep(1, {
      model: metric(null, null, 'model-step'),
      tokens: { ...metric(null, null, 'model-step'), basis: 'runtime-normalized-unverified', providerReported: null },
      costUSD: { ...metric(null, null, 'model-step'), basis: 'runtime-estimate-not-invoice' },
      startedAt: null,
      streamedAt: null,
      endedAt: null,
      elapsedMs: null,
      providerBodyMs: null,
      outcome: 'not-observed',
      finish: null,
      dispatches: [
        { startedAt: 5000, model: metric({ providerID: 'synthetic', id: 'model-1' }, 'opencode.event.session.step.started.model', 'model-step'), tokens: null, costUSD: null, evidence: evRef(41, 'evt-dispatch-a', 'session.step.started') },
        { startedAt: 6200, model: metric({ providerID: 'synthetic', id: 'model-1' }, 'opencode.event.session.step.started.model', 'model-step'), tokens: null, costUSD: null, evidence: evRef(42, 'evt-dispatch-b', 'session.step.started') },
      ],
      retries: [{ kind: 'model', attempt: 2, at: 6100,
        error: { type: 'http-error', message: 'demasiadas peticiones sintéticas', status: 429 },
        tokens: null, costUSD: null, scheduledDelayMs: 250, actualWaitMs: null, evidence: evRef(43, 'evt-retry-1', 'session.step.ended') }],
      results: [],
      omissions: ['multiple-step-results-not-collapsed', 'multiple-dispatches-body-duration-not-attributable'],
    }),
  ],
  measurements: [{
    diagnosticVersion: 1,
    type: 'diagnostic.measurement',
    projectID: 'prj-t',
    sessionID: sessions.childA,
    executionID: null,
    messageID: null,
    callID: null,
    kind: 'compaction',
    model: metric(null, null, 'compaction'),
    tokens: { ...metric({ input: 80, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      'opencode.event.session.compaction.ended.tokens', 'compaction'), basis: 'runtime-normalized-unverified', providerReported: null },
    costUSD: { ...metric(0, 'opencode.event.session.compaction.ended.cost', 'compaction', 'estimated'), basis: 'runtime-estimate-not-invoice' },
    outcome: 'ended',
    error: null,
    evidence: [evRef(45, 'evt-compaction-1', 'session.compaction.ended')],
    omissions: [],
  }],
  pendingInbox: [
    { diagnosticVersion: 1, type: 'diagnostic.pending-inbox', projectID: 'prj-t', sessionID: sessions.root,
      executionID: null, messageID: 'msg_pending_root', callID: null, state: 'delivery-not-observed',
      evidence: [evRef(50, 'evt-inbox-root', 'session.inbox.enqueued')],
      omissions: ['execution-and-completion-not-implied'] },
    { diagnosticVersion: 1, type: 'diagnostic.pending-inbox', projectID: 'prj-t', sessionID: sessions.childA,
      executionID: null, messageID: 'msg_pending_sub', callID: null, state: 'unknown',
      evidence: [evRef(51, 'evt-inbox-sub', 'session.inbox.enqueued')],
      omissions: ['execution-and-completion-not-implied', 'inbox-resolution-order-not-established'] },
  ],
  coverage: { diagnosticVersion: 1, type: 'diagnostic.metric-coverage', flowElapsedMs: null,
    omissions: ['no-concurrent-duration-sum', 'billed-cost-not-exposed'],
    recorderDiagnostics: [{ captureID: 'cap-t', arrival: 5, eventID: null, type: 'recorder.gap',
      reason: 'unrecognized-session-envelope' }] },
});

test('UI: Métricas en tabla con tokens desglosados, desconocidos sin cero, consumo normalizado, despachos e inbox', { timeout: 120000 }, async t => {
  const traced = 'bbbbcccc-2b2b-4b2b-82b2-2b2b2b2b2b2b';
  const overrides = {
    list: () => jsonResponse({ executions: [execution(traced, { status: 'succeeded', sessionID: sessions.root })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
    trace: traceId => jsonResponse({ ...fullTrace(traceId), metrics: metricsFixture() }),
  };
  const page = (await openTraceTab(t, overrides, traced)).page;
  await page.getByRole('tablist', { name: 'Dimensiones diagnósticas de la traza' })
    .getByRole('tab', { name: 'Métricas' }).click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-metrics')?.getAttribute('aria-selected') === 'true');
  await page.locator('table[data-metrics-steps]').waitFor();

  const headers = await page.locator('table[data-metrics-steps] thead th').allInnerTexts();
  for (const expected of ['Sesión', 'Mensaje', 'Modelo', 'Entrada', 'Salida', 'Razonamiento', 'Caché lectura', 'Caché escritura', 'Coste (USD, estimado)', 'Duración', 'Desenlace']) {
    assert.ok(headers.some(header => header.includes(expected)), `missing metrics column header ${expected}`);
  }
  const stepsText = await page.locator('table[data-metrics-steps]').innerText();
  assert.ok(stepsText.includes('synthetic/model-0'));
  assert.ok(stepsText.includes('120'));
  assert.ok(stepsText.includes('34'));
  assert.ok(stepsText.includes('5'));
  assert.ok(stepsText.includes('10'));
  assert.ok(stepsText.includes('2'));
  assert.ok(stepsText.includes('0.042 USD'));
  assert.ok(stepsText.includes('1500 ms'));
  assert.ok(!stepsText.includes('"input"'));
  assert.ok(!stepsText.includes('{"input"'));
  assert.ok(!stepsText.includes('JSON.'));
  const unknownRow = page.locator('[data-metric-step-row]').nth(1);
  await unknownRow.waitFor();
  for (const column of ['input', 'output', 'reasoning', 'cache.read', 'cache.write']) {
    assert.equal(await unknownRow.locator(`[data-token-column="${column}"]`).innerText(), 'desconocido');
  }
  assert.equal(await unknownRow.locator('[data-metric-cost]').innerText(), 'desconocido');
  assert.equal(await unknownRow.locator('[data-metric-duration]').innerText(), 'desconocido');
  assert.ok((await unknownRow.innerText()).includes('sin desenlace observado'));

  const notices = await page.locator('#panel-trace').innerText();
  assert.ok(notices.includes('valor normalizado que informa el runtime'));
  assert.ok(notices.includes('no prueba el consumo original del proveedor'));
  assert.ok(notices.includes('estimación del runtime, no una factura'));
  assert.ok(notices.includes('permanece desconocido, nunca cero'));
  assert.ok(notices.includes('Alcance activo: toda la ejecución'));

  await page.locator('details[data-metric-details] summary').nth(1).click();
  const detailsText = await page.locator('details[data-metric-details]').nth(1).innerText();
  assert.ok(detailsText.includes('Despachos observados: 2'));
  assert.ok(detailsText.includes('Reintentos de modelo observados: 1'));
  assert.ok(detailsText.includes('429'));
  assert.ok(detailsText.includes('consumo y espera real por intento desconocidos'));
  assert.ok(detailsText.includes('Fuente de duración: opencode.event.session.step.started.started-to-terminal.sourceTime'));

  await page.locator('details[data-metric-details] summary').nth(0).click();
  const firstDetailsText = await page.locator('details[data-metric-details]').nth(0).innerText();
  assert.ok(firstDetailsText.includes('opencode.event.session.step.ended.tokens'));
  assert.ok(firstDetailsText.includes('alcance: model-step'));
  assert.ok(firstDetailsText.includes('runtime-normalized-unverified'));
  assert.ok(firstDetailsText.includes('runtime-estimate-not-invoice'));

  const measurementsText = await page.locator('table[data-metrics-measurements]').innerText();
  assert.ok(measurementsText.includes('compaction'));
  assert.ok(measurementsText.includes('ses_child_a'));
  assert.ok(measurementsText.includes('80'));

  assert.equal(await page.locator('[data-pending-inbox]').count(), 2);
  const inboxText = await page.locator('section[aria-label="Métricas del modelo con fuente y alcance"]').innerText();
  assert.ok(inboxText.includes('Admisión sin entrega observada'));
  assert.ok(inboxText.includes('msg_pending_root'));
  assert.ok(inboxText.includes('msg_pending_sub'));
  assert.ok(inboxText.includes('no se totalizan mensajes entre sesiones'));

  assert.ok(notices.includes('La duración total del flujo no se expone'));
  assert.ok(notices.includes('no se suman ramas concurrentes'));
  assert.ok(notices.includes('billed-cost-not-exposed'));
  assert.ok(notices.includes('unrecognized-session-envelope'));
});

const skillFixture = id => ({
  ...fullTrace(id),
  skills: {
    observed: [{
      sessionID: sessions.root,
      messageID: 'msg_skill_1',
      callID: 'call_skill_1',
      type: 'session.skill',
      skill: { id: 'guardian-parse', name: 'Guardián de sintaxis', text: 'Contenido filtrado sintético de la skill observada.',
        sha256: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
        origin: 'runtime-activation-event', contextID: null, consumption: null },
      evidence: { captureID: 'cap-t', arrival: 60, eventID: 'evt-skill-1' },
    }],
    admitted: [{
      observationTime: 1770000010000, source: 'opencode.session.inbox.skills', identity: null,
      sessionID: sessions.root, messageID: 'msg_skill_1', eventID: null, status: 'captured',
      omissions: [], redactions: [], value: { id: 'admitida-sintetica', name: 'Admitida sintética',
        text: 'texto sintético' },
      sha256: '1111c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
      hashBasis: 'redacted-json-utf8', evidence: { captureID: 'cap-t', arrival: 61, eventID: null },
    }],
    available: [{
      observationTime: 1770000011000, source: 'opencode.skill.list', identity: null,
      sessionID: sessions.root, messageID: null, eventID: null, status: 'captured',
      omissions: [], redactions: [],
      value: [{ id: 'disponible-sintetica', name: 'Disponible sintética', description: 'Skill disponible sintética', autoinvoke: false }],
      sha256: '2222c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
      hashBasis: 'redacted-json-utf8', evidence: { captureID: 'cap-t', arrival: 62, eventID: null },
    }],
    definitions: [
      {
        observationTime: 1770000020000, source: 'opencode.skill.list', identity: 'def-registro',
        sessionID: sessions.root, messageID: null, eventID: null, status: 'captured',
        omissions: [], redactions: [],
        value: { id: 'definicion-registro', name: 'Definición del registro', description: 'Descripción sintética',
          content: 'Contenido filtrado sintético de la definición del registro.', path: '.agents/skills/definicion.md', autoinvoke: false },
        sha256: '3333c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
        hashBasis: 'redacted-json-utf8', evidence: { captureID: 'cap-t', arrival: 63, eventID: null },
      },
      {
        observationTime: 1770000021000, source: 'node.fs.readFile', identity: 'def-desplegado',
        sessionID: sessions.root, messageID: null, eventID: null, status: 'captured',
        omissions: [], redactions: [],
        value: { path: 'skills/desplegado/SKILL.md', content: 'Contenido desplegado sintético.' },
        sha256: '4444c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
        hashBasis: 'redacted-json-utf8', evidence: { captureID: 'cap-t', arrival: 64, eventID: null },
      },
    ],
    environment: [{
      observationTime: 1770000022000, source: 'opencode.plugin.list', identity: null,
      sessionID: sessions.root, messageID: null, eventID: null, status: 'captured',
      omissions: [], redactions: [],
      value: { plugins: [{ id: 'postman-mcp', source: 'package', version: '1.2.3', status: 'active' },
        { id: 'plugin-local', source: 'local', version: null, status: 'failed' }],
      configurationSources: null, transformations: null },
      sha256: '5555c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
      hashBasis: 'redacted-json-utf8', evidence: { captureID: 'cap-t', arrival: 65, eventID: null },
    }],
  },
  captureDiagnostics: {
    diagnosticVersion: 1,
    type: 'diagnostic.capture-coverage',
    readiness: 'not-assessed',
    scope: 'session-tree',
    sessionID: sessions.root,
    sessions: [sessions.root, sessions.childA],
    declarations: [{ schemaVersion: 1, captureID: 'cap-t', arrival: 1, observedAt: 1770000000000,
      type: 'recorder.ready', runtimeVersion: '2.1.2-synthetic', sdkVersion: '2.1.2',
      coverage: { replay: false, content: ['texto'], excluded: [], executionID: 'not-exposed', ordering: 'arrival-is-not-causality' } }],
    observed: [{ type: 'session.tool.success', source: 'opencode.event', stage: null, status: 'captured', count: 2 },
      { type: 'session.step.ended', source: 'opencode.event', stage: null, status: null, count: 1 }],
    omissions: ['flow-boundaries-not-exposed'],
    diagnostics: [{ captureID: 'cap-t', arrival: 5, observedAt: 1770000000000, type: 'recorder.gap',
      reason: 'unrecognized-session-envelope' }],
    horizons: [{ captureID: 'cap-t', arrival: 20, observedAt: 1770000000000 },
      { captureID: 'cap-u', arrival: 30, observedAt: 1770000099999 }],
  },
});

test('UI: Skills y cobertura con separación estricta, lecturas posteriores al hecho y not-assessed', { timeout: 120000 }, async t => {
  const traced = 'ccccdddd-3c3c-4c3c-83c3-3c3c3c3c3c3c';
  const overrides = {
    list: () => jsonResponse({ executions: [execution(traced, { status: 'succeeded', sessionID: sessions.root })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
    trace: traceId => jsonResponse(skillFixture(traceId)),
  };
  const { app, page } = await openTraceTab(t, overrides, traced);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url });
  await page.getByRole('tablist', { name: 'Dimensiones diagnósticas de la traza' })
    .getByRole('tab', { name: 'Skills y cobertura' }).click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-skills-coverage')?.getAttribute('aria-selected') === 'true');

  const observedSection = page.locator('section[data-skills-observed]');
  await observedSection.waitFor();
  const observedText = await observedSection.innerText();
  assert.ok(observedText.includes('Guardián de sintaxis'));
  assert.ok(observedText.includes('evento público de activación del runtime'));
  assert.ok(observedText.includes('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'));
  assert.ok(observedText.includes('activación o carga efectiva'));
  assert.ok(!observedText.includes('Disponible sintética'));
  await observedSection.locator('details[data-disclosure="skill-content"] summary').click();
  assert.ok((await observedSection.innerText()).includes('Contenido filtrado sintético de la skill observada.'));

  const admittedSection = page.locator('section[data-skills-admitted]');
  const admittedText = await admittedSection.innerText();
  assert.ok(admittedText.includes('admitida-sintetica'));
  assert.ok(admittedText.includes('la admisión no prueba despacho por el modelo'));

  const availableSection = page.locator('section[data-skills-available]');
  const availableText = await availableSection.innerText();
  assert.ok(availableText.includes('disponible-sintetica'));
  assert.ok(availableText.includes('no prueba uso'));
  assert.ok(!availableText.includes('Guardián de sintaxis'));

  const definitionsSection = page.locator('section[data-skills-definitions]');
  const definitionsText = await definitionsSection.innerText();
  assert.ok(definitionsText.includes('Definición observada (opencode.skill.list)'));
  assert.ok(definitionsText.includes('lecturas posteriores al hecho'));
  assert.ok(definitionsText.includes('Ruta: .agents/skills/definicion.md'));
  assert.ok(definitionsText.includes('Definición observada (node.fs.readFile)'));
  await definitionsSection.getByRole('button', { name: 'Copiar SHA-256' }).first().click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()),
    '3333c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2');
  await definitionsSection.locator('details[data-disclosure="skill-content"] summary').first().click();
  assert.ok((await definitionsSection.innerText()).includes('Contenido filtrado sintético de la definición del registro.'));

  const environmentSection = page.locator('section[data-plugin-environment]');
  const environmentText = await environmentSection.innerText();
  assert.ok(environmentText.includes('postman-mcp'));
  assert.ok(environmentText.includes('lectura posterior al hecho'));
  assert.ok(environmentText.includes('activo'));

  const coverageSection = page.locator('section[data-capture-coverage]');
  const coverageText = await coverageSection.innerText();
  assert.ok(coverageText.includes('Disposición: sin evaluar (readiness: not-assessed)'));
  assert.ok(coverageText.includes('no son una evaluación'));
  assert.ok(coverageText.includes('la ausencia de incidentes no equivale a una aceptación'));
  assert.ok(coverageText.includes('runtime 2.1.2-synthetic'));
  assert.ok(coverageText.includes('ses_child_a'));

  await coverageSection.locator('details[data-coverage-observed] summary').click();
  assert.ok((await coverageSection.locator('details[data-coverage-observed]').innerText()).includes('session.tool.success'));
  await coverageSection.locator('details[data-coverage-omissions] summary').click();
  assert.ok((await coverageSection.locator('details[data-coverage-omissions]').innerText()).includes('flow-boundaries-not-exposed'));
  await coverageSection.locator('details[data-coverage-diagnostics] summary').click();
  assert.ok((await coverageSection.locator('details[data-coverage-diagnostics]').innerText()).includes('recorder.gap'));
  await coverageSection.locator('details[data-coverage-horizons] summary').click();
  const horizonsText = await coverageSection.locator('details[data-coverage-horizons]').innerText();
  assert.ok(horizonsText.includes('cap-u'));
  assert.ok(horizonsText.includes('hasta la fila 30'));
});

test('UI: cambio de subejecución acota las tres subvistas sin mezclar sesiones', { timeout: 120000 }, async t => {
  const traced = 'ddddeeee-4d4d-4d4d-84d4-4d4d4d4d4d4d';
  const childScoped = {
    ...fullTrace(traced),
    selectedSessionID: sessions.childA,
    tree: { nodes: [traceNode(sessions.childA, { isViewRoot: true, relation: 'view-root' })],
      sessionIDs: [sessions.childA] },
    timeline: { intervals: [], waits: [] },
    tools: { attempts: [toolAttempt(20, { sessionID: sessions.childA, toolName: 'child-tool' })] },
    metrics: { steps: [metricStep(20, { sessionID: sessions.childA })], measurements: [],
      pendingInbox: metricsFixture().pendingInbox.filter(item => item.sessionID === sessions.childA),
      coverage: metricsFixture().coverage },
    skills: { observed: [{
      sessionID: sessions.childA, messageID: 'msg_skill_child', callID: 'call_skill_child', type: 'session.skill',
      skill: { id: 'skill-hija', name: 'Skill hija sintética', text: 'Contenido de la skill hija.',
        sha256: '9999c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
        origin: 'successful-skill-tool-result', contextID: null, consumption: null },
      evidence: { captureID: 'cap-t', arrival: 70, eventID: 'evt-skill-child' },
    }], admitted: [], available: [], definitions: [], environment: [] },
  };
  const overrides = {
    list: () => jsonResponse({ executions: [execution(traced, { status: 'succeeded', sessionID: sessions.root })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
    trace: (traceId, url) => jsonResponse(url.searchParams.get('session') === null
      ? { ...fullTrace(traceId), tools: { attempts: toolsAttempts() }, metrics: metricsFixture() }
      : { ...childScoped, executionID: traceId }),
  };
  const page = (await openTraceTab(t, overrides, traced)).page;
  const subTab = name => page.getByRole('tablist', { name: 'Dimensiones diagnósticas de la traza' })
    .getByRole('tab', { name });
  await subTab('Herramientas e intentos').click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-tools')?.getAttribute('aria-selected') === 'true');
  await page.locator('[data-tool-attempt]').first().waitFor();
  assert.equal(await page.locator('[data-tool-attempt]').count(), 4);

  await subTab('Árbol y línea temporal').click();
  await page.locator('[data-select-session="ses_child_a"]').click();
  await page.waitForFunction(() => location.hash.endsWith('/trace?session=ses_child_a'));
  await subTab('Herramientas e intentos').click();
  await page.locator('[data-tool-attempt]').first().waitFor();
  assert.equal(await page.locator('[data-tool-attempt]').count(), 1);
  assert.equal(await page.locator('[data-tool-name="child-tool"]').count(), 1);
  assert.ok((await page.locator('#panel-trace').innerText()).includes('Alcance activo: subejecución ses_child_a'));
  await page.locator('details[data-disclosure="forensics"] summary').click();
  assert.ok((await page.locator('details[data-disclosure="forensics"]').innerText()).includes('ses_child_a'));

  await subTab('Métricas').click();
  await page.locator('table[data-metrics-steps]').waitFor();
  assert.equal(await page.locator('[data-metric-step-row]').count(), 1);
  const scopedMetrics = await page.locator('section[aria-label="Métricas del modelo con fuente y alcance"]').innerText();
  assert.ok(scopedMetrics.includes('ses_child_a'));
  assert.equal(await page.locator('[data-pending-inbox]').count(), 1);

  await subTab('Skills y cobertura').click();
  await page.locator('section[data-skills-observed]').waitFor();
  const scopedSkills = await page.locator('section[data-skills-observed]').innerText();
  assert.ok(scopedSkills.includes('Skill hija sintética'));
  assert.ok(!scopedSkills.includes('Guardián de sintaxis'));
});

test('UI: traza ilegible gestionada con honestidad en las tres subvistas', { timeout: 120000 }, async t => {
  const traced = 'eeeeffff-5e5e-4e5e-85e5-5e5e5e5e5e5e';
  const overrides = {
    list: () => jsonResponse({ executions: [execution(traced, { status: 'succeeded', sessionID: sessions.root })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
    trace: traceId => jsonResponse({ executionID: traceId, rootSessionID: sessions.root,
      readable: false, reason: 'reader-timeout' }),
  };
  const page = (await openTraceTab(t, overrides, traced)).page;
  const subTab = name => page.getByRole('tablist', { name: 'Dimensiones diagnósticas de la traza' })
    .getByRole('tab', { name });
  for (const name of ['Herramientas e intentos', 'Métricas', 'Skills y cobertura']) {
    await subTab(name).click();
    await page.waitForFunction(value => document.querySelector('[role="tabpanel"]')?.textContent?.includes(value),
      `La traza no está consultable (reader-timeout); no se reconstruye contenido no capturado.`);
    assert.ok((await page.locator('#panel-trace').innerText()).includes('Alcance activo: toda la ejecución'));
    assert.equal(await page.locator('[data-tool-attempt], [data-metric-step-row], [data-skills-observed]').count(), 0);
  }
});

test('UI: regresiones #48 en definiciones, plugins, disponibilidad no reconocida, métricas y herramientas', { timeout: 120000 }, async t => {
  const traced = 'ffff1111-6f6f-4f6f-86f6-6f6f6f6f6f6f';
  const regressionTrace = {
    ...skillFixture(traced),
    tools: {
      attempts: [
        toolAttempt(10, {
          callID: null,
          messageID: 'msg_null_a',
          toolName: 'alpha',
          input: null,
          inputText: 'entrada plana alpha',
          output: null,
          outcome: 'error',
          incident: { kind: 'tool-error', cause: 'permiso-denegado-sintetico' },
          evidence: [evRef(80, 'evt-null-a', 'session.tool.failed')],
        }),
        toolAttempt(11, {
          callID: null,
          messageID: 'msg_null_b',
          toolName: 'beta',
          input: null,
          inputText: 'entrada plana beta',
          output: null,
          outcome: 'not-observed',
          incident: { kind: 'outcome-not-observed', cause: null },
          evidence: [evRef(81, 'evt-null-b', 'session.tool.called')],
        }),
      ],
    },
    metrics: {
      ...metricsFixture(),
      steps: [
        metricStep(0, {
          dispatches: [
            { startedAt: 1000, model: metric({ providerID: 'synthetic', id: 'model-0' }, 'opencode.event.session.step.started.model', 'model-step'), tokens: null, costUSD: null, evidence: evRef(90, 'evt-d0', 'session.step.started') },
          ],
          retries: [
            { kind: 'model', attempt: 1, at: 1500,
              error: { type: 'timeout', message: 'tiempo agotado sintético' },
              tokens: null, costUSD: null, scheduledDelayMs: null, actualWaitMs: null,
              evidence: evRef(91, 'evt-r0', 'session.step.failed') },
          ],
        }),
      ],
      measurements: [
        {
          diagnosticVersion: 1,
          type: 'diagnostic.measurement',
          projectID: 'prj-t',
          sessionID: sessions.childA,
          executionID: null,
          messageID: null,
          callID: null,
          kind: 'compaction',
          model: metric({ providerID: 'synthetic', id: 'compact-1' }, 'opencode.event.session.compaction.failed.model', 'compaction'),
          tokens: { ...metric({ input: 80, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
            'opencode.event.session.compaction.failed.tokens', 'compaction'), basis: 'runtime-normalized-unverified', providerReported: null },
          costUSD: { ...metric(0.01, 'opencode.event.session.compaction.failed.cost', 'compaction', 'estimated'), basis: 'runtime-estimate-not-invoice' },
          outcome: 'failed',
          error: { type: 'compaction-error', message: 'fallo de compactación sintético', status: 500 },
          evidence: [evRef(92, 'evt-compaction-fail', 'session.compaction.failed')],
          omissions: ['compaction-summary-not-exposed'],
        },
      ],
    },
    skills: {
      ...skillFixture(traced).skills,
      available: [
        {
          observationTime: 1770000012000,
          source: 'opencode.skill.list',
          identity: null,
          sessionID: sessions.root,
          messageID: null,
          eventID: null,
          status: 'unrecognized',
          omissions: ['unrecognized-skill-list'],
          redactions: [],
          value: null,
          sha256: null,
          hashBasis: 'redacted-json-utf8',
          evidence: { captureID: 'cap-t', arrival: 93, eventID: null },
        },
      ],
      definitions: [
        ...skillFixture(traced).skills.definitions,
        {
          observationTime: 1770000025000,
          source: 'opencode.agent.get',
          identity: 'agent-ident',
          sessionID: sessions.root,
          messageID: null,
          eventID: null,
          status: 'captured',
          omissions: [],
          redactions: [],
          value: {
            id: 'agente-revisor',
            name: 'Agente Revisor',
            mode: 'subagent',
            description: 'Revisa hallazgos sintéticos',
            system: 'Instrucciones del sistema del agente revisor.',
          },
          sha256: '6666c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
          hashBasis: 'redacted-json-utf8',
          evidence: { captureID: 'cap-t', arrival: 94, eventID: null },
        },
      ],
      environment: [
        {
          observationTime: 1770000026000,
          source: 'opencode.plugin.list',
          identity: null,
          sessionID: sessions.root,
          messageID: null,
          eventID: null,
          status: 'captured',
          omissions: [],
          redactions: [],
          value: {
            plugins: [{ id: null, source: 'local', version: null, status: 'active' }],
            configurationSources: null,
            transformations: null,
          },
          sha256: '7777c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
          hashBasis: 'redacted-json-utf8',
          evidence: { captureID: 'cap-t', arrival: 95, eventID: null },
        },
      ],
    },
  };
  const overrides = {
    list: () => jsonResponse({ executions: [execution(traced, { status: 'succeeded', sessionID: sessions.root })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
    trace: () => jsonResponse(regressionTrace),
  };
  const { page } = await openTraceTab(t, overrides, traced);
  const subTab = name => page.getByRole('tablist', { name: 'Dimensiones diagnósticas de la traza' })
    .getByRole('tab', { name });

  await subTab('Skills y cobertura').click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-skills-coverage')?.getAttribute('aria-selected') === 'true');

  const deployedCard = page.locator('[data-skill-definition="def-desplegado"]');
  await deployedCard.waitFor();
  const deployedText = await deployedCard.innerText();
  assert.ok(deployedText.includes('def-desplegado'));
  assert.ok(!deployedText.includes('identidad desconocida'));

  const agentCard = page.locator('[data-skill-definition="agent-ident"]');
  await agentCard.waitFor();
  const agentTextBefore = await agentCard.innerText();
  assert.ok(agentTextBefore.includes('agente-revisor (Agente Revisor)'));
  assert.ok(agentTextBefore.includes('Modo: subagent'));
  assert.ok(agentTextBefore.includes('Descripción: Revisa hallazgos sintéticos'));
  assert.ok(!agentTextBefore.includes('no observado o no autorizado'));
  await agentCard.locator('details[data-disclosure="skill-content"] summary').click();
  assert.ok((await agentCard.innerText()).includes('Instrucciones del sistema del agente revisor.'));
  assert.equal(await agentCard.getByRole('button', { name: 'Copiar JSON' }).count(), 0);
  assert.equal(await agentCard.getByRole('button', { name: 'Copiar contenido' }).count(), 1);

  const observedCard = page.locator('section[data-skills-observed]');
  await observedCard.locator('details[data-disclosure="skill-content"] summary').click();
  assert.equal(await observedCard.getByRole('button', { name: 'Copiar JSON' }).count(), 0);
  assert.equal(await observedCard.getByRole('button', { name: 'Copiar contenido' }).count(), 1);

  const unknownPlugin = page.locator('section[data-plugin-environment] [data-plugin="desconocido"]');
  await unknownPlugin.waitFor();
  assert.ok((await unknownPlugin.innerText()).startsWith('desconocido · fuente local'));

  const unrecognizedAvailable = page.locator('section[data-skills-available] [data-skill-available-status="unrecognized"]');
  await unrecognizedAvailable.waitFor();
  const unrecognizedText = await unrecognizedAvailable.innerText();
  assert.ok(unrecognizedText.includes('estado: unrecognized'));
  assert.ok(unrecognizedText.includes('opencode.skill.list'));
  assert.ok(unrecognizedText.includes('fila 93'));

  await subTab('Métricas').click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-metrics')?.getAttribute('aria-selected') === 'true');
  await page.locator('table[data-metrics-steps]').waitFor();

  const stepHeaders = await page.locator('table[data-metrics-steps] thead th').allInnerTexts();
  assert.ok(stepHeaders.some(header => header.includes('Despachos / reintentos')));
  assert.equal(await page.locator('[data-metric-step-row] [data-metric-dispatches]').first().innerText(), '1 / 1');

  await page.locator('details[data-metric-details] summary').first().click();
  const retryDetailsText = await page.locator('details[data-metric-details]').first().innerText();
  assert.ok(retryDetailsText.includes('espera programada: desconocida'));
  assert.ok(!retryDetailsText.includes('desconocida ms'));

  const measurementTableText = await page.locator('table[data-metrics-measurements]').innerText();
  assert.ok(measurementTableText.includes('opencode.event.session.compaction.failed.tokens'));
  assert.ok(measurementTableText.includes('alcance: compaction'));
  assert.ok(measurementTableText.includes('runtime-normalized-unverified'));
  assert.ok(measurementTableText.includes('runtime-estimate-not-invoice'));
  assert.ok(measurementTableText.includes('fallo de compactación sintético'));
  assert.ok(measurementTableText.includes('compaction-summary-not-exposed'));
  assert.ok(measurementTableText.includes('evt-compaction-fail'));

  const unknownInbox = page.locator('[data-pending-inbox][data-pending-state="unknown"]');
  await unknownInbox.waitFor();
  const unknownInboxText = await unknownInbox.innerText();
  assert.ok(unknownInboxText.includes('Admisión con resolución observada sin orden acreditado (estado desconocido)'));
  assert.ok(!unknownInboxText.includes('sin entrega observada'));

  await subTab('Herramientas e intentos').click();
  await page.waitForFunction(() => document.querySelector('#traza-tab-tools')?.getAttribute('aria-selected') === 'true');

  const toolsScopeNotice = await page.locator('[data-tools-scope-notice]').innerText();
  assert.ok(toolsScopeNotice.includes(sessions.root));
  assert.ok(toolsScopeNotice.includes('sin incluir descendientes'));

  const alphaRow = page.locator('[data-tool-attempt][data-tool-name="alpha"]');
  await alphaRow.locator('details[data-disclosure="input"] summary').click();
  assert.equal(await alphaRow.locator('details[data-disclosure="input"]').getByRole('button', { name: 'Copiar JSON' }).count(), 0);
  assert.equal(await alphaRow.locator('details[data-disclosure="input"]').getByRole('button', { name: 'Copiar texto' }).count(), 1);
  await alphaRow.locator('details[data-disclosure="forensics"] summary').click();
  assert.ok((await alphaRow.locator('details[data-disclosure="forensics"]').innerText()).includes('tool-error (permiso-denegado-sintetico)'));

  const betaRow = page.locator('[data-tool-attempt][data-tool-name="beta"]');
  await betaRow.locator('details[data-disclosure="forensics"] summary').click();
  assert.equal(await betaRow.locator('details[data-disclosure="forensics"]').getAttribute('open'), '');
  await page.getByLabel('Filtrar por nombre de herramienta').fill('beta');
  assert.equal(await page.locator('[data-tool-attempt]').count(), 1);
  assert.equal(await betaRow.locator('details[data-disclosure="forensics"]').getAttribute('open'), '');
  assert.ok((await betaRow.locator('details[data-disclosure="forensics"]').innerText()).includes('msg_null_b'));
});

const dEvRef = (arrival, observedAt) => ({ captureID: 'cap-d', arrival, observedAt });

const deliverableValue = (overrides = {}) => ({
  path: 'salida-informe.txt',
  content: 'Contenido autorizado sintético del entregable.',
  acquisition: 'runtime-content',
  role: 'output',
  roleSource: 'public-file-boundary',
  sourceTimeBasis: 'runtime-event-created',
  finality: null,
  callID: 'call_deliv_1',
  sourceTime: 1700000004000,
  ...overrides,
});

const deliverableSnapshot = (sessionID, overrides = {}) => ({
  source: 'opencode.session.file.boundary',
  identity: null,
  status: 'captured',
  value: deliverableValue(),
  sha256: 'b'.repeat(64),
  hashBasis: 'redacted-json-utf8',
  observationTime: 1700000005000,
  sessionID,
  messageID: 'msg_deliv_1',
  eventID: 'evt_deliv_1',
  omissions: [],
  redactions: ['public-secrets-redacted'],
  evidence: dEvRef(3, 1700000006000),
  ...overrides,
});

const deliverablesGroups = () => [
  {
    sessionID: sessions.root,
    isRoot: true,
    readable: true,
    entries: [{ text: 'Encargo autorizado conservado en la captura.' }],
    responses: [{ text: 'Respuesta autorizada de la sesión raíz.' }],
    deliverables: [
      deliverableSnapshot(sessions.root, {
        source: 'opencode.session.inbox.files',
        value: deliverableValue({
          path: 'entrada-encargo.txt',
          content: 'Contenido capturado del propio evento del runtime.',
          acquisition: 'runtime-content',
          role: 'input',
          callID: null,
        }),
        sha256: 'c'.repeat(64),
        messageID: 'msg_in_deliv',
        eventID: 'evt_in_deliv',
        evidence: dEvRef(1, 1700000002000),
      }),
      deliverableSnapshot(sessions.root, {
        value: deliverableValue({
          path: 'salida-sin-contenido.txt',
          content: null,
          acquisition: 'not-acquired',
          role: 'output',
          callID: 'call_out_1',
        }),
        messageID: 'msg_out_deliv',
        eventID: 'evt_out_deliv',
        omissions: ['deliverable-format-not-supported'],
        evidence: dEvRef(2, 1700000003000),
      }),
    ],
  },
  {
    sessionID: sessions.childA,
    isRoot: false,
    readable: true,
    entries: [],
    responses: [],
    deliverables: [
      deliverableSnapshot(sessions.childA, {
        source: 'opencode.session.tool.content',
        value: deliverableValue({
          path: 'salida-hija.txt',
          content: 'Contenido leído después del acontecimiento.',
          acquisition: 'post-event-file-read',
          role: 'output',
          finality: 'final',
          callID: 'call_hija_1',
          sourceTime: 1700000008000,
        }),
        sha256: 'd'.repeat(64),
        messageID: 'msg_hija_deliv',
        eventID: 'evt_hija_deliv',
        omissions: ['file-read-is-not-runtime-version'],
        evidence: dEvRef(5, 1700000009000),
      }),
      deliverableSnapshot(sessions.childA, {
        status: 'unrecognized',
        value: null,
        sha256: null,
        messageID: 'msg_unrecognized',
        eventID: 'evt_unrecognized',
        omissions: ['redacted-observation-shape'],
        evidence: dEvRef(6, 1700000010000),
      }),
    ],
  },
  {
    sessionID: sessions.grandchild,
    isRoot: false,
    readable: true,
    entries: [],
    responses: [],
    deliverables: [],
  },
];

const fullDeliverables = (executionID, overrides = {}) => ({
  executionID,
  rootSessionID: sessions.root,
  ok: true,
  readable: true,
  selectedSessionID: sessions.root,
  query: { mode: 'known-sessions-explicit', sessions: [sessions.root, sessions.childA, sessions.grandchild] },
  sessions: deliverablesGroups(),
  scope: { kind: 'observed-session-tree', rootSessionID: sessions.root,
    sessionIDs: [sessions.root, sessions.childA, sessions.grandchild] },
  horizon: '2026-11-27T12:00:00.000Z',
  ...overrides,
});

const singleSessionDeliverables = (executionID, sessionID, group) => ({
  ...fullDeliverables(executionID),
  selectedSessionID: sessionID,
  query: { mode: 'selected-session', sessions: [sessionID] },
  sessions: [group],
});

const deliverablesExecutionOverrides = executionID => ({
  list: () => jsonResponse({ executions: [execution(executionID, { status: 'succeeded', sessionID: sessions.root })] }),
  detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
  deliverables: () => jsonResponse(fullDeliverables(executionID)),
});

const openDeliverablesTab = async (t, overrides, executionID) => {
  const opened = await openUi(t, overrides);
  await opened.page.locator(`[data-id="${executionID}"]`).click();
  await opened.page.getByRole('heading', { name: `Ejecución ${executionID.slice(0, 8)}` }).waitFor();
  await opened.page.getByRole('tab', { name: 'Entregables' }).click();
  await opened.page.waitForFunction(() =>
    document.querySelector('[aria-selected="true"]')?.textContent === 'Entregables');
  return opened;
};

const waitUntil = async (predicate, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('waitUntil: condition not met');
};

test('UI: entregables con snapshots por sesión, ausencias honestas y procedencia plegada', { timeout: 120000 }, async t => {
  const shown = 'aaaa2222-1d1d-41d1-81d1-1d1d1d1d1d1d';
  const { app, page } = await openDeliverablesTab(t, deliverablesExecutionOverrides(shown), shown);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url });

  await waitForText(page, 'Alcance: toda la ejecución · 3 sesiones conocidas');
  assert.equal(await page.locator('[data-partial-results]').count(), 0);
  assert.equal(await page.locator('[data-deliverable-card]').count(), 4);
  assert.equal(await page.locator('[data-session-group="ses_root_t"] [data-deliverable-card]').count(), 2);
  assert.equal(await page.locator('[data-session-group="ses_child_a"] [data-deliverable-card]').count(), 2);

  assert.ok((await page.locator('[data-role="input"]').innerText()).includes('entrada'));
  assert.ok((await page.locator('[data-role="output"]').first().innerText()).includes('salida'));
  assert.notEqual(
    await page.locator('[data-role="input"]').getAttribute('class'),
    await page.locator('[data-role="output"]').first().getAttribute('class'));

  assert.equal(await page.locator('[data-acquisition="runtime-content"]').count(), 1);
  assert.ok((await page.locator('[data-acquisition="runtime-content"]').innerText()).includes('contenido del evento'));
  assert.equal(await page.locator('[data-acquisition="post-event-file-read"]').count(), 1);
  assert.ok((await page.locator('[data-acquisition="post-event-file-read"]').innerText()).includes('lectura posterior'));
  assert.equal(await page.locator('[data-acquisition="not-acquired"]').count(), 1);
  assert.ok((await page.locator('[data-acquisition="not-acquired"]').innerText()).includes('no adquirido'));
  assert.equal(await page.locator('[data-acquisition="unrecognized"]').count(), 1);
  assert.ok((await page.locator('[data-acquisition="unrecognized"]').innerText()).includes('no reconocido'));

  const finalities = await page.locator('[data-finality]').allInnerTexts();
  assert.equal(finalities.filter(text => text.includes('Finalidad declarada: final')).length, 1);
  assert.equal(finalities.filter(text => text.includes('Finalidad desconocida (sin acreditar finalidad global)')).length, 3);

  assert.equal(await page.locator('pre[data-deliverable-content]').count(), 2);
  await page.locator('[data-deliverable-card]').first().getByRole('button', { name: 'Copiar contenido' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()),
    'Contenido capturado del propio evento del runtime.');

  assert.equal(await bodyMatches(page, 'Contenido no adquirido'), 1);
  assert.equal(await bodyMatches(page, 'Proyección no reconocida'), 1);
  assert.equal(await bodyMatches(page, 'ruta no expuesta o no admitida'), 1);
  assert.ok((await page.locator('[data-session-group="ses_root_t"]').innerText()).includes('entrada-encargo.txt'));
  assert.ok((await page.locator('[data-session-group="ses_child_a"]').innerText()).includes('salida-hija.txt'));
  assert.ok((await page.locator('[data-session-group="ses_grandchild"]').innerText())
    .includes('Sin entregables capturados para esta sesión'));

  assert.equal(await bodyMatches(page, 'no relee archivos del proyecto observado'), 1);
  assert.equal(await bodyMatches(page, 'no acredita qué bytes produjo o utilizó la acción original'), 1);
  assert.equal(await bodyMatches(page, 'la finalidad global no está acreditada'), 1);
  assert.ok((await page.locator('[data-epistemic-notice]').innerText()).includes('resultado final del flujo'));

  const provenance = page.locator('details[data-provenance]');
  assert.equal(await provenance.count(), 4);
  const beforeExpand = await page.evaluate(() => document.body.innerText);
  assert.ok(!beforeExpand.includes('c'.repeat(64)));
  assert.ok(!beforeExpand.includes('redacted-json-utf8'));
  assert.ok(!beforeExpand.includes('Omisiones:'));
  await provenance.nth(0).locator('summary').click();
  const forensicsRoot = await provenance.nth(0).innerText();
  assert.ok(forensicsRoot.includes('c'.repeat(64)));
  assert.ok(forensicsRoot.includes('redacted-json-utf8'));
  assert.ok(forensicsRoot.includes('Origen: opencode.session.inbox.files'));
  assert.ok(forensicsRoot.includes('entrada en la frontera pública'));
  assert.ok(forensicsRoot.includes('procedencia del papel: public-file-boundary'));
  assert.ok(forensicsRoot.includes('msg_in_deliv'));
  assert.ok(forensicsRoot.includes('Llamada: no expuesta'));
  assert.ok(forensicsRoot.includes(`Momento de frontera: ${new Date(1700000004000).toISOString()} (base runtime-event-created)`));
  assert.ok(forensicsRoot.includes(`Observación: ${new Date(1700000005000).toISOString()}`));
  assert.ok(forensicsRoot.includes('Evidencia: cap-d · fila 1'));
  assert.ok(forensicsRoot.includes('Omisiones: ninguna'));
  assert.ok(forensicsRoot.includes('Redacciones: public-secrets-redacted'));
  await provenance.nth(0).getByRole('button', { name: 'Copiar SHA-256' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'c'.repeat(64));
  await provenance.nth(1).locator('summary').click();
  assert.ok((await provenance.nth(1).innerText()).includes('Omisiones: deliverable-format-not-supported'));
  await provenance.nth(3).locator('summary').click();
  const forensicsUnrecognized = await provenance.nth(3).innerText();
  assert.ok(forensicsUnrecognized.includes('SHA-256 (base redacted-json-utf8): no disponible'));
  assert.ok(forensicsUnrecognized.includes('Omisiones: redacted-observation-shape'));
  assert.ok(forensicsUnrecognized.includes('Identidad: desconocida'));
});

test('UI: banner de resultados parciales sólo en ejecuciones fallidas o interrumpidas', { timeout: 120000 }, async t => {
  const flagged = 'bbbb3333-2e2e-42e2-82e2-2e2e2e2e2e2e';
  let executionStatus = 'running';
  const overrides = {
    list: () => jsonResponse({ executions: [execution(flagged, { status: 'running', sessionID: sessions.root })] }),
    detail: id => jsonResponse({ ...detail(id),
      execution: execution(id, { status: executionStatus, sessionID: sessions.root }) }),
    deliverables: () => jsonResponse(fullDeliverables(flagged)),
  };
  const page = (await openDeliverablesTab(t, overrides, flagged)).page;
  await waitForText(page, 'Alcance: toda la ejecución');
  assert.equal(await page.locator('[data-partial-results]').count(), 0);
  assert.ok((await page.getByRole('tabpanel').innerText()).includes('entrada-encargo.txt'));

  executionStatus = 'failed';
  await page.locator('[data-partial-results]').waitFor();
  const failedText = await page.locator('[data-partial-results]').innerText();
  assert.ok(failedText.includes('Resultados parciales de una ejecución fallida o interrumpida'));
  assert.ok(failedText.includes('no equivale a éxito ni a aceptación'));

  executionStatus = 'interrupted';
  await page.waitForFunction(() => document.querySelectorAll('[data-partial-results]').length === 1);
  assert.equal(await page.locator('[data-partial-results]').count(), 1);

  executionStatus = 'succeeded';
  await page.locator('[data-partial-results]').waitFor({ state: 'detached' });
  executionStatus = 'pending';
  await page.waitForTimeout(2000);
  assert.equal(await page.locator('[data-partial-results]').count(), 0);
});

test('UI: error de lectura parcial de una subejecución sin invalidar las demás', { timeout: 120000 }, async t => {
  const partial = 'cccc4444-3f3f-43f3-83f3-3f3f3f3f3f3f';
  const groups = deliverablesGroups();
  const partialBody = fullDeliverables(partial, { sessions: [
    groups[0],
    { ...groups[1], readable: false, reason: 'reader-timeout', deliverables: [] },
    groups[2],
  ] });
  const overrides = {
    ...deliverablesExecutionOverrides(partial),
    deliverables: () => jsonResponse(partialBody),
  };
  const page = (await openDeliverablesTab(t, overrides, partial)).page;
  await waitForText(page, 'Alcance: toda la ejecución');
  const failedAlert = page.locator('[data-session-read-error="ses_child_a"]');
  await failedAlert.waitFor();
  assert.equal(await failedAlert.getAttribute('role'), 'alert');
  const alertText = await failedAlert.innerText();
  assert.ok(alertText.includes('reader-timeout'));
  assert.ok(alertText.includes('no se reconstruye contenido no capturado'));
  assert.equal(await page.locator('[data-session-read-error]').count(), 1);
  assert.equal(await page.locator('[data-partial-read]').count(), 1);
  assert.ok((await page.locator('[data-partial-read]').innerText()).includes('no pudieron leerse'));
  assert.equal(await page.locator('[data-deliverable-card]').count(), 2);
  assert.equal(await page.locator('[data-session-group="ses_root_t"] [data-deliverable-card]').count(), 2);
  assert.equal(await page.locator('[data-session-group="ses_child_a"] [data-deliverable-card]').count(), 0);
  assert.ok((await page.locator('[data-session-group="ses_root_t"]').innerText()).includes('entrada-encargo.txt'));
  assert.ok(!(await page.locator('[data-session-group="ses_grandchild"]').innerText()).includes('entrada-encargo.txt'));
});

test('UI: respuestas autorizadas plegadas como detalle secundario debajo de los snapshots', { timeout: 120000 }, async t => {
  const tucked = 'dddd5555-4a4a-44a4-84a4-4a4a4a4a4a4a';
  const groups = deliverablesGroups();
  groups[2] = { ...groups[2], entries: [{ text: 'Encargo de usuario sin respuesta autorizada.' }], responses: [] };
  const overrides = {
    ...deliverablesExecutionOverrides(tucked),
    deliverables: () => jsonResponse(fullDeliverables(tucked, { sessions: groups })),
  };
  const page = (await openDeliverablesTab(t, overrides, tucked)).page;
  await waitForText(page, 'Alcance: toda la ejecución');
  const responses = page.locator('details[data-responses="ses_root_t"]');
  await responses.waitFor();
  assert.equal(await responses.getAttribute('open'), null);
  const group = page.locator('[data-session-group="ses_root_t"]');
  let groupText = await group.innerText();
  assert.ok(!groupText.includes('Respuesta autorizada de la sesión raíz.'));
  assert.ok(!groupText.includes('Encargo autorizado conservado en la captura.'));
  assert.ok(groupText.includes('Respuestas autorizadas de esta sesión (1)'));
  assert.ok(!groupText.includes('Respuestas autorizadas de esta sesión (2)'));
  const order = await page.evaluate(() => {
    const groupEl = document.querySelector('[data-session-group="ses_root_t"]');
    const cards = groupEl?.querySelector('[data-deliverable-cards]') ?? null;
    const responsesEl = groupEl?.querySelector('details[data-responses]') ?? null;
    if (groupEl === null || cards === null || responsesEl === null) return 'missing';
    return cards.compareDocumentPosition(responsesEl) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before';
  });
  assert.equal(order, 'after');
  await responses.locator('summary').click();
  groupText = await group.innerText();
  assert.ok(!groupText.includes('Encargo autorizado:'));
  assert.ok(groupText.includes('Respuesta autorizada: Respuesta autorizada de la sesión raíz.'));

  assert.equal(await page.locator('details[data-responses="ses_grandchild"]').count(), 0);
  const grandchildText = await page.locator('[data-session-group="ses_grandchild"]').innerText();
  assert.ok(!grandchildText.includes('Respuestas autorizadas de esta sesión (1)'));
  assert.ok(!grandchildText.includes('Encargo de usuario sin respuesta autorizada.'));
});

test('UI: alcance de entregables reversible por sesión con raíz explícita y sin respuestas obsoletas', { timeout: 180000 }, async t => {
  const scoped = 'eeee6666-5b5b-45b5-85b5-5b5b5b5b5b5b';
  const requests = [];
  const overrides = {
    list: () => jsonResponse({ executions: [execution(scoped, { status: 'succeeded', sessionID: sessions.root })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
    deliverables: async (id, url) => {
      const session = url.searchParams.get('session');
      requests.push(session);
      if (session === sessions.childA) {
        await new Promise(resolve => setTimeout(resolve, 900));
        return jsonResponse(singleSessionDeliverables(scoped, sessions.childA, deliverablesGroups()[1]));
      }
      if (session === sessions.root) {
        return jsonResponse(singleSessionDeliverables(scoped, sessions.root, deliverablesGroups()[0]));
      }
      if (session === null) return jsonResponse(fullDeliverables(scoped));
      return jsonResponse({ error: 'session-not-in-execution' }, 404);
    },
  };
  const page = (await openDeliverablesTab(t, overrides, scoped)).page;
  await waitForText(page, 'Alcance: toda la ejecución · 3 sesiones conocidas');
  assert.equal(await page.locator('[data-deliverable-card]').count(), 4);
  await waitUntil(() => requests.includes(null));

  await page.evaluate(value => { location.hash = value; },
    `#/executions/${scoped}/deliverables?session=${encodeURIComponent(sessions.root)}`);
  await waitForText(page, 'Consulta de una sola sesión (ses_root_t)');
  assert.equal(await page.locator('[data-query-mode]').getAttribute('data-query-mode'), 'selected-session');
  await waitUntil(() => requests[requests.length - 1] === sessions.root);
  await page.waitForFunction(() => document.querySelectorAll('[data-session-group]').length === 1);
  assert.equal(await page.locator('[data-deliverable-card]').count(), 2);
  assert.ok((await page.locator('[data-session-group]').innerText()).includes('entrada-encargo.txt'));
  assert.equal(await page.getByRole('button', { name: 'Ver toda la ejecución' }).count(), 1);

  await page.evaluate(value => { location.hash = value; },
    `#/executions/${scoped}/deliverables?session=${encodeURIComponent(sessions.childA)}`);
  await waitForText(page, 'Consulta de una sola sesión (ses_child_a)');
  await waitForText(page, 'salida-hija.txt');
  assert.equal(await page.locator('[data-session-group]').count(), 1);

  await page.getByRole('button', { name: 'Ver toda la ejecución' }).click();
  await page.waitForFunction(value => location.hash === value, `#/executions/${scoped}/deliverables`);
  await waitForText(page, 'Alcance: toda la ejecución · 3 sesiones conocidas');
  await page.waitForFunction(() => document.querySelectorAll('[data-deliverable-card]').length === 4);
  assert.equal(await page.getByRole('button', { name: 'Ver toda la ejecución' }).count(), 0);

  await page.evaluate(value => { location.hash = value; },
    `#/executions/${scoped}/deliverables?session=${encodeURIComponent(sessions.childA)}`);
  await page.locator('[data-deliverables-loading]').waitFor();
  assert.equal(await page.locator('[data-query-mode]').count(), 0);
  await page.getByRole('button', { name: 'Ver toda la ejecución' }).click();
  await page.waitForFunction(value => location.hash === value, `#/executions/${scoped}/deliverables`);
  await waitForText(page, 'Alcance: toda la ejecución · 3 sesiones conocidas');
  await waitForText(page, 'entrada-encargo.txt');
  await page.waitForTimeout(1400);
  assert.equal(await page.locator('[data-session-group]').count(), 3);
  assert.equal(await page.locator('[data-deliverable-card]').count(), 4);
  const panelText = await page.getByRole('tabpanel').innerText();
  assert.ok(panelText.includes('entrada-encargo.txt'));
  assert.ok(!panelText.includes('Consulta de una sola sesión (ses_child_a)'));
});

test('UI: entregables no consultables con estado honesto y sin datos obsoletos', { timeout: 120000 }, async t => {
  const failing = 'ffff7777-6c6c-46c6-86c6-6c6c6c6c6c6c';
  let mode = 'ok';
  const overrides = {
    list: () => jsonResponse({ executions: [execution(failing, { status: 'failed', sessionID: sessions.root })] }),
    detail: id => jsonResponse({ ...detail(id),
      execution: execution(id, { status: 'failed', sessionID: sessions.root }) }),
    deliverables: () => {
      if (mode === 'ok') return jsonResponse(fullDeliverables(failing));
      if (mode === 'unreadable') return jsonResponse({ executionID: failing, rootSessionID: sessions.root,
        readable: false, reason: 'reader-timeout' });
      return null;
    },
  };
  const page = (await openDeliverablesTab(t, overrides, failing)).page;
  await waitForText(page, 'Alcance: toda la ejecución');
  await waitForText(page, 'entrada-encargo.txt');
  await page.locator('[data-partial-results]').waitFor();

  mode = 'unreadable';
  const unreadable = page.locator('[data-deliverables-unreadable]');
  await unreadable.waitFor();
  assert.equal(await unreadable.getAttribute('role'), 'alert');
  assert.ok((await unreadable.innerText()).includes('Los entregables no están consultables (reader-timeout)'));
  assert.ok((await unreadable.innerText()).includes('no se reconstruye contenido no capturado'));
  assert.equal(await page.locator('[data-deliverable-card]').count(), 0);
  assert.equal(await page.locator('[data-query-mode]').count(), 0);
  assert.ok(!(await page.getByRole('tabpanel').innerText()).includes('entrada-encargo.txt'));

  mode = 'abort';
  await waitForText(page, 'no están consultables (deliverables-unavailable)');
  assert.equal(await page.locator('[data-deliverable-card]').count(), 0);
  assert.equal(await page.locator('[data-query-mode]').count(), 0);
});

test('UI: regresiones #49 en value-null, identificadores copiables, query.mode y 400 invalid-session', { timeout: 120000 }, async t => {
  const execId = 'aaaa8888-7d7d-47d7-87d7-7d7d7d7d7d7d';
  const forensicHash = 'e'.repeat(64);
  const regressionGroups = [
    {
      sessionID: sessions.root,
      isRoot: true,
      readable: true,
      entries: [{ text: 'Encargo del usuario raíz.' }],
      responses: [{ text: 'Respuesta autorizada raíz 1.' }, { text: 'Respuesta autorizada raíz 2.' }],
      deliverables: [
        deliverableSnapshot(sessions.root, {
          source: 'opencode.session.file.boundary',
          identity: 'ident-forense-49',
          status: 'captured',
          value: deliverableValue({
            path: 'docs/informe-forense-49.md',
            content: 'Contenido forense verificable.',
            acquisition: 'runtime-content',
            role: 'output',
            callID: 'call_forense_49',
          }),
          sha256: forensicHash,
          messageID: 'msg_forense_49',
          eventID: 'evt_forense_49',
          evidence: dEvRef(11, 1700000011000),
        }),
        deliverableSnapshot(sessions.root, {
          source: null,
          identity: null,
          status: 'captured',
          value: null,
          sha256: null,
          messageID: 'msg_null_val_49',
          eventID: 'evt_null_val_49',
          omissions: ['deliverable-value-omitted'],
          evidence: dEvRef(12, 1700000012000),
        }),
      ],
    },
  ];
  let responseMode = 'readable';
  const overrides = {
    list: () => jsonResponse({ executions: [execution(execId, { status: 'succeeded', sessionID: sessions.root })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: sessions.root }) }),
    deliverables: (id, url) => {
      const session = url.searchParams.get('session');
      if (responseMode === 'invalid-session') return jsonResponse({ error: 'invalid-session' }, 400);
      if (responseMode === 'not-in-execution') return jsonResponse({ error: 'session-not-in-execution' }, 404);
      if (session === sessions.root) {
        return jsonResponse(singleSessionDeliverables(id, sessions.root, regressionGroups[0]));
      }
      return jsonResponse(fullDeliverables(id, {
        sessions: regressionGroups,
        query: { mode: 'known-sessions-explicit', sessions: [sessions.root] },
        scope: { kind: 'observed-session-tree', rootSessionID: sessions.root, sessionIDs: [sessions.root] },
      }));
    },
  };
  const { app, page } = await openDeliverablesTab(t, overrides, execId);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url });

  await waitForText(page, 'docs/informe-forense-49.md');
  assert.equal(await page.locator('[data-session-group="ses_root_t"] h3').count(), 1);
  assert.equal(await page.locator('[data-session-group="ses_root_t"] h4').count(), 0);
  assert.equal(await page.locator('[data-query-mode]').getAttribute('data-query-mode'), 'known-sessions-explicit');
  assert.ok((await page.locator('details[data-responses="ses_root_t"] summary').innerText())
    .includes('Respuestas autorizadas de esta sesión (2)'));

  const cards = page.locator('[data-deliverable-card]');
  assert.equal(await cards.count(), 2);

  const forensicCard = cards.nth(0);
  await forensicCard.locator('details[data-provenance] summary').click();
  const forensicCodes = await forensicCard.locator('code.font-mono').allInnerTexts();
  for (const token of [
    'docs/informe-forense-49.md',
    forensicHash,
    'ident-forense-49',
    'msg_forense_49',
    'call_forense_49',
    'evt_forense_49',
    'cap-d#11',
  ]) {
    assert.ok(forensicCodes.includes(token), `expected monospace code token ${token}`);
  }
  const copyChecks = [
    ['Copiar ruta', 'docs/informe-forense-49.md'],
    ['Copiar SHA-256', forensicHash],
    ['Copiar identidad', 'ident-forense-49'],
    ['Copiar mensaje', 'msg_forense_49'],
    ['Copiar llamada', 'call_forense_49'],
    ['Copiar evento', 'evt_forense_49'],
    ['Copiar evidencia', 'cap-d#11'],
  ];
  for (const [label, expected] of copyChecks) {
    await forensicCard.getByRole('button', { name: label }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
  }

  const nullValueCard = cards.nth(1);
  assert.equal(await nullValueCard.locator('[data-absence="value-null"]').count(), 1);
  assert.equal(await nullValueCard.locator('[data-absence="not-acquired"]').count(), 0);
  assert.equal(await nullValueCard.locator('[data-absence="unrecognized"]').count(), 0);
  const nullAbsenceText = await nullValueCard.locator('[data-absence="value-null"]').innerText();
  assert.ok(nullAbsenceText.includes('deliverable-value-omitted'));
  assert.ok(!nullAbsenceText.includes('Contenido no adquirido'));
  await nullValueCard.locator('details[data-provenance] summary').click();
  assert.ok((await nullValueCard.locator('details[data-provenance]').innerText()).includes('Origen: desconocido'));

  responseMode = 'not-in-execution';
  await page.evaluate(value => { location.hash = value; },
    `#/executions/${execId}/deliverables?session=ses_ajena`);
  await page.locator('[data-deliverables-unreadable]').waitFor();
  assert.ok((await page.locator('[data-deliverables-unreadable]').innerText()).includes('session-not-in-execution'));
  assert.equal(await page.locator('[data-query-mode]').count(), 0);

  responseMode = 'invalid-session';
  await page.evaluate(value => { location.hash = value; },
    `#/executions/${execId}/deliverables?session=ses_invalida`);
  await waitForText(page, 'invalid-session');
  assert.ok((await page.locator('[data-deliverables-unreadable]').innerText()).includes('invalid-session'));
  assert.equal(await page.locator('[data-query-mode]').count(), 0);
});

const evaluationCriterion = (id, title, overrides = {}) => ({
  id,
  title,
  weight: null,
  mandatory: false,
  status: 'evaluated',
  score: null,
  reason: null,
  evidence: [],
  ...overrides,
});

const evaluationRecord = (executionID, id, overrides = {}) => ({
  evaluationID: id,
  executionID,
  captureID: 'cap-eval',
  captureReference: 'captura sintética de evaluación',
  reevaluationOf: null,
  evaluatedAt: 1764000001000,
  rubric: { rubricID: 'rubrica-e', version: 'v1', status: 'approved', versionAvailable: true,
    versionAmbiguous: false, readError: null },
  versions: { component: 'componente@1', case: 'caso@1', rubric: 'v1', evaluator: 'evaluador@1' },
  criteria: [],
  score: null,
  coverage: null,
  acceptance: null,
  reevaluation: null,
  ...overrides,
});

test('UI: pestaña de evaluación con carga, vacío sobrio en éxito y error de lectura honesto', { timeout: 120000 }, async t => {
  const succeeded = 'aaaa9999-8e8e-49e8-89e8-8e8e8e8e8e8e';
  let releaseEvaluations;
  const gate = new Promise(resolve => { releaseEvaluations = resolve; });
  let evaluationsMode = 'gate';
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(succeeded, { status: 'succeeded', sessionID: 'ses_root_eval' })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: 'ses_root_eval' }) }),
    evaluations: async id => {
      if (evaluationsMode === 'gate') await gate;
      if (evaluationsMode === 'error') {
        return jsonResponse({ executionID: id, source: 'synthetic-fixtures', state: 'read-error',
          reason: 'synthetic read failure', evaluations: null });
      }
      return jsonResponse({ executionID: id, source: 'none', state: 'ready', evaluations: [] });
    },
  });
  await page.locator(`[data-id="${succeeded}"]`).click();
  await page.getByRole('tab', { name: 'Evaluación' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-selected="true"]')?.textContent === 'Evaluación');
  await waitForText(page, 'Consultando si existen resultados de evaluación de esta captura…');

  evaluationsMode = 'none';
  releaseEvaluations();
  await waitForText(page, 'Sin evaluación');
  const emptyText = await page.getByRole('tabpanel').innerText();
  assert.ok(emptyText.includes('la finalización técnica no equivale a una aceptación'));
  assert.ok(emptyText.includes('no se generan puntuaciones, versiones ni aceptaciones de ejemplo'));
  assert.equal(await page.getByRole('tabpanel').getByRole('button').count(), 0);
  assert.equal(await page.getByRole('tabpanel').getByRole('alert').count(), 0);
  assert.ok(!emptyText.includes('Puntuación'));

  evaluationsMode = 'error';
  const unreadable = page.locator('[data-evaluations-unreadable]');
  await unreadable.waitFor();
  assert.equal(await unreadable.getAttribute('role'), 'alert');
  const unreadableText = await unreadable.innerText();
  assert.ok(unreadableText.includes('no están consultables (synthetic read failure)'));
  assert.ok(unreadableText.includes('no se muestran puntuaciones ni aceptación inventadas'));
  assert.equal(await page.getByRole('tabpanel').getByRole('button').count(), 0);
  assert.ok(!(await page.getByRole('tabpanel').innerText()).includes('Sin evaluación'));
});

const richEvaluations = executionID => ({ executionID, source: 'synthetic-fixtures', state: 'ready', evaluations: [
  evaluationRecord(executionID, 'eval-a', {
    acceptance: 'pending',
    criteria: [
      evaluationCriterion('cobertura', 'Cobertura del encargo', {
        weight: 2, status: 'evaluated', score: 0.5, evidence: ['cap-eval · fila 3 (session.text.ended)'] }),
      evaluationCriterion('fidelidad', 'Fidelidad a las decisiones', {
        weight: 1, mandatory: true, status: 'not-evaluable', reason: 'sin evidencia suficiente' }),
    ],
    score: { value: 0.5, basis: 'criterios-evaluados' },
    coverage: { evaluatedWeight: 2, applicableWeight: 3 },
  }),
  evaluationRecord(executionID, 'eval-b', {
    evaluatedAt: null,
    reevaluationOf: 'eval-a',
    reevaluation: 'same-capture',
    rubric: { rubricID: 'rubrica-e', version: '2027-01-01', status: null, versionAvailable: false,
      versionAmbiguous: false, readError: null },
    versions: { component: null, case: null, rubric: '2027-01-01', evaluator: null },
  }),
  evaluationRecord(executionID, 'eval-c', {
    captureID: 'cap-otra',
    reevaluationOf: 'eval-a',
    reevaluation: 'different-capture',
    acceptance: 'accepted',
    criteria: [
      evaluationCriterion('seguridad', 'Seguridad del resultado', {
        weight: 1, mandatory: true, status: 'not-evaluable', reason: 'sin evidencia' }),
    ],
    score: { value: 0.9, basis: 'otra-base' },
    coverage: { evaluatedWeight: 5, applicableWeight: 5, evaluatedWeightMatches: false },
  }),
  evaluationRecord(executionID, 'eval-d', {
    captureID: 'cap-huerfana',
    captureReference: null,
    reevaluationOf: 'no-existe',
    reevaluation: 'missing-target',
    rubric: { rubricID: 'rubrica-e', version: 'v9', status: 'approved', versionAvailable: null,
      versionAmbiguous: false, readError: 'boom' },
  }),
  evaluationRecord(executionID, 'eval-e', {
    acceptance: 'rejected',
    rubric: { rubricID: 'rubrica-e', version: 'v2', status: 'draft', versionAvailable: true,
      versionAmbiguous: false, readError: null },
    criteria: [
      evaluationCriterion('estilo', 'Estilo del entregable', {
        weight: null, status: 'evaluated', score: 0, reason: 'redacción fuera de tono',
        evidence: ['cap-eval · fila 9 (session.text.ended)'] }),
      evaluationCriterion('cierre', 'Cierre del encargo', {
        weight: 1, status: 'evaluated', score: 1, reason: 'cierre observado con evidencia',
        evidence: ['cap-eval · fila 12 (session.text.ended)'] }),
    ],
    score: { value: 0.4, basis: null },
    coverage: { evaluatedWeight: 1, applicableWeight: 2, evaluatedWeightMatches: null },
  }),
  evaluationRecord(executionID, 'eval-e', {
    rubric: { rubricID: 'rubrica-e', version: 'v3', status: 'draft', versionAvailable: true,
      versionAmbiguous: false, readError: null },
  }),
] });

test('UI: evaluaciones agrupadas con reevaluaciones, contradicciones, cobertura y rúbrica resuelta', { timeout: 180000 }, async t => {
  const rich = 'bbbbAAAA-9f9f-49f9-89f9-9f9f9f9f9f9f';
  const { app, page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(rich, { status: 'succeeded', sessionID: 'ses_root_eval' })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: 'ses_root_eval' }) }),
    evaluations: id => jsonResponse(richEvaluations(id)),
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url });
  await page.locator(`[data-id="${rich}"]`).click();
  await page.getByRole('tab', { name: 'Evaluación' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-selected="true"]')?.textContent === 'Evaluación');
  await page.locator('[data-evaluation="eval-a"]').waitFor();

  assert.equal(await page.locator('[data-evaluation]').count(), 6);
  assert.equal(await page.locator('[data-evaluation-group]').count(), 5);
  assert.equal(await page.locator('[data-evaluation-group="eval-a"] [data-evaluation="eval-a"]').count(), 1);
  assert.equal(await page.locator('[data-evaluation-group="eval-a"] [data-evaluation="eval-b"]').count(), 1);
  assert.equal(await page.locator('[data-evaluation-group="eval-a"] [data-evaluation="eval-c"]').count(), 0);
  assert.equal(await page.locator('[data-evaluation-group="eval-c"] [data-evaluation="eval-c"]').count(), 1);
  assert.equal(await page.locator('[data-evaluation-group="eval-d"] [data-evaluation="eval-d"]').count(), 1);
  assert.equal(await page.locator('[data-score-bar]').count(), 0);
  assert.equal(await page.locator('[data-evaluation="eval-a"] [data-coverage-bar]').count(), 1);
  const duplicateAlert = page.locator('[data-anomaly="evaluacion-duplicada"]');
  await duplicateAlert.waitFor();
  assert.equal(await duplicateAlert.getAttribute('role'), 'alert');
  assert.ok((await duplicateAlert.innerText()).includes('Identidad de evaluación repetida: eval-e'));

  const cardA = page.locator('[data-evaluation="eval-a"]');
  const textA = await cardA.innerText();
  assert.ok(textA.includes('Aceptación: pendiente'));
  assert.ok(textA.includes('Puntuación sobre los criterios evaluados: 0.5'));
  assert.ok(textA.includes('Cobertura de evaluación: 2 de 3 de peso de criterios aplicables'));
  assert.ok(textA.includes('El peso evaluado coincide con la suma de pesos de los criterios evaluados.'));
  assert.ok(textA.includes('Aprobada: versión aprobada explícitamente identificada'));
  assert.ok(textA.includes('componente@1'));
  assert.ok(textA.includes('Versión de evaluador: evaluador@1'));
  assert.ok(textA.includes('no evaluable: sin evidencia suficiente'));
  assert.ok(textA.includes('Obligatorio'));
  assert.ok(textA.includes('cap-eval · fila 3 (session.text.ended)'));
  assert.ok(textA.includes('sin evidencia'));
  assert.equal(await cardA.locator('[data-contradiction]').count(), 0);
  assert.equal(await cardA.locator('table[data-criteria-table] tbody tr').count(), 2);

  const cardB = page.locator('[data-evaluation="eval-b"]');
  const textB = await cardB.innerText();
  assert.ok(textB.includes('Reevaluación de eval-a'));
  assert.ok(textB.includes('Es una reevaluación de eval-a sobre la misma captura'));
  assert.ok(textB.includes('no es otra ejecución del flujo'));
  assert.ok(textB.includes('Puntuación: desconocida'));
  assert.ok(textB.includes('no se transforma en cero'));
  assert.ok(textB.includes('Cobertura de evaluación: desconocida'));
  assert.ok(textB.includes('Desconocida: no se presenta como aprobada'));
  assert.ok(textB.includes('no está disponible en la vista de rúbricas'));
  assert.ok(textB.includes('Versión de evaluador: desconocida'));
  assert.ok(textB.includes('Aceptación: no declarada'));
  assert.ok(!textB.includes('Aceptación: aceptada'));

  const cardC = page.locator('[data-evaluation="eval-c"]');
  const textC = await cardC.innerText();
  assert.equal(await cardC.locator('[data-contradiction]').count(), 1);
  assert.equal(await cardC.locator('[data-contradiction]').getAttribute('role'), 'alert');
  const acceptanceBadgeC = cardC.locator('[data-acceptance="contradiction"]');
  assert.equal(await acceptanceBadgeC.count(), 1);
  const badgeClassC = await acceptanceBadgeC.getAttribute('class') ?? '';
  assert.ok(!badgeClassC.includes('emerald'));
  assert.ok(badgeClassC.includes('rose'));
  assert.ok(textC.includes('Decisión pendiente por falta de evidencia obligatoria'));
  assert.ok(textC.includes('Aceptación: aceptada'));
  assert.ok(textC.includes('Puntuación sin base declarada como criterios evaluados: 0.9'));
  assert.ok(textC.includes('base: otra-base'));
  assert.equal(await cardC.locator('[data-coverage-coherence="incoherent"]').getAttribute('role'), 'alert');
  assert.equal(await cardC.locator('[data-reevaluation="different-capture"]').getAttribute('role'), 'alert');
  assert.ok(textC.includes('Cobertura incoherente: el peso evaluado declarado no coincide con la suma de pesos de los criterios evaluados.'));
  assert.ok(textC.includes('la captura no coincide'));
  assert.ok(textC.includes('no evaluable: sin evidencia'));

  const cardD = page.locator('[data-evaluation="eval-d"]');
  const textD = await cardD.innerText();
  assert.equal(await cardD.locator('[data-reevaluation="missing-target"]').getAttribute('role'), 'alert');
  assert.equal(await cardD.locator('[data-rubric-status="read-error"]').count(), 1);
  assert.ok(textD.includes('Error de lectura de rúbricas'));
  assert.ok(!textD.includes('Aprobada: versión aprobada'));
  assert.ok(textD.includes('que no existe entre las evaluaciones de esta ejecución'));
  assert.ok(textD.includes('referencia no resoluble'));
  assert.ok(textD.includes('No se pudo leer la vista de rúbricas (boom)'));
  assert.ok(!textD.includes('no está disponible en la vista de rúbricas'));

  const cardE = page.locator('[data-evaluation="eval-e"]').first();
  const textE = await cardE.innerText();
  assert.ok(textE.includes('Aceptación: rechazada'));
  assert.ok(textE.includes('Borrador: no es una versión aprobada'));
  assert.ok(textE.includes('Coherencia de la cobertura no verificada: faltan datos para comprobarla.'));
  assert.ok(textE.includes('Evaluado · puntuación 0'));
  assert.ok(textE.includes('Evaluado · puntuación 1'));
  assert.ok(!textE.includes('cumplido'));
  assert.ok(!textE.includes('incumplido'));
  assert.ok(textE.includes('base: no declarada'));
  assert.equal(await cardE.locator('tr[data-criterion="estilo"] td').nth(3).innerText(), 'desconocido');

  const panelText = await page.getByRole('tabpanel').innerText();
  assert.ok(panelText.includes('no es otra ejecución del flujo'));
  assert.ok(panelText.includes('No existen acciones de evaluar, reevaluar o editar rúbricas'));
  const buttonLabels = await page.getByRole('tabpanel').getByRole('button').allInnerTexts();
  assert.ok(buttonLabels.length > 0);
  for (const label of buttonLabels) {
    assert.ok(['Copiar', 'Copiado'].includes(label.trim()), `unexpected action button ${label}`);
  }

  await cardA.getByRole('button', { name: 'Copiar evaluación' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'eval-a');
  await cardA.getByRole('button', { name: 'Copiar captura' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'cap-eval');
});

const richRubrics = {
  source: 'synthetic-fixtures',
  state: 'ready',
  rubrics: [
    { rubricID: 'rubrica-sintetica', title: 'Rúbrica sintética', versions: [
      { version: '2026-10-31', status: 'approved', observedAt: 1764000000000,
        criteria: [{ id: 'cobertura', title: 'Cobertura del encargo', weight: 2, mandatory: false,
          status: null, score: null, reason: null, evidence: [] }],
        content: 'Contenido sintético de la versión aprobada.' },
      { version: '2026-11-12', status: 'draft', observedAt: 1764300000000, criteria: [],
        content: 'Contenido sintético del borrador.' },
    ] },
    { rubricID: 'rubrica-huerfana', title: null, versions: [
      { version: null, status: 'unknown', observedAt: null, criteria: [], content: null },
    ] },
  ],
  anomalies: { withoutRubricID: 2, duplicateVersions: [{ rubricID: 'r-dup', version: '1' }] },
};

test('UI: vista de rúbricas con maestro-detalle, anomalías y sólo lectura', { timeout: 180000 }, async t => {
  const solo = 'ccccBBBB-9a9a-49a9-89a9-9a9a9a9a9a9a';
  let releaseRubrics;
  const gate = new Promise(resolve => { releaseRubrics = resolve; });
  let rubricsMode = 'gate';
  const { app, page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(solo, { status: 'succeeded', sessionID: 'ses_root_rub' })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: 'ses_root_rub' }) }),
    rubrics: async () => {
      if (rubricsMode === 'gate') await gate;
      if (rubricsMode === 'empty') return jsonResponse({ source: 'none', state: 'ready', rubrics: [] });
      if (rubricsMode === 'error') {
        return jsonResponse({ source: 'synthetic-fixtures', state: 'read-error',
          reason: 'synthetic read failure', rubrics: null });
      }
      if (rubricsMode === 'updated') {
        return jsonResponse({ ...richRubrics, rubrics: [...richRubrics.rubrics,
          { rubricID: 'rubrica-nueva', title: 'Rúbrica tardía', versions: [
            { version: 'v1', status: 'unknown', observedAt: null, criteria: [], content: 'Contenido tardío.' }] }] });
      }
      return jsonResponse(richRubrics);
    },
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url });
  await page.getByRole('heading', { name: 'Nuevo encargo' }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/');

  await page.getByRole('link', { name: 'Rúbricas' }).click();
  await page.getByRole('heading', { name: 'Rúbricas', exact: true }).waitFor();
  await waitForText(page, 'Consultando las rúbricas conocidas…');

  rubricsMode = 'rich';
  releaseRubrics();
  const detailPane = page.locator('[data-rubric-detail]');
  await waitForText(page, 'Criterio cobertura — Cobertura del encargo');
  assert.equal(await detailPane.getAttribute('data-rubric-detail'), 'rubrica-sintetica');
  assert.equal(await detailPane.getAttribute('data-rubric-detail-version'), '2026-10-31');
  const approvedText = await detailPane.innerText();
  assert.ok(approvedText.includes('Rúbrica sintética'));
  assert.ok(approvedText.includes('Aprobada: versión aprobada explícitamente identificada'));
  assert.ok(approvedText.includes(`Observada: ${new Date(1764000000000).toISOString()}`));
  assert.ok(approvedText.includes('Criterio cobertura — Cobertura del encargo'));
  assert.equal(approvedText.includes('Obligatorio'), false);
  assert.ok(approvedText.includes('peso 2'));
  assert.ok(approvedText.includes('no obligatorio'));
  assert.ok(!(await page.locator('[data-rubrics-view]').innerText())
    .includes('Ninguna rúbrica tiene una versión aprobada explícitamente identificada'));

  const sinRubricID = page.locator('[data-anomaly="sin-rubricID"]');
  assert.equal(await sinRubricID.getAttribute('role'), 'alert');
  assert.ok((await sinRubricID.innerText()).includes('2 fila(s) de rúbricas sin identificador'));
  const duplicated = page.locator('[data-anomaly="version-duplicada"]');
  assert.equal(await duplicated.getAttribute('role'), 'alert');
  assert.ok((await duplicated.innerText()).includes('Versión duplicada: r-dup · 1'));

  await page.locator('[data-rubric-select="rubrica-huerfana"]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-rubric-detail]')?.getAttribute('data-rubric-detail') === 'rubrica-huerfana');
  const orphanText = await detailPane.innerText();
  assert.ok(orphanText.includes('Versión no identificada'));
  assert.ok(orphanText.includes('Desconocida: no se presenta como aprobada'));
  assert.ok(orphanText.includes('Sin criterios declarados en esta versión.'));
  assert.ok(orphanText.includes('Contenido de la versión no disponible.'));

  await page.locator('[data-rubric-select="rubrica-sintetica"]').click();
  await page.locator('[data-version-select="2026-11-12"]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-rubric-detail]')?.getAttribute('data-rubric-detail-version') === '2026-11-12');
  const draftText = await detailPane.innerText();
  assert.ok(draftText.includes('Borrador: no es una versión aprobada'));
  await detailPane.getByRole('button', { name: 'Copiar rúbrica' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'rubrica-sintetica');

  const content = page.locator('details[data-disclosure="rubric-content"]');
  assert.equal(await content.getAttribute('open'), null);
  await content.locator('summary').click();
  assert.ok((await content.locator('pre').innerText()).includes('Contenido sintético del borrador.'));
  await content.getByRole('button', { name: 'Copiar contenido' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Contenido sintético del borrador.');

  rubricsMode = 'updated';
  await page.locator('[data-rubric-select="rubrica-nueva"]').waitFor();
  await page.waitForTimeout(300);
  assert.equal(await detailPane.getAttribute('data-rubric-detail'), 'rubrica-sintetica');
  assert.equal(await detailPane.getAttribute('data-rubric-detail-version'), '2026-11-12');

  rubricsMode = 'empty';
  await waitForText(page, 'Sin rúbricas versionadas');
  const emptyView = await page.locator('[data-rubrics-view]').innerText();
  assert.ok(emptyView.includes('No existe ninguna rúbrica versionada'));
  assert.ok(emptyView.includes('no es una rúbrica aprobada'));
  assert.equal(await page.locator('[data-rubric-detail]').count(), 0);

  rubricsMode = 'error';
  const unreadable = page.locator('[data-rubrics-unreadable]');
  await unreadable.waitFor();
  assert.equal(await unreadable.getAttribute('role'), 'alert');
  assert.ok((await unreadable.innerText()).includes('Las rúbricas no están consultables (synthetic read failure)'));
  assert.equal(await page.locator('[data-rubric-detail]').count(), 0);

  const actionButtons = await page.locator('main').getByRole('button').allInnerTexts();
  for (const label of actionButtons) {
    assert.ok(!/crear|editar|aprobar|evaluar|reevaluar|borrar|eliminar/i.test(label), `forbidden action ${label}`);
  }

  await page.getByRole('link', { name: 'Nuevo encargo' }).click();
  await page.getByRole('heading', { name: 'Nuevo encargo' }).waitFor();
  assert.equal(await page.locator('main [data-rubrics-view]').count(), 0);

  await page.locator(`[data-id="${solo}"]`).click();
  await page.getByRole('heading', { name: 'Ejecución ccccBBBB' }).waitFor();
  for (const tab of ['Conversación', 'Entregables', 'Traza', 'Evaluación']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForFunction(value =>
      document.querySelector('[aria-selected="true"]')?.textContent === value, tab);
    assert.equal(await page.locator('main [data-rubrics-view]').count(), 0);
    assert.equal(await page.locator('main [data-rubric-detail]').count(), 0);
  }
});

test('UI: respuestas obsoletas de evaluación no cruzan ejecuciones', { timeout: 120000 }, async t => {
  const execA = 'ddddCCCC-9b9b-49b9-89b9-9b9b9b9b9b9b';
  const execB = 'eeeeDDDD-9c9c-49c9-89c9-9c9c9c9c9c9c';
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [
      execution(execA, { status: 'succeeded', sessionID: 'ses_root_s1' }),
      execution(execB, { status: 'succeeded', sessionID: 'ses_root_s2' }),
    ] }),
    evaluations: async id => {
      if (id === execA) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        return jsonResponse({ executionID: id, source: 'synthetic-fixtures', state: 'ready',
          evaluations: [evaluationRecord(id, 'eval-lenta-a')] });
      }
      return jsonResponse({ executionID: id, source: 'synthetic-fixtures', state: 'ready',
        evaluations: [evaluationRecord(id, 'eval-rapida-b')] });
    },
  });
  await page.locator(`[data-id="${execA}"]`).click();
  await page.getByRole('tab', { name: 'Evaluación' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-selected="true"]')?.textContent === 'Evaluación');

  await page.locator(`[data-id="${execB}"]`).click();
  await page.getByRole('tab', { name: 'Evaluación' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-selected="true"]')?.textContent === 'Evaluación');
  await page.locator('[data-evaluation="eval-rapida-b"]').waitFor();
  await page.waitForTimeout(2500);
  const panelText = await page.getByRole('tabpanel').innerText();
  assert.ok(panelText.includes('eval-rapida-b'));
  assert.ok(!panelText.includes('eval-lenta-a'));
});

test('UI: regresiones #50 en puntuaciones sin escala, rúbrica ambigua/duplicada, orden y ciclos de reevaluación', { timeout: 180000 }, async t => {
  const execId = 'ffffEEEE-9d9d-49d9-89d9-9d9d9d9d9d9d';
  const regressionEvaluations = {
    executionID: execId,
    source: 'synthetic-fixtures',
    state: 'ready',
    evaluations: [
      evaluationRecord(execId, 'eval-re-first', {
        captureID: 'cap-order',
        reevaluationOf: 'eval-target-later',
        reevaluation: 'same-capture',
        rubric: { rubricID: 'rubrica-ambigua', version: 'v1', status: 'approved', versionAvailable: true,
          versionAmbiguous: true, readError: null },
        criteria: [
          evaluationCriterion('escala-cinco', 'Criterio en escala de cinco', {
            weight: 2, status: 'evaluated', score: 2, evidence: ['cap-order · fila 1'] }),
          evaluationCriterion('sin-puntuacion', 'Criterio evaluado sin puntuación', {
            weight: 1, status: 'evaluated', score: null, evidence: ['cap-order · fila 2'] }),
        ],
        score: { value: 2, basis: 'criterios-evaluados' },
        coverage: { evaluatedWeight: 3, applicableWeight: 4 },
      }),
      evaluationRecord(execId, 'eval-target-later', {
        captureID: 'cap-order',
        reevaluationOf: null,
        reevaluation: null,
      }),
      evaluationRecord(execId, 'eval-diff-cap', {
        captureID: 'cap-distinta',
        reevaluationOf: 'eval-target-later',
        reevaluation: 'different-capture',
      }),
      evaluationRecord(execId, 'eval-cyc-a', {
        captureID: 'cap-cyc',
        reevaluationOf: 'eval-cyc-b',
        reevaluation: 'same-capture',
      }),
      evaluationRecord(execId, 'eval-cyc-b', {
        captureID: 'cap-cyc',
        reevaluationOf: 'eval-cyc-a',
        reevaluation: 'same-capture',
      }),
      evaluationRecord(execId, 'eval-self', {
        captureID: 'cap-self',
        reevaluationOf: 'eval-self',
        reevaluation: 'same-capture',
      }),
    ],
  };
  const duplicateRubrics = {
    source: 'synthetic-fixtures',
    state: 'ready',
    rubrics: [
      { rubricID: 'rubrica-vacia', title: 'Rúbrica sin versiones', versions: [] },
      {
        rubricID: 'rubrica-duplicada',
        title: 'Rúbrica con copias',
        versions: [
          { version: 'v1', status: 'approved', observedAt: 1764000000000, criteria: [], content: 'Contenido copia uno.' },
          { version: 'v1', status: 'draft', observedAt: 1764100000000, criteria: [], content: 'Contenido copia dos.' },
        ],
      },
    ],
    anomalies: { withoutRubricID: 0, duplicateVersions: [{ rubricID: 'rubrica-duplicada', version: 'v1' }] },
  };
  const { page } = await openUi(t, {
    list: () => jsonResponse({ executions: [execution(execId, { status: 'succeeded', sessionID: 'ses_root_50' })] }),
    detail: id => jsonResponse({ ...detail(id), execution: execution(id, { status: 'succeeded', sessionID: 'ses_root_50' }) }),
    evaluations: () => jsonResponse(regressionEvaluations),
    rubrics: () => jsonResponse(duplicateRubrics),
  });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error));

  await page.locator(`[data-id="${execId}"]`).click();
  await page.getByRole('tab', { name: 'Evaluación' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-selected="true"]')?.textContent === 'Evaluación');
  await page.locator('[data-evaluation="eval-re-first"]').waitFor();

  assert.equal(pageErrors.length, 0);
  assert.equal(await page.locator('[data-evaluation]').count(), 6);
  assert.equal(await page.locator('[data-evaluation-group="eval-target-later"]').count(), 1);
  assert.equal(await page.locator('[data-evaluation-group="eval-target-later"] [data-evaluation="eval-re-first"]').count(), 1);
  assert.equal(await page.locator('[data-evaluation-group="eval-target-later"] [data-evaluation="eval-target-later"]').count(), 1);
  assert.equal(await page.locator('[data-evaluation-group="eval-target-later"] [data-evaluation="eval-diff-cap"]').count(), 0);
  assert.equal(await page.locator('[data-evaluation-group="eval-diff-cap"] [data-evaluation="eval-diff-cap"]').count(), 1);
  assert.equal(await page.locator('[data-evaluation-group="eval-diff-cap"] [data-evaluation-group-count]').count(), 0);
  assert.equal(await page.locator('[data-evaluation="eval-cyc-a"]').count(), 1);
  assert.equal(await page.locator('[data-evaluation="eval-cyc-b"]').count(), 1);
  assert.equal(await page.locator('[data-evaluation="eval-self"]').count(), 1);
  assert.equal(await page.locator('[data-score-bar]').count(), 0);

  const firstCard = page.locator('[data-evaluation="eval-re-first"]');
  const firstText = await firstCard.innerText();
  assert.ok(firstText.includes('Evaluado · puntuación 2'));
  assert.ok(firstText.includes('Evaluado · puntuación desconocida'));
  assert.ok(!firstText.includes('cumplido'));
  assert.ok(!firstText.includes('incumplido'));
  const ambiguousBadge = firstCard.locator('[data-rubric-status="ambiguous"]');
  assert.equal(await ambiguousBadge.count(), 1);
  assert.ok((await ambiguousBadge.innerText()).includes('Versión duplicada / ambigua'));
  assert.ok(!((await ambiguousBadge.getAttribute('class')) ?? '').includes('emerald'));
  assert.ok(!firstText.includes('Aprobada: versión aprobada'));
  assert.equal(await firstCard.locator('[data-rubric-ambiguous]').getAttribute('role'), 'alert');

  await page.getByRole('link', { name: 'Rúbricas' }).click();
  await page.locator('[data-rubric-master="rubrica-vacia"] [data-rubric-no-versions]').waitFor();
  const detailPane = page.locator('[data-rubric-detail="rubrica-duplicada"]');
  await detailPane.waitFor();
  assert.equal(await detailPane.getAttribute('data-rubric-detail-occurrence'), '1');
  assert.ok((await detailPane.innerText()).includes('(copia #1)'));
  assert.ok((await detailPane.innerText()).includes('Aprobada: versión aprobada explícitamente identificada'));
  await detailPane.locator('details[data-disclosure="rubric-content"] summary').click();
  assert.ok((await detailPane.locator('pre').innerText()).includes('Contenido copia uno.'));

  await page.locator('[data-version-select="v1"][data-version-occurrence="2"]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-rubric-detail]')?.getAttribute('data-rubric-detail-occurrence') === '2');
  assert.ok((await detailPane.innerText()).includes('(copia #2)'));
  assert.ok((await detailPane.innerText()).includes('Borrador: no es una versión aprobada'));
  assert.ok((await detailPane.locator('pre').innerText()).includes('Contenido copia dos.'));
  assert.equal(pageErrors.length, 0);
});
