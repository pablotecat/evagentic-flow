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
