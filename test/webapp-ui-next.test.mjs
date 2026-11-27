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
  const calls = { options: 0 };
  const negotiate = {
    health: () => jsonResponse(healthy),
    options: () => jsonResponse(readyOptions),
    list: () => jsonResponse({ executions: [] }),
    detail: id => jsonResponse(detail(id)),
    post: () => jsonResponse({ execution: execution('created-synthetic-1') }, 201),
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
    const match = url.pathname.match(/^\/api\/executions\/([^/]+)$/);
    if (match && request.method() === 'GET') return respond(negotiate.detail(decodeURIComponent(match[1])));
    if (url.pathname === '/api/executions' && request.method() === 'POST') {
      posts.push(JSON.parse(request.postData() ?? '{}'));
      return respond(negotiate.post());
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not-mocked"}' });
  });
  await page.goto(`${app.url}/next/#/`);
  return { app, page, negotiate, posts, calls };
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
