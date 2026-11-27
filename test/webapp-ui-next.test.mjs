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
  const root = await mkdtemp(join(temporary, 'webapp-ui-next-'));
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
    const match = url.pathname.match(/^\/api\/executions\/([^/]+)$/);
    if (match && request.method() === 'GET') return respond(negotiate.detail(decodeURIComponent(match[1])));
    if (url.pathname === '/api/executions' && request.method() === 'POST') {
      posts.push(JSON.parse(request.postData() ?? '{}'));
      return respond(negotiate.post());
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not-mocked"}' });
  });
  await page.goto(`${app.url}/next/#/`);
  return { app, page, negotiate, posts, calls, stopCalls, replyCalls };
}

test('UI /next: barra lateral, navegación e histórico, y cajón adaptable en pantallas estrechas', { timeout: 120000 }, async t => {
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
  await page.getByRole('heading', { name: 'Rúbricas' }).waitFor();

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

test('UI /next: conmutador de tema Claro, Oscuro y Sistema persistente', { timeout: 120000 }, async t => {
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

test('UI /next: salud compacta expandible con motor, captura, índice y desconexión local', { timeout: 120000 }, async t => {
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

test('UI /next: histórico en vivo mientras se inspecciona una ejecución y filtrado por texto y estado', { timeout: 120000 }, async t => {
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

test('UI /next: compositor con estados de opciones, envío idempotente y avisos contextuales', { timeout: 180000 }, async t => {
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
  await page.getByRole('heading', { name: 'Rúbricas' }).waitFor();
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

test('UI /next: enrutado por hash con recarga, subejecución y atrás/adelante del navegador', { timeout: 120000 }, async t => {
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

test('UI /next: salud colapsada distingue fallo de subsistema de desconexión local', { timeout: 120000 }, async t => {
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

test('UI /next: aviso proactivo de índice, project-busy sin ejecución, epistemología y hash malformado', { timeout: 120000 }, async t => {
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

test('UI /next: cabecera de ejecución con Detener, chips y cajón de metadatos forenses copiable', { timeout: 120000 }, async t => {
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

test('UI /next: banda prioritaria con fallo del registrador visible en todas las pestañas', { timeout: 120000 }, async t => {
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

test('UI /next: banda prioritaria con motor inaccesible en ejecución no terminal', { timeout: 120000 }, async t => {
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

test('UI /next: banda prioritaria con detención solicitada por sesión y árbol no verificado', { timeout: 120000 }, async t => {
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

test('UI /next: banda prioritaria con intervenciones pendientes, salto directo y errores de lectura', { timeout: 120000 }, async t => {
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

test('UI /next: Conversación en Markdown seguro con bloques copiables y conmutador a texto plano', { timeout: 120000 }, async t => {
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

test('UI /next: preguntas nativas con borradores aislados, valor propio, booleano false explícito y condicional', { timeout: 120000 }, async t => {
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

test('UI /next: permisos con decisión explícita, errores honestos, pérdida de transporte y respuestas registradas legibles', { timeout: 120000 }, async t => {
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

test('UI /next: sondeo en segundo plano no destructivo con foco, borrador y desplegable intactos', { timeout: 180000 }, async t => {
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

test('UI /next: protección contra respuestas obsoletas al cambiar de ejecución', { timeout: 120000 }, async t => {
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

test('UI /next: salto directo con identificadores con dos puntos y foco en clics repetidos', { timeout: 120000 }, async t => {
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

test('UI /next: sondeo lento de detalle (>1,5 s) no solapa peticiones ni deja de actualizar', { timeout: 120000 }, async t => {
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

test('UI /next: traza con barra de alcance, árbol acreditado, selección reversible y árbol raíz conservado', { timeout: 120000 }, async t => {
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

test('UI /next: traza tras recarga directa con subejecución mantiene el árbol raíz y acota los datos', { timeout: 120000 }, async t => {
  const traced = 'bbbb2222-0202-4202-8202-020202020202';
  const overrides = traceExecutionOverrides(traced);
  const { app, page } = await openUi(t, overrides);
  await page.goto(`${app.url}/next/#/executions/${traced}/trace?session=ses_child_b`);
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

test('UI /next: línea temporal con escala relativa, leyenda, tooltips exactos y aviso único de solapamiento', { timeout: 120000 }, async t => {
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

test('UI /next: subnavegación de la traza entre sus cuatro dimensiones diagnósticas', { timeout: 120000 }, async t => {
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

test('UI /next: alcance sincronizado con Entregables y reinicio desde su barra', { timeout: 120000 }, async t => {
  const traced = 'ffff6666-0606-4606-8606-060606060606';
  const page = (await openTraceTab(t, traceExecutionOverrides(traced), traced)).page;
  await page.locator('[data-select-session="ses_child_a"]').click();
  await page.waitForFunction(() => location.hash.endsWith('/trace?session=ses_child_a'));

  await page.getByRole('tab', { name: 'Entregables' }).click();
  await page.waitForFunction(value => location.hash === value,
    `#/executions/${traced}/deliverables?session=ses_child_a`);
  const scope = page.getByRole('region', { name: 'Alcance de los entregables' });
  await scope.waitFor();
  const scopeText = await scope.innerText();
  assert.ok(scopeText.includes('Alcance: subejecución'));
  assert.ok(scopeText.includes('ses_child_a'));
  assert.ok(scopeText.includes('Los entregables conservados en la captura se mostrarán en una vista dedicada'));

  await page.getByRole('button', { name: 'Ver toda la ejecución' }).click();
  await page.waitForFunction(value => location.hash === value, `#/executions/${traced}/deliverables`);
  await waitForText(page, 'Alcance: toda la ejecución');
  assert.equal(await page.getByRole('button', { name: 'Ver toda la ejecución' }).count(), 0);

  await page.getByRole('tab', { name: 'Traza' }).click();
  await page.waitForFunction(value => location.hash === value, `#/executions/${traced}/trace`);
  await waitForText(page, 'Alcance: toda la ejecución · 5 sesiones conocidas');
});

test('UI /next: respuestas obsoletas de traza no sobrescriben el alcance activo', { timeout: 120000 }, async t => {
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

test('UI /next: traza ilegible manejada con honestidad en alcance, árbol y línea temporal', { timeout: 120000 }, async t => {
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

test('UI /next: cambio a subejecución lenta limpia de inmediato la anterior y raíz no duplica sondeo', { timeout: 120000 }, async t => {
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

test('UI /next: línea temporal honesta con esperas sin inicio, escala cero/vacía, límites, accesibilidad y desenlaces', { timeout: 120000 }, async t => {
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
