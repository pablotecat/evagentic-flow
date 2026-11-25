import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rename, rm, unlink, writeFile, mkdir, symlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { eventually, fixture, records } from './support/instance.mjs';
import { appFetch, createExecution, launchWebapp } from './support/webapp.mjs';
import { startApp } from '../webapp/server.mjs';

const TERMINAL_STATUSES = ['succeeded', 'failed', 'interrupted'];

const upload = async (page, text) => {
  await page.getByLabel('Encargo').fill(text);
  await page.getByRole('button', { name: 'Enviar' }).click();
};

const awaitStatus = (page, fragment, timeout = 180000) =>
  page.waitForFunction(value =>
    document.querySelector('#execution-status')?.textContent?.includes(value) ?? false,
    fragment, { timeout });

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const hashCapture = async directory => {
  const names = (await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort();
  const parts = [];
  for (const name of names) {
    parts.push(name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex'));
  }
  return parts.join('\n');
};

const admittedCount = async instance => (await records(instance.captureDirectory))
  .filter(row => row.type === 'session.inbox.enqueued' && row.content?.role === 'user').length;

test('el navegador lanza, observa y conserva una ejecución de Flujo en Proyecto', { timeout: 480000 }, async t => {
  const instance = await fixture(t, { simulation: true, admissionGate: true,
    config: { secrets: ['synthetic-secret-42'] } });
  const { app, configPath } = await launchWebapp(t, instance);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.url);

  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: disponible') ?? false, undefined, { timeout: 60000 });

  const raced = await page.evaluate(async () => {
    const options = { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestKey: 'navegador-carrera', text: 'Encargo repetido simultáneo. clave synthetic-secret-42.' }) };
    const responses = await Promise.all([fetch('/api/executions', options), fetch('/api/executions', options)]);
    return Promise.all(responses.map(response => response.json().then(body => ({ status: response.status, body }))));
  });
  assert.equal(raced[0].status, 201);
  assert.equal(raced[1].status, 200);
  const first = raced[0].body;
  const second = raced[1].body;
  assert.equal(first.execution.id, second.execution.id);
  await eventually(async () => (await (await fetch(`${app.url}/api/executions/${first.execution.id}`)).json())
    .execution.status === 'succeeded', 'raced execution did not complete');

  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: disponible · Captura: preparada') ?? false, undefined, { timeout: 60000 });

  await page.getByRole('button', { name: 'Nuevo encargo' }).click();
  await upload(page, 'Encargo sintético del navegador. clave synthetic-secret-42.');
  await awaitStatus(page, 'Finalizada técnicamente');
  assert.equal(await page.locator('.dispatch').innerText(), 'Despacho: encargo admitido.');
  const messages = await page.locator('[aria-label="Mensajes"]').innerText();
  assert.ok(messages.includes('Encargo sintético del navegador. clave [REDACTED].'));
  assert.ok(messages.includes('Respuesta autorizada. clave [REDACTED].'));
  assert.ok(!messages.includes('synthetic-secret-42'));
  assert.equal(await page.getByRole('button', { name: /Finalizar/ }).count(), 0);
  assert.ok((await page.locator('#conversation').innerText()).includes('único envío inicial'));
  const board = await page.locator('#conversation').innerText();
  assert.ok(board.includes('Sesión raíz'));
  assert.ok(board.includes('Capturas'));

  await page.getByRole('button', { name: 'Nuevo encargo' }).click();
  await upload(page, 'SYNTHETIC_HELD_ADMISSION');
  await eventually(async () => readFile(join(instance.root, 'admission-entered'), 'utf8'), 'admission gate not entered');
  await awaitStatus(page, 'Pendiente de confirmación', 60000);
  const heldAdmissions = (await records(instance.captureDirectory)).filter(row => row.type === 'session.inbox.enqueued');
  assert.equal(heldAdmissions.length, 2, 'creating the held session was mistaken for admission');

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 2,
    undefined, { timeout: 60000 });
  await page.locator('#history button').first().click();
  await awaitStatus(page, 'Pendiente de confirmación', 60000);
  assert.equal(await page.locator('.dispatch').innerText(),
    'Despacho: envío posible; admisión sin confirmar. El encargo no se reenviará automáticamente.');

  const page2 = await browser.newPage();
  await page2.goto(app.url);
  await upload(page2, 'Encargo desde la segunda pestaña.');
  await page2.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent
    ?.includes('ocupado') ?? false, undefined, { timeout: 60000 });
  await page2.close();

  await writeFile(join(instance.root, 'admission-release'), 'release');
  await awaitStatus(page, 'Finalizada técnicamente');

  const admitted = (await records(instance.captureDirectory)).filter(row =>
    row.type === 'session.inbox.enqueued' && row.content?.role === 'user');
  assert.equal(admitted.length, 3, 'the app dispatched the assignment more than once per encargo');
  const sessions = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(sessions.filter(session => (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 3,
    'a busy project still dispatched work from a second tab');
  assert.equal(await page.locator('#history button').count(), 3);

  await app.close();
  const restarted = await startApp({ configPath });
  t.after(() => restarted.close());
  await page.goto(restarted.url);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: disponible') ?? false, undefined, { timeout: 30000 });
  await page.locator('#history button').first().click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Mensajes"]')?.textContent
    ?.includes('Respuesta autorizada') ?? false, undefined, { timeout: 30000 });

  await instance.stop();
  await page.goto(restarted.url);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: no disponible · Captura: preparada') ?? false, undefined, { timeout: 30000 });
  assert.equal(await page.getByRole('button', { name: 'Enviar' }).count(), 1);
  await page.locator('#history button').first().click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Mensajes"]')?.textContent
    ?.includes('Respuesta autorizada') ?? false, undefined, { timeout: 30000 });

  const gapCaptureID = randomUUID();
  await writeFile(join(instance.captureDirectory, 'synthetic-gap.jsonl'), JSON.stringify({
    schemaVersion: 1, captureID: gapCaptureID, arrival: 1, observedAt: Date.now(),
    type: 'recorder.gap', reason: 'unrecognized-session-envelope',
  }) + '\n');
  const digest = await hashCapture(instance.captureDirectory);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
    undefined, { timeout: 30000 });
  await page.locator('#history button').first().click();
  await page.getByRole('region', { name: 'Lagunas conocidas' }).waitFor();
  const gap = await page.getByRole('region', { name: 'Lagunas conocidas' }).innerText();
  assert.ok(gap.includes('Sin atribución a esta ejecución'));
  assert.ok(gap.includes(gapCaptureID));
  assert.ok(gap.includes('unrecognized-session-envelope'));
  assert.ok((await page.locator('[aria-label="Mensajes"]').innerText()).includes('Respuesta autorizada'));
  await page.getByText('Omisiones observadas en el árbol de sesiones', { exact: true }).click();
  assert.ok((await page.locator('[aria-label="Omisiones observadas"]').innerText()).includes('non-text-fields-not-captured'));
  assert.ok((await page.locator('#conversation').innerText()).includes('Árbol de sesiones observado:'));
  assert.equal(await admittedCount(instance), 3, 'reading gaps dispatched work');
  assert.equal(await hashCapture(instance.captureDirectory), digest, 'reading gaps altered captured evidence');
});

test('la pestaña recupera el seguimiento al recargarse o cerrarse sin detener ni repetir el trabajo', { timeout: 480000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { app } = await launchWebapp(t, instance);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: disponible') ?? false, undefined, { timeout: 60000 });

  await page.getByRole('button', { name: 'Nuevo encargo' }).click();
  await upload(page, 'Encargo largo del navegador. SYNTHETIC_LONG_RUNNING');
  await awaitStatus(page, 'En ejecución');
  assert.equal(await page.locator('.dispatch').innerText(), 'Despacho: encargo admitido.');
  const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
  const detailed = (await appFetch(app, `/api/executions/${executionId}`)).body;
  assert.equal(await admittedCount(instance), 1);

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
    undefined, { timeout: 60000 });
  await page.locator('#history button').first().click();
  await awaitStatus(page, 'En ejecución');
  const board = await page.locator('#conversation').innerText();
  assert.ok(board.includes(executionId), 'a reload lost the persistent execution identity');
  assert.ok(board.includes(detailed.execution.sessionID), 'a reload lost the root session identity');
  assert.ok(board.includes('Encargo largo del navegador.'));
  assert.ok(board.includes('Evidencia hasta'));
  assert.equal(await admittedCount(instance), 1, 'a reload dispatched the assignment again');

  await browser.close();
  await eventually(async () => (await appFetch(app, `/api/executions/${executionId}`))
    .body.execution.status === 'succeeded', 'closing the tab stopped the work', 180000);
  assert.equal(await admittedCount(instance), 1, 'a closed tab dispatched the assignment again');
  const digest = await hashCapture(instance.captureDirectory);

  const browserAgain = await chromium.launch();
  t.after(() => browserAgain.close());
  const pageAgain = await browserAgain.newPage();
  await pageAgain.goto(app.url);
  await pageAgain.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
    undefined, { timeout: 60000 });
  await pageAgain.locator('#history button').first().click();
  await awaitStatus(pageAgain, 'Finalizada técnicamente');
  const boardAgain = await pageAgain.locator('#conversation').innerText();
  assert.ok(boardAgain.includes(executionId));
  assert.ok(boardAgain.includes('Respuesta autorizada'));
  assert.equal(await admittedCount(instance), 1, 'reopening the browser dispatched work again');
  assert.equal(await hashCapture(instance.captureDirectory), digest,
    'querying the history after a reload and reopen altered the original capture bytes');
});

test('la caída del motor se muestra como pendiente de comprobar y reconectar no relanza el trabajo', { timeout: 480000 }, async t => {
  const appPort = await freePort();
  const enginePort = await freePort();
  const instance = await fixture(t, { simulation: true, enginePort });
  const { app, configPath } = await launchWebapp(t, instance, { appPort });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const creationTraffic = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/executions')) {
      creationTraffic.push({ event: 'request', at: Date.now() });
    }
  });
  page.on('response', response => {
    if (response.request().method() === 'POST' && response.url().endsWith('/api/executions')) {
      creationTraffic.push({ event: 'response', at: Date.now(), status: response.status() });
    }
  });
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: disponible') ?? false, undefined, { timeout: 60000 });

  await page.getByRole('button', { name: 'Nuevo encargo' }).click();
  await upload(page, 'Encargo largo desconectado. SYNTHETIC_LONG_RUNNING');
  await awaitStatus(page, 'En ejecución');
  const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
  const anchored = (await appFetch(app, `/api/executions/${executionId}`)).body;
  assert.equal(await admittedCount(instance), 1);

  await app.close();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Sin conexión con la app local') ?? false, undefined, { timeout: 60000 });
  const restarted = await startApp({ configPath, port: appPort });
  t.after(() => restarted.close());
  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: disponible') ?? false, undefined, { timeout: 60000 });
  const resumed = (await appFetch(restarted, `/api/executions/${executionId}`)).body;
  assert.equal(resumed.execution.status, 'running');
  assert.equal(resumed.execution.sessionID, anchored.execution.sessionID);
  assert.equal(resumed.execution.dispatch, 'admitted');
  await awaitStatus(page, 'En ejecución');
  assert.equal(await admittedCount(instance), 1, 'an app restart dispatched the assignment again');

  await instance.stop();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: no disponible · Captura: preparada') ?? false, undefined, { timeout: 60000 });
  await awaitStatus(page, 'En ejecución');
  await page.waitForFunction(() => document.querySelector('#engine-offline')?.textContent
    ?.includes('desenlace pendiente de comprobar') ?? false, undefined, { timeout: 60000 });
  const offlineBoard = await page.locator('#conversation').innerText();
  assert.ok(offlineBoard.includes('Encargo largo desconectado.'));
  assert.ok(offlineBoard.includes('Sin respuesta observada todavía'));
  assert.ok(!offlineBoard.includes('Finalizada técnicamente'));
  const digest = await hashCapture(instance.captureDirectory);
  assert.equal(await admittedCount(instance), 1);

  await page.getByRole('button', { name: 'Nuevo encargo' }).click();
  await upload(page, 'No debe despacharse con el desenlace por comprobar.');
  try {
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent
      ?.includes('ocupado') ?? false, undefined, { timeout: 60000 });
  } catch (error) {
    t.diagnostic(JSON.stringify({ creationTraffic, visible: await page.locator('#conversation').innerText(),
      draft: await page.getByLabel('Encargo').inputValue(),
      executions: (await appFetch(restarted, '/api/executions')).body }));
    throw error;
  }

  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: no disponible') ?? false, undefined, { timeout: 60000 });
  await page.locator('#history button').first().click();
  await awaitStatus(page, 'En ejecución');
  await page.waitForFunction(() => document.querySelector('#engine-offline')?.textContent
    ?.includes('desenlace pendiente de comprobar') ?? false, undefined, { timeout: 60000 });
  assert.equal(await hashCapture(instance.captureDirectory), digest,
    'reloading without an engine altered the original capture bytes');

  await instance.restart();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: disponible') ?? false, undefined, { timeout: 60000 });
  await awaitStatus(page, 'En ejecución');
  await page.waitForFunction(() => document.querySelector('#engine-offline') === null,
    undefined, { timeout: 60000 });
  assert.equal(await admittedCount(instance), 1, 'a reconnection re-sent the assignment');
  assert.equal(await hashCapture(instance.captureDirectory), digest,
    'reconnecting altered the original capture bytes');

  await page.getByRole('button', { name: 'Nuevo encargo' }).click();
  await upload(page, 'Sigue ocupado hasta verificar el desenlace.');
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent
    ?.includes('ocupado') ?? false, undefined, { timeout: 60000 });
  assert.equal(await hashCapture(instance.captureDirectory), digest);
});

test('el chat presenta opciones de la instancia y lanza un comando con el agente y modelo elegidos', { timeout: 480000 }, async t => {
  const instance = await fixture(t, {
    simulation: true,
    syntheticCommands: true,
    config: { secrets: ['synthetic-secret-42'] },
    serverConfig: {
      agents: {
        'synthetic-choice': {
          mode: 'all',
          description: 'Agente sintético de selección',
          system: 'Instrucciones sintéticas del agente elegido.',
        },
      },
    },
  });
  const { app } = await launchWebapp(t, instance);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.url);

  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: disponible') ?? false, undefined, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#agent option[value="synthetic-choice"]') !== null,
    undefined, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#model option[value="synthetic/synthetic#low"]') !== null,
    undefined, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#command option[value="synthetic-echo"]') !== null,
    undefined, { timeout: 60000 });

  await page.getByLabel('Agente').selectOption('synthetic-choice');
  await page.getByLabel('Modelo').selectOption('synthetic/synthetic#low');
  await page.getByLabel('Comando').selectOption('synthetic-echo');
  await upload(page, 'argumento-navegador valor-dos synthetic-secret-42');
  await awaitStatus(page, 'Finalizada técnicamente', 240000);

  const board = await page.locator('#conversation').innerText();
  assert.ok(board.includes('Elegido: synthetic-choice'), 'the board lost the requested agent');
  assert.ok(board.includes('Conocido: synthetic-choice'), 'the board lost the observed agent');
  assert.ok(board.includes('API pública de la sesión'), 'the board lost the selection provenance');
  assert.ok(board.includes('synthetic/synthetic#low'));
  assert.ok(board.includes('synthetic-echo'));
  assert.ok(!board.includes('synthetic-secret-42'), 'command metadata bypassed capture redaction');
  const messages = await page.locator('[aria-label="Mensajes"]').innerText();
  assert.ok(messages.includes('Encargo sintético de comando: argumento-navegador valor-dos [REDACTED]'));
  assert.ok(messages.includes('Respuesta autorizada'));
  assert.ok(!messages.includes('synthetic-secret-42'));
  assert.equal(await admittedCount(instance), 1, 'the browser dispatched the command more than once');
  const sessions = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(sessions.filter(session => (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 1,
    'the browser created more than one root session');

  await page.getByRole('button', { name: 'Nuevo encargo' }).click();
  await page.waitForFunction(() => document.querySelector('#command option[value="synthetic-echo"]') !== null,
    undefined, { timeout: 60000 });
  await page.getByLabel('Comando').selectOption('synthetic-echo');
  await rm(join(instance.root, 'config/opencode/commands/synthetic-echo.md'));
  await eventually(async () => {
    const options = await appFetch(app, '/api/options');
    return options.body.commands.some(command => command.name === 'synthetic-echo') ? undefined : options.body;
  }, 'the deleted synthetic command stayed listed in the app', 30000);
  await upload(page, 'este comando ya no debe estar disponible');
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent
    ?.includes('ya no está disponible') ?? false, undefined, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('#history button').length === 1,
    undefined, { timeout: 60000 });
  assert.equal(await admittedCount(instance), 1, 'a vanished option dispatched work');
  await page.waitForFunction(() => document.querySelector('#command option[value="synthetic-echo"]') === null,
    undefined, { timeout: 60000 });
});

async function fillPendingQuestion(page, requestID) {
  const form = page.locator(`[data-kind="form"][data-request="${requestID}"]`);
  await form.waitFor();
  const select = form.locator('select');
  const checkbox = form.locator('input[type="checkbox"]');
  if (await select.count()) await select.first().selectOption({ index: 1 });
  else if (await checkbox.count()) await checkbox.first().check();
  else await form.locator('input[type="text"], input[type="number"]').first().fill('Continuar synthetic-secret-42');
  await form.getByRole('button', { name: 'Responder pregunta' }).click();
}

test('el navegador detiene una ejecución delegada y conserva sus resultados parciales', { timeout: 480000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { app } = await launchWebapp(t, instance);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.url);
  const rootAdmissions = async root => (await records(instance.captureDirectory))
    .filter(row => row.type === 'session.inbox.enqueued' && row.sessionID === root
      && row.content?.role === 'user').length;
  await upload(page, 'Encargo delegado largo. SYNTHETIC_LONG_RUNNING');
  await awaitStatus(page, 'En ejecución');
  const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
  const root = (await appFetch(app, `/api/executions/${executionId}`)).body.execution.sessionID;
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === root && row.type === 'session.text.delta'), 'root work did not start');
  const child = (await instance.api('/api/session', { parentID: root,
    location: { directory: instance.projects[0] } })).data;
  await instance.api(`/api/session/${child.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING Hijo delegado' });
  await eventually(async () => {
    const detail = (await appFetch(app, `/api/executions/${executionId}`)).body;
    return detail.capture?.scope?.sessionIDs?.includes(child.id) ? detail : undefined;
  }, 'the delegated child did not join the observed execution tree', 60000);
  assert.equal(await page.getByRole('button', { name: 'Detener' }).count(), 1);

  await page.getByRole('button', { name: 'Detener' }).click();
  await page.waitForSelector('#stop-requested', { timeout: 120000 });
  try {
    await awaitStatus(page, 'Interrumpida');
  } catch (error) {
    t.diagnostic(`stop state: ${JSON.stringify((await appFetch(app, `/api/executions/${executionId}`)).body.stop)}`);
    const seen = (await records(instance.captureDirectory)).filter(row =>
      row.sessionID && row.type.startsWith('session.execution.'));
    t.diagnostic(`lifecycle rows: ${JSON.stringify(seen.map(row => `${row.sessionID}:${row.type}`))}`);
    throw error;
  }
  await page.waitForFunction(() => [...document.querySelectorAll('#stop-requested li')]
    .every(item => item.textContent.includes('Detención: confirmada'))
    && document.querySelectorAll('#stop-requested li').length >= 2,
  undefined, { timeout: 120000 });
  const stopPanel = await page.locator('#stop-requested').innerText();
  assert.ok(stopPanel.includes('Solicitud: aceptada'));
  assert.ok(!/Detención: no confirmada/.test(stopPanel));
  assert.ok(stopPanel.includes('no hay interrupción instantánea'));
  assert.equal(await page.getByRole('button', { name: 'Detener' }).count(), 0,
    'a terminal execution still offered a stop action');
  const board = await page.locator('#conversation').innerText();
  assert.ok(board.includes('Encargo delegado largo.'));
  const messageBoard = await page.locator('[aria-label="Mensajes"]').innerText();
  t.diagnostic(`messages: ${JSON.stringify(messageBoard)}`);
  assert.ok(messageBoard.includes('Sin respuesta observada') || messageBoard.includes('Respuesta'),
    'the interrupted execution lost its partial conversation');
  assert.ok(!board.includes('synthetic-secret-42'));

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
    undefined, { timeout: 60000 });
  await page.locator('#history button').first().click();
  await awaitStatus(page, 'Interrumpida');
  const reconciled = await eventually(async () => {
    const text = await page.locator('#stop-requested').innerText().catch(() => null);
    return text && text.includes('Detención solicitada')
      && !/Detención: no confirmada/.test(text)
      && text.includes('Sesión raíz') && text.includes('Subejecución') ? text : undefined;
  }, 'a reload lost the reconciled stop state', 60000);
  assert.ok(reconciled.includes('Solicitud: sin comprobar'));
  assert.equal(await rootAdmissions(root), 1, 'a reload re-sent a stopped assignment');

  await page.getByRole('button', { name: 'Nuevo encargo' }).click();
  await upload(page, 'Encargo tras la detención liberada.');
  await awaitStatus(page, 'Finalizada técnicamente', 240000);
  assert.equal(await rootAdmissions(root), 1, 'the new encargo re-sent the stopped assignment');
  const sessions = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(sessions.filter(session =>
    (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 2,
    'the new encargo did not create its own execution session');
});

test('la detención con el motor caído se muestra no confirmada y recargar no confirma ni relanza', { timeout: 480000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { app } = await launchWebapp(t, instance);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.url);
  await upload(page, 'Encargo largo sin motor. SYNTHETIC_LONG_RUNNING');
  await awaitStatus(page, 'En ejecución');
  const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
  assert.equal(await admittedCount(instance), 1);

  await instance.stop();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent
    ?.includes('Motor: no disponible') ?? false, undefined, { timeout: 60000 });
  await page.getByRole('button', { name: 'Detener' }).click();
  await page.waitForSelector('#stop-requested');
  await page.waitForFunction(() => /Detención: no confirmada/.test(
    document.querySelector('#stop-requested')?.innerText ?? ''), undefined, { timeout: 60000 });
  const unconfirmed = await page.locator('#stop-requested').innerText();
  assert.ok(unconfirmed.includes('Solicitud: fallo de la solicitud'));
  assert.ok(!unconfirmed.includes('Detención: confirmada'),
    'an engine failure was displayed as a confirmed stop');
  await page.waitForFunction(() => document.querySelector('#engine-offline')?.textContent
    ?.includes('desenlace pendiente de comprobar') ?? false, undefined, { timeout: 60000 });
  assert.equal((await appFetch(app, `/api/executions/${executionId}`)).body.execution.status, 'running',
    'a failed stop request released the execution');
  assert.equal(await admittedCount(instance), 1, 'a failed stop dispatched work again');

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
    undefined, { timeout: 60000 });
  await page.locator('#history button').first().click();
  await awaitStatus(page, 'En ejecución');
  const reloaded = await eventually(async () => {
    const text = await page.locator('#stop-requested').innerText().catch(() => null);
    return text && text.includes('Detención solicitada')
      && text.includes('Detención: no confirmada') ? text : undefined;
  }, 'a reload lost the unconfirmed stop state', 60000);
  assert.ok(reloaded.includes('Solicitud: sin comprobar'),
    'a reload invented a stop request result it cannot verify');
  assert.equal(await admittedCount(instance), 1, 'a reload re-sent the assignment');

  await page.getByRole('button', { name: 'Nuevo encargo' }).click();
  await upload(page, 'No debe lanzarse con desenlace pendiente.');
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent
    ?.includes('ocupado') ?? false, undefined, { timeout: 60000 });
  assert.equal(await admittedCount(instance), 1);
});

test('el fallo de persistencia del registrador se avisa en el navegador y no desbloquea el proyecto', { timeout: 480000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { app } = await launchWebapp(t, instance);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.url);
  await upload(page, 'Encargo persistente. SYNTHETIC_LONG_RUNNING');
  await awaitStatus(page, 'En ejecución');
  const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
  const root = (await appFetch(app, `/api/executions/${executionId}`)).body.execution.sessionID;
  const digest = await hashCapture(instance.captureDirectory);

  const preserved = join(instance.root, 'preserved');
  await rename(instance.captureDirectory, preserved);
  await writeFile(instance.captureDirectory, 'Synthetic persistence failure');
  await instance.api(`/api/session/${root}`, { title: 'Fallo sintético de persistencia' }, 'PATCH');
  const failure = await eventually(async () => {
    const text = await page.locator('#recorder-failure').innerText().catch(() => null);
    return text && text.includes('Fallo del registrador')
      && text.includes('Estado de captura: no consultable') ? text : undefined;
  }, 'the recorder failure notice did not surface with an unreadable capture', 30000);
  assert.ok(failure.includes('Revisión requerida'));
  assert.ok(failure.includes('no hay desbloqueo automático'));
  assert.ok(failure.includes('Motivo público declarado'), 'the public session notice was not surfaced');
  const detail = (await appFetch(app, `/api/executions/${executionId}`)).body;
  assert.ok(!TERMINAL_STATUSES.includes(detail.execution.status),
    'a recorder failure produced an unobserved terminal state');
  assert.notEqual((await createExecution(app, 'persistencia-bloqueo', 'No debe lanzarse.')).status, 201,
    'a recorder failure released the project');

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
    undefined, { timeout: 60000 });
  await page.locator('#history button').first().click();
  await page.waitForSelector('#recorder-failure');
  await awaitStatus(page, 'En ejecución');

  await unlink(instance.captureDirectory);
  await rename(preserved, instance.captureDirectory);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
    undefined, { timeout: 60000 });
  await page.locator('#history button').first().click();
  await page.waitForSelector('#recorder-failure');
  const repaired = await eventually(async () => {
    const text = await page.locator('#recorder-failure').innerText().catch(() => null);
    return text && text.includes('Fallo del registrador')
      && text.includes('Estado de captura: consultable') ? text : undefined;
  }, 'the repaired capture path was not reported as readable', 30000);
  assert.ok(repaired.includes('Motivo público declarado'),
    'repairing the path hid the public failure notice');
  const afterRepair = (await appFetch(app, `/api/executions/${executionId}`)).body;
  assert.ok(!TERMINAL_STATUSES.includes(afterRepair.execution.status),
    'repairing the capture path released the project without new evidence');
  assert.notEqual((await createExecution(app, 'persistencia-reparada', 'No debe lanzarse.')).status, 201,
    'the app unlocked the durable guard by repairing the path');
  assert.equal(await hashCapture(instance.captureDirectory), digest,
    'the recorder failure scenario altered the preserved capture bytes');
});

test('el navegador responde preguntas y permisos nativos y reconstruye las pendientes al recargar',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true,
      config: { secrets: ['synthetic-secret-42'] } });
    const { app } = await launchWebapp(t, instance);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelector('#status')?.textContent
      ?.includes('Motor: disponible') ?? false, undefined, { timeout: 60000 });

    await upload(page, 'SYNTHETIC_HUMAN');
    await awaitStatus(page, 'En ejecución');
    const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
    const root = (await appFetch(app, `/api/executions/${executionId}`)).body.execution.sessionID;
    await page.waitForSelector(`[data-kind="form"][data-session="${root}"]`);
    const rootPanel = page.locator(`[data-kind="form"][data-session="${root}"]`);
    assert.ok((await rootPanel.innerText()).includes('Pregunta nativa'));
    assert.ok((await rootPanel.innerText()).includes('Sesión raíz'));
    assert.ok((await page.locator('[aria-label="Intervención"]').innerText())
      .includes('La ejecución espera intervención'));

    const child = await eventually(async () => {
      const session = (await instance.api('/api/session', { parentID: root,
        location: { directory: instance.projects[0] },
        permissions: [{ action: 'synthetic.approval', resource: '*', effect: 'ask' }] })).data;
      await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_HUMAN' });
      await eventually(async () => (await records(instance.captureDirectory))
        .some(row => row.sessionID === session.id && row.type === 'form.created'),
        'child question was not persisted');
      return session.id;
    }, 'child session could not be observed');
    await page.waitForSelector(`[data-kind="form"][data-session="${child}"]`);
    const childPanelText = await page.locator(`[data-kind="form"][data-session="${child}"]`).innerText();
    assert.ok(childPanelText.includes('Subejecución'));

    const foreign = (await instance.api('/api/session',
      { location: { directory: instance.projects[0] } })).data;
    const foreignForm = (await instance.api(`/api/session/${foreign.id}/form`, {
      title: 'Pregunta ajena sintética', fields: [{ key: 'answer', type: 'string' }] })).data;
    assert.equal(await page.locator(`[data-request="${foreignForm.id}"]`).count(), 0,
      'a foreign interaction appeared in the execution panel');

    const negativeForm = (await instance.api(`/api/session/${root}/form`, {
      title: 'Booleano público sintético',
      fields: [{ key: 'confirmed', type: 'boolean', title: 'Confirmación', required: true }],
    })).data;
    const negativePanel = page.locator(`[data-kind="form"][data-request="${negativeForm.id}"]`);
    await negativePanel.waitFor();
    assert.equal(await negativePanel.locator('input[type="checkbox"]').isChecked(), false);
    await negativePanel.getByRole('button', { name: 'Responder pregunta' }).click();
    await eventually(async () => (await records(instance.captureDirectory)).some(row =>
      row.type === 'form.replied' && row.sessionID === root
      && row.interaction?.requestID === negativeForm.id && row.interaction.response?.confirmed === false),
    'an untouched boolean checkbox did not submit false to the real runtime');

    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
      undefined, { timeout: 60000 });
    await page.locator('#history button').first().click();
    await page.waitForSelector(`[data-kind="form"][data-session="${root}"]`);
    await page.waitForSelector(`[data-kind="form"][data-session="${child}"]`);

    const pending = (await appFetch(app, `/api/executions/${executionId}`)).body.interactions.pending;
    const childQuestion = pending.find(item => item.kind === 'form' && item.sessionID === child);
    await fillPendingQuestion(page, childQuestion.requestID);
    await page.waitForSelector('[data-kind="permission"]');
    const permissionText = await page.locator('[data-kind="permission"]').innerText();
    assert.ok(permissionText.includes('Permiso nativo'));
    assert.ok(permissionText.includes('Subejecución'));
    assert.ok(permissionText.includes('synthetic.approval'));
    assert.ok(permissionText.includes('Synthetic resource [REDACTED]'));
    assert.ok(!permissionText.includes('synthetic-secret-42'));
    let lostResponses = 0;
    await page.route(`**/api/executions/${executionId}/interactions`, async route => {
      await route.fetch();
      lostResponses++;
      await route.abort('failed');
    }, { times: 1 });
    await page.locator('[data-kind="permission"] button[data-decision="once"]').click();
    await page.getByRole('alert').filter({ hasText: 'Respuesta posiblemente enviada' }).waitFor();
    assert.ok(!(await page.getByRole('alert').allTextContents()).join(' ').includes('no se ha concedido'));
    await page.waitForFunction(() => !document.querySelector('[data-kind="permission"]'),
      undefined, { timeout: 60000 });
    assert.equal(lostResponses, 1);
    const childPermissionReplies = (await records(instance.captureDirectory)).filter(row =>
      row.type === 'permission.replied' && row.sessionID === child);
    assert.equal(childPermissionReplies.length, 1, 'a lost HTTP response retried the native permission');

    const rootQuestion = (await appFetch(app, `/api/executions/${executionId}`))
      .body.interactions.pending.find(item => item.kind === 'form' && item.sessionID === root);
    await instance.api(`/api/session/${root}`, {
      permissions: [{ action: 'synthetic.approval', resource: '*', effect: 'ask' }],
    }, 'PATCH');
    await fillPendingQuestion(page, rootQuestion.requestID);
    let rootPermissionsAnswered = 0;
    for (let round = 0; round < 3; round++) {
      const handle = await page.waitForFunction(() => {
        const status = document.querySelector('#execution-status')?.textContent ?? '';
        if (status.includes('Finalizada técnicamente')) return 'final';
        if (document.querySelector('[data-kind="permission"]')) return 'permission';
        return false;
      }, undefined, { polling: 750, timeout: 240000 });
      let outcome;
      try { outcome = await handle.jsonValue(); }
      finally { await handle.dispose(); }
      if (outcome === 'final') break;
      if (outcome !== 'permission') break;
      await page.locator('[data-kind="permission"] button[data-decision="once"]').first().click();
      rootPermissionsAnswered++;
      await page.waitForFunction(() => !document.querySelector('[data-kind="permission"]'),
        undefined, { timeout: 60000 });
    }
    await awaitStatus(page, 'Finalizada técnicamente', 240000);
    assert.ok(rootPermissionsAnswered > 0, 'the JSHandle outcome branch never answered a real root permission');

    await page.getByText('Respuestas registradas en la captura', { exact: true }).click();
    const evidenceText = await page.locator('[aria-label="Respuestas registradas"]').innerText();
    assert.ok(evidenceText.includes('once'), 'the permission decision was not consultable');
    assert.ok(evidenceText.includes('cliente externo no identificado'),
      'the authorized evidence lost its unattributed provenance');
    const board = await page.locator('#conversation').innerText();
    assert.ok(!board.includes('synthetic-secret-42'), 'interaction answers bypassed capture redaction');
    assert.equal(await admittedCount(instance), 2,
      'answering native interactions re-sent or dispatched work');
    assert.equal((await records(instance.captureDirectory)).filter(row =>
      row.type === 'permission.replied' && row.sessionID === child).length, 1,
    'the permission was replied again after reconciling the lost HTTP response');
    const sessions = (await instance.api(
      `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
    assert.equal(sessions.filter(session =>
      (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 1,
      'answering native interactions created another root session');
  });

test('el navegador explora el árbol, la línea temporal y el diagnóstico de una delegación anidada y concurrente',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true, config: { secrets: ['synthetic-secret-42'] },
      serverConfig: { experimental: { subagent_depth: 3 }, agents: { 'synthetic-branch': { mode: 'all',
        description: 'Synthetic branching agent',
        permissions: [{ action: 'subagent', resource: 'synthetic-branch', effect: 'allow' }] } } } });
    const { app } = await launchWebapp(t, instance);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(app.url);
    await upload(page, 'Encargo delegado anidado. SYNTHETIC_TREE_ROOT');
    await awaitStatus(page, 'Finalizada técnicamente', 300000);
    const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
    const root = (await appFetch(app, `/api/executions/${executionId}`)).body.execution.sessionID;

    await page.waitForFunction(() => document.querySelectorAll('#trace .tree-node').length >= 4,
      undefined, { timeout: 120000 });
    const treeText = await page.locator('[aria-label="Árbol de subejecuciones"]').innerText();
    assert.ok(treeText.includes(`Sesión raíz ${root}`));
    assert.ok((treeText.match(/Subejecución/g) ?? []).length >= 3, 'the nested branches were not shown');
    assert.match(treeText, /hija por \d+ llamada\(s\) observada\(s\): \S+ · call_synthetic_delegate_0 ·/);
    assert.ok(treeText.includes('agente: synthetic-branch'));
    const domSessions = await page.$$eval('#trace .tree-node button',
      buttons => buttons.map(button => button.dataset.session));
    const readerSessions = [...new Set(execFileSync(process.execPath,
      [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)),
        instance.captureDirectory, root, '--tree'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map(JSON.parse)
      .map(row => row.sessionID).filter(Boolean))];
    assert.deepEqual(new Set(domSessions), new Set(readerSessions),
      'the browser tree diverged from the independent reader');

    const timelineText = await page.locator('[aria-label="Línea temporal"]').innerText();
    assert.ok(timelineText.includes('transcurrido:'));
    assert.ok(timelineText.includes('procedencia: opencode.event.sourceTime'));
    assert.ok(timelineText.includes('Sesión raíz'));
    assert.ok(timelineText.includes('Subejecución'));
    assert.ok(timelineText.includes('pueden solaparse'));
    assert.ok(timelineText.includes('no se suman ramas concurrentes'));
    assert.ok(!timelineText.includes('Duración total del flujo:'));
    assert.ok(await page.locator('#trace .bar').count() >= 4, 'the timeline bars were not drawn');

    const coverageText = await page.locator('[aria-label="Cobertura de captura y diagnósticos"]').innerText();
    assert.ok(coverageText.includes('sin evaluar (readiness: not-assessed)'));
    assert.ok(coverageText.includes('no son una evaluación'));
    assert.ok(coverageText.includes(root));
    assert.ok(!coverageText.includes('Aprobado'), 'a technical diagnostic was shown as a verdict');

    await page.locator('[aria-label="Herramientas e intentos"] > summary').click();
    const toolsText = await page.locator('[aria-label="Herramientas e intentos"]').textContent();
    assert.ok(toolsText.includes('llamada call_synthetic_delegate_0'));
    assert.ok(toolsText.includes(`sesión ${root}`));
    assert.ok(toolsText.includes('Consumo: desconocido, no cero'));
    assert.ok(toolsText.includes('Evidencia:'));
    assert.ok(!toolsText.includes('synthetic-secret-42'), 'tool details leaked a secret');

    await page.locator('#trace .tree-node', { hasText: `${root} · call_synthetic_delegate_0` })
      .locator('button').click();
    await page.waitForFunction(() => document.querySelectorAll('#trace .tree-node').length === 2
      && document.querySelector('#trace')?.textContent?.includes('(raíz de la vista)'),
    undefined, { timeout: 120000 });
    const scopedTimeline = await page.locator('[aria-label="Línea temporal"]').innerText();
    assert.ok(!scopedTimeline.includes(root),
      'the sub-execution timeline mixed the root execution session');

    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
      undefined, { timeout: 60000 });
    await page.locator('#history button').first().click();
    await awaitStatus(page, 'Finalizada técnicamente', 60000);
    await page.waitForFunction(() => document.querySelectorAll('#trace .tree-node').length >= 4,
      undefined, { timeout: 120000 });

    await page.getByRole('button', { name: 'Nuevo encargo' }).click();
    await upload(page, 'Encargo corto tras el árbol.');
    await awaitStatus(page, 'Finalizada técnicamente', 300000);
    await page.waitForFunction(() => document.querySelectorAll('#trace .tree-node').length === 1,
      undefined, { timeout: 120000 });
    const secondText = await page.locator('[aria-label="Árbol de subejecuciones"]').innerText();
    assert.ok(!secondText.includes(root), 'the second execution mixed the first tree');

    const beforeOffline = await admittedCount(instance);
    await instance.stop();
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 2,
      undefined, { timeout: 60000 });
    await page.locator('#history button').nth(1).click();
    await awaitStatus(page, 'Finalizada técnicamente', 60000);
    await page.waitForFunction(() => document.querySelectorAll('#trace .tree-node').length >= 4,
      undefined, { timeout: 120000 });
    const offlineTree = await page.locator('[aria-label="Árbol de subejecuciones"]').innerText();
    assert.ok(offlineTree.includes(`Sesión raíz ${root}`));
    assert.ok((await page.locator('#status').innerText()).includes('Motor: no disponible'));
    const offlineCoverage = await page.locator('[aria-label="Cobertura de captura y diagnósticos"]').innerText();
    assert.ok(offlineCoverage.includes('Horizonte de lectura por diario')
      || (await page.locator('[aria-label="Cobertura de captura y diagnósticos"]').textContent())
        .includes('Horizonte de lectura por diario'));
    assert.equal(await admittedCount(instance), beforeOffline,
      'the offline reconstruction dispatched work');
  });

test('la vista mantiene desconocida una llamada sin desenlace y distingue skills observadas de disponibles',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true,
      syntheticDefinitions: true, modelCost: { input: 1, output: 2 },
      config: { secrets: ['synthetic-secret-42'] } });
    const { app } = await launchWebapp(t, instance);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(app.url);
    await upload(page, 'Encargo con herramienta retenida. SYNTHETIC_ACTION_HOLD');
    await awaitStatus(page, 'En ejecución');
    const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
    const root = (await appFetch(app, `/api/executions/${executionId}`)).body.execution.sessionID;

    await page.waitForFunction(() => document.querySelector('#trace')?.textContent
      ?.includes('sin desenlace observado'), undefined, { timeout: 120000 });
    await page.locator('[aria-label="Herramientas e intentos"] > summary').click();
    const toolsText = await page.locator('[aria-label="Herramientas e intentos"]').textContent();
    assert.ok(toolsText.includes('sin desenlace observado: desconocido'), 'the open call gained an outcome');
    assert.ok(toolsText.includes('llamada call_synthetic_action'));
    assert.ok(toolsText.includes(`sesión ${root}`));
    assert.ok(toolsText.includes('Consumo: desconocido, no cero'));
    assert.ok(toolsText.includes('No se agrupan reintentos por nombre'));
    assert.ok(toolsText.includes('Incidente: outcome-not-observed'));
    assert.ok(!toolsText.includes('éxito observado'));
    assert.ok(toolsText.includes('Evidencia:'));
    assert.ok(toolsText.includes('fila '));
    assert.ok(!toolsText.includes('synthetic-secret-42'), 'tool details leaked a secret');

    const coverageText = await page.locator('[aria-label="Cobertura de captura y diagnósticos"]').innerText();
    assert.ok(coverageText.includes('sin evaluar (readiness: not-assessed)'));
    assert.ok(coverageText.includes('no son una evaluación'));
    assert.ok(!coverageText.includes('Aprobado'), 'a technical diagnostic was shown as a verdict');

    await page.getByRole('button', { name: 'Detener' }).click();
    await awaitStatus(page, 'Interrumpida', 240000);

    await page.getByRole('button', { name: 'Nuevo encargo' }).click();
    await upload(page, 'Encargo con skill. SYNTHETIC_SKILL_LOAD');
    await awaitStatus(page, 'Finalizada técnicamente', 300000);
    await page.locator('[aria-label="Skills y definiciones"] > summary').click();
    const skillsBlock = page.locator('[aria-label="Skills y definiciones"]');
    const observedText = await skillsBlock.locator('[aria-label="Skills observadas"]').textContent();
    assert.ok(observedText.includes('transformed'));
    assert.ok(observedText.includes('SHA-256 del contenido filtrado'));
    assert.ok(!observedText.includes('unused'), 'an available-only skill appeared as observed');
    const availableText = await skillsBlock.locator('[aria-label="Skills disponibles"]').textContent();
    assert.ok(availableText.includes('unused'), 'available skills were not listed separately');
    assert.ok(availableText.includes('no garantiza selección final'));
    const definitionsText = await skillsBlock.locator('[aria-label="Definiciones observadas"]').textContent();
    assert.ok(definitionsText.includes('transformed'));
    assert.ok(definitionsText.includes('no es una foto histórica'),
      'the definition lost its provenance caveat');
    const environmentText = await skillsBlock.locator('[aria-label="Entorno de plugins"]').textContent();
    assert.ok(environmentText.includes('synthetic.definitions'));
    assert.ok(environmentText.includes('quedan desconocidos'));

    await page.locator('[aria-label="Métricas"] > summary').click();
    const metricsText = await page.locator('[aria-label="Métricas"]').textContent();
    assert.ok(metricsText.includes('valor normalizado que informa el runtime'));
    assert.ok(metricsText.includes('no es una factura'));
    assert.ok(metricsText.includes('La duración total del flujo no se expone'));
    assert.ok(metricsText.includes('nunca cero'));

    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
      undefined, { timeout: 60000 });
    await page.locator('#history button').first().click();
    await awaitStatus(page, 'Finalizada técnicamente', 60000);
    await page.locator('[aria-label="Skills y definiciones"] > summary').click();
    const reloadedText = await page.locator('[aria-label="Skills observadas"]').textContent();
    assert.ok(reloadedText.includes('transformed'), 'the observed skills were not rebuilt after a reload');
    assert.equal(await admittedCount(instance), 2, 'browsing the trace dispatched work');
  });

test('el navegador consulta entregables de raíz y subejecuciones y preserva los bytes de la captura',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticDeliverables: true,
      config: { secrets: ['synthetic-deliverable-secret', 'synthetic-secret-42'] },
      serverConfig: { experimental: { subagent_depth: 3 }, agents: { 'synthetic-branch': { mode: 'all',
        description: 'Synthetic branching agent',
        permissions: [{ action: 'subagent', resource: 'synthetic-branch', effect: 'allow' }] } } } });
    await mkdir(join(instance.projects[0], 'directory'));
    await writeFile(join(instance.projects[0], 'binary.bin'), Buffer.from([0, 255, 1, 2]));
    await writeFile(join(instance.projects[1], 'outside.txt'), 'synthetic-outside-deliverable');
    await symlink(instance.projects[1], join(instance.projects[0], 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const { app } = await launchWebapp(t, instance);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(app.url);
    await upload(page, 'Encargo con entregables delegados. SYNTHETIC_DELIVERABLE_TREE');
    await awaitStatus(page, 'Fallida', 300000);
    const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
    const root = (await appFetch(app, `/api/executions/${executionId}`)).body.execution.sessionID;
    const overview = (await appFetch(app, `/api/executions/${executionId}/deliverables`)).body;
    assert.equal(overview.sessions.length, 4);
    const produceSession = overview.sessions.find(group => group.sessionID !== root
      && group.deliverables.some(item => item.value?.content?.includes('Synthetic produced result'))).sessionID;
    assert.ok(produceSession, 'no child session captured a deliverable snapshot');

    await page.waitForFunction(() => document.querySelectorAll('#deliverables .deliverable-sessions > li').length === 4,
      undefined, { timeout: 120000 });
    const panel = () => page.locator('#deliverables').innerText();
    let deliverablesText = await panel();
    assert.ok(deliverablesText.includes('consultadas una a una'));
    assert.ok(deliverablesText.includes('una consulta de raíz no incluye descendientes'));
    assert.ok(deliverablesText.includes('La finalidad global no está acreditada'));
    assert.ok(deliverablesText.includes('no acredita que este contenido sea el resultado final del flujo'));
    assert.ok(deliverablesText.includes('Resultados parciales de una ejecución fallida o interrumpida'));
    assert.ok(deliverablesText.includes('Sesión raíz'));
    assert.ok(deliverablesText.includes('Subejecución'));
    assert.ok(deliverablesText.includes('Sin entregables capturados para esta sesión'));
    assert.ok(deliverablesText.includes('lectura posterior al evento o hook'));
    assert.ok(deliverablesText.includes('Contenido no adquirido'));
    assert.ok(deliverablesText.includes('deliverable-reference-unavailable'));
    assert.ok(deliverablesText.includes('deliverable-outside-project'));
    assert.ok(deliverablesText.includes('file-read-is-not-runtime-version'));
    assert.ok(deliverablesText.includes('SHA-256 (redacted-json-utf8)'));
    assert.ok(deliverablesText.includes('llamada call_synthetic_deliverable'));
    assert.ok(deliverablesText.includes('Fuente: opencode.session.tool.content'));
    assert.ok(deliverablesText.includes('no acredita qué bytes produjo o utilizó la acción original'));
    assert.ok(!deliverablesText.includes('Aprobado'), 'a partial result was shown as acceptance');
    assert.ok(!deliverablesText.includes('éxito observado'), 'a partial result was labeled as success');
    assert.ok(!deliverablesText.includes('synthetic-deliverable-secret'), 'deliverables leaked a secret');
    assert.ok(!deliverablesText.includes('synthetic-deliverable-token'), 'deliverables leaked a token');
    assert.ok(!deliverablesText.includes('synthetic-outside-deliverable'), 'an outside file was read');

    for (let index = 0; index < await page.locator('#deliverables details > summary').count(); index++) {
      await page.locator('#deliverables details > summary').nth(index).click();
    }
    const contents = await page.locator('#deliverables pre').allInnerTexts();
    assert.ok(contents.some(text => text === 'Synthetic produced result. [REDACTED]\n[REDACTED]'),
      'the captured deliverable content was not preserved verbatim');

    await page.locator(`#trace .tree-node button[data-session="${root}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#deliverables .deliverable-sessions > li').length === 1
      && document.querySelector('#deliverables')?.textContent?.includes('Consulta de una sola sesión'),
    undefined, { timeout: 120000 });
    deliverablesText = await panel();
    assert.ok(deliverablesText.includes('no incluye los entregables de sus descendientes'));
    assert.ok(!deliverablesText.includes(produceSession), 'the root query mixed a child deliverable');
    await page.locator(`#trace .tree-node button[data-session="${produceSession}"]`).click();
    await page.waitForFunction(sessionID => document.querySelector('#deliverables li[data-session]')
      ?.dataset?.session === sessionID
      && document.querySelectorAll('#deliverables .deliverable-sessions > li').length === 1,
    produceSession, { timeout: 120000 });
    deliverablesText = await panel();
    assert.ok(deliverablesText.includes('Snapshots conservados: 1'));
    assert.ok(!deliverablesText.includes(`Subejecución ${root}`), 'the child query mixed the root session');

    let digestBefore = await hashCapture(instance.captureDirectory);
    let admissionsBefore = await admittedCount(instance);
    await writeFile(join(instance.projects[0], 'result.txt'), 'Synthetic later unobserved revision.');
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
      undefined, { timeout: 60000 });
    await page.locator(`#history button[data-id="${executionId}"]`).click();
    await awaitStatus(page, 'Fallida', 60000);
    await page.locator(`#trace .tree-node button[data-session="${root}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#deliverables .deliverable-sessions > li').length === 1,
      undefined, { timeout: 120000 });
    await page.locator('#deliverables details > summary').first().click();
    let preserved = await page.locator('#deliverables pre').first().innerText();
    assert.equal(preserved, 'Synthetic produced result. [REDACTED]\n[REDACTED]',
      'changing the original file altered the conserved snapshot');
    await rm(join(instance.projects[0], 'result.txt'));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
      undefined, { timeout: 60000 });
    await page.locator(`#history button[data-id="${executionId}"]`).click();
    await awaitStatus(page, 'Fallida', 60000);
    await page.locator(`#trace .tree-node button[data-session="${root}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#deliverables .deliverable-sessions > li').length === 1,
      undefined, { timeout: 120000 });
    await page.locator('#deliverables details > summary').first().click();
    preserved = await page.locator('#deliverables pre').first().innerText();
    assert.equal(preserved, 'Synthetic produced result. [REDACTED]\n[REDACTED]',
      'deleting the original file altered the conserved snapshot');

    await page.getByRole('button', { name: 'Nuevo encargo' }).click();
    await upload(page, 'Encargo corto sin entregables.');
    await awaitStatus(page, 'Finalizada técnicamente', 300000);
    const secondId = (await appFetch(app, '/api/executions')).body.executions[0].id;
    assert.notEqual(secondId, executionId);
    await page.waitForFunction(() => document.querySelectorAll('#deliverables .deliverable-sessions > li').length === 1,
      undefined, { timeout: 120000 });
    const secondText = await panel();
    assert.ok(secondText.includes('Sin entregables capturados para esta sesión'));
    assert.ok(!secondText.includes(root), 'the second execution mixed the first tree');
    assert.ok(!secondText.includes(produceSession), 'the second execution mixed a child of the first tree');

    digestBefore = await hashCapture(instance.captureDirectory);
    admissionsBefore = await admittedCount(instance);
    await instance.stop();
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 2,
      undefined, { timeout: 60000 });
    await page.locator(`#history button[data-id="${executionId}"]`).click();
    await awaitStatus(page, 'Fallida', 60000);
    await page.locator(`#trace .tree-node button[data-session="${root}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#deliverables .deliverable-sessions > li').length === 1,
      undefined, { timeout: 120000 });
    assert.ok((await page.locator('#status').innerText()).includes('Motor: no disponible'));
    await page.locator('#deliverables details > summary').first().click();
    preserved = await page.locator('#deliverables pre').first().innerText();
    assert.equal(preserved, 'Synthetic produced result. [REDACTED]\n[REDACTED]',
      'the offline query altered the conserved snapshot');
    assert.equal(await admittedCount(instance), admissionsBefore,
      'consulting deliverables with the engine down dispatched work');
    assert.equal(await hashCapture(instance.captureDirectory), digestBefore,
      'browsing deliverables altered captured evidence');
  });

test('las vistas de rúbricas y evaluaciones muestran ausencia real sin despachar agentes evaluadores',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true });
    const { app } = await launchWebapp(t, instance);
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(app.url);
    await upload(page, 'Encargo sintético del corte de evaluaciones.');
    await awaitStatus(page, 'Finalizada técnicamente', 300000);

    const evaluation = await page.locator('#evaluation').innerText();
    assert.ok(evaluation.includes('Evaluación: sin evaluación.'),
      'a succeeded execution with no results showed something else than an explicit absence');
    assert.ok(evaluation.includes('no equivale a una aceptación'));
    assert.ok(evaluation.includes('no hay juez implementado'));
    const rubrics = await page.locator('#rubrics').innerText();
    assert.ok(rubrics.includes('Rúbricas: sin rúbricas versionadas.'));
    assert.ok(rubrics.includes('no es una rúbrica aprobada'));
    assert.equal(await page.locator('#evaluation button, #rubrics button').count(), 0,
      'the absent views offered evaluation or editing actions');

    const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
    const sessionsBefore = (await instance.api(
      `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data.length;
    const admissionsBefore = await admittedCount(instance);
    const digestBefore = await hashCapture(instance.captureDirectory);

    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
      undefined, { timeout: 60000 });
    await page.locator(`#history button[data-id="${executionId}"]`).click();
    await page.waitForFunction(() => document.querySelector('#evaluation')?.textContent
      ?.includes('Evaluación: sin evaluación.') ?? false, undefined, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#rubrics')?.textContent
      ?.includes('Rúbricas: sin rúbricas versionadas.') ?? false, undefined, { timeout: 60000 });
    await page.waitForTimeout(3500);

    assert.equal(await admittedCount(instance), admissionsBefore,
      'opening the evaluation views dispatched an evaluator admission');
    assert.equal((await instance.api(
      `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data.length,
    sessionsBefore, 'opening the evaluation views dispatched an evaluator session');
    assert.equal(await hashCapture(instance.captureDirectory), digestBefore,
      'opening the evaluation views altered captured evidence');
  });

const syntheticRubricRows = [
  { rubricID: 'refinamiento-historias', version: '2026-10-31', status: 'approved',
    title: 'Rúbrica sintética de refinamiento',
    criteria: [
      { id: 'cobertura', title: 'Cobertura del encargo', weight: 2, mandatory: false },
      { id: 'fidelidad', title: 'Fidelidad a las decisiones', weight: 1, mandatory: true },
    ],
    content: 'Contenido sintético de la versión aprobada de la rúbrica.',
    observedAt: 1764000000000 },
  { rubricID: 'refinamiento-historias', version: '2026-11-12', status: 'draft',
    title: 'Rúbrica sintética de refinamiento',
    criteria: [{ id: 'cobertura', title: 'Cobertura del encargo', weight: 2, mandatory: false }],
    content: 'Contenido sintético del borrador posterior.',
    observedAt: 1764300000000 },
];

const syntheticEvaluationRows = (executionID, captureID) => ([
  { evaluationID: 'eval-sintetica-1', executionID, captureID,
    captureReference: 'captura sintética de la sesión raíz de la ejecución',
    reevaluationOf: null, evaluatedAt: 1764000001000,
    rubric: { rubricID: 'refinamiento-historias', version: '2026-10-31' },
    versions: { component: 'depurador-historias@1', case: 'caso-refinamiento@1',
      rubric: '2026-10-31', evaluator: 'juez-sintetico@1' },
    criteria: [
      { id: 'cobertura', status: 'evaluated', score: 0.9, weight: 2, mandatory: false,
        evidence: ['captura · fila 3 (session.text.ended)'] },
      { id: 'fidelidad', status: 'not-evaluable',
        reason: 'sin evidencia suficiente de la decisión aprobada', weight: 1, mandatory: true },
    ],
    score: { value: 0.9, basis: 'criterios-evaluados' },
    coverage: { evaluatedWeight: 2, applicableWeight: 3 },
    acceptance: 'pending' },
  { evaluationID: 'eval-sintetica-2', executionID, captureID,
    captureReference: 'captura sintética de la sesión raíz de la ejecución',
    reevaluationOf: 'eval-sintetica-1', evaluatedAt: 1764300001000,
    rubric: { rubricID: 'refinamiento-historias', version: '2026-11-12' },
    versions: { component: 'depurador-historias@1', case: 'caso-refinamiento@1',
      rubric: '2026-11-12', evaluator: null },
    criteria: [
      { id: 'cobertura', status: 'evaluated', score: 0.95, weight: 2, mandatory: false,
        evidence: ['captura · fila 5 (session.text.ended)'] },
    ],
    score: { value: 0.95, basis: 'criterios-evaluados' },
    coverage: { evaluatedWeight: 1, applicableWeight: 1 },
    acceptance: null },
  { evaluationID: 'eval-sintetica-3', executionID, captureID,
    captureReference: 'captura sintética de la sesión raíz de la ejecución',
    reevaluationOf: 'eval-sintetica-1', evaluatedAt: 1764600001000,
    rubric: { rubricID: 'refinamiento-historias', version: '2026-12-01' },
    versions: { component: null, case: null, rubric: '2026-12-01', evaluator: null },
    criteria: [], score: null, coverage: null, acceptance: null },
]);

test('las vistas con fixtures sintéticos muestran contenido, versiones y varios resultados sin despachar agentes',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true });
    const fixturesDirectory = join(instance.root, 'evaluation-fixtures');
    const { app } = await launchWebapp(t, instance, { evaluationFixtures: fixturesDirectory });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(app.url);
    await upload(page, 'Encargo sintético del corte de evaluaciones.');
    await awaitStatus(page, 'Finalizada técnicamente', 300000);
    const executionId = (await appFetch(app, '/api/executions')).body.executions[0].id;
    const detail = (await appFetch(app, `/api/executions/${executionId}`)).body;
    const captureID = detail.capture.captureIDs[0];
    await mkdir(fixturesDirectory, { recursive: true });
    await writeFile(join(fixturesDirectory, 'rubrics.jsonl'),
      syntheticRubricRows.map(row => `${JSON.stringify(row)}\n`).join(''));
    await writeFile(join(fixturesDirectory, 'evaluations.jsonl'),
      syntheticEvaluationRows(executionId, captureID).map(row => `${JSON.stringify(row)}\n`).join(''));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
      undefined, { timeout: 60000 });
    await page.locator(`#history button[data-id="${executionId}"]`).click();

    const evaluationsPanel = () => page.locator('#evaluation').innerText();
    await page.waitForFunction(() => document.querySelectorAll('#evaluation details').length >= 3,
      undefined, { timeout: 60000 });
    let evaluationText = await evaluationsPanel();
    assert.ok(evaluationText.includes('Evaluación eval-sintetica-1'));
    assert.ok(evaluationText.includes('Reevaluación de eval-sintetica-1'));
    for (let index = 0; index < await page.locator('#evaluation details > summary').count(); index++) {
      await page.locator('#evaluation details > summary').nth(index).click();
    }
    evaluationText = await evaluationsPanel();
    assert.ok(evaluationText.includes('Aceptación: pendiente'));
    assert.ok(evaluationText.includes('Puntuación sobre los criterios evaluados: 0.9'));
    assert.ok(evaluationText.includes('Cobertura de evaluación: 2 de 3'));
    assert.ok(evaluationText.includes('no evaluable: sin evidencia suficiente de la decisión aprobada'));
    assert.ok(evaluationText.includes('Evidencia: captura · fila 3 (session.text.ended)'));
    assert.ok(evaluationText.includes('versión aprobada explícitamente identificada'));
    assert.ok(evaluationText.includes('Versión de componente: depurador-historias@1'));
    assert.ok(evaluationText.includes('Versión de evaluador: juez-sintetico@1'));
    assert.ok(evaluationText.includes('Versión de evaluador: desconocida'));
    assert.ok(evaluationText.includes('Puntuación: desconocida; no se transforma en cero'));
    assert.ok(evaluationText.includes('Aceptación: no declarada'));
    assert.ok(evaluationText.includes('estado de versión desconocido'));
    assert.ok(evaluationText.includes('el contenido de esa versión no está disponible'));
    assert.ok(evaluationText.includes('una reevaluación no es otra ejecución del flujo'));
    assert.ok(!evaluationText.includes('Aceptación: aceptada'), 'a fixture result was shown as accepted');
    assert.ok(!evaluationText.includes('Aceptación: rechazada'), 'an undeclared acceptance was invented');

    const rubricsPanel = () => page.locator('#rubrics').innerText();
    await page.waitForFunction(() => document.querySelector('#rubrics')?.textContent
      ?.includes('Rúbrica refinamiento-historias') ?? false, undefined, { timeout: 60000 });
    await page.locator('#rubrics details > summary').first().click();
    const rubricsText = await rubricsPanel();
    assert.ok(rubricsText.includes('Rúbrica refinamiento-historias'));
    assert.ok(rubricsText.includes('Versión 2026-10-31 · versión aprobada explícitamente identificada'));
    assert.ok(rubricsText.includes('Versión 2026-11-12 · borrador: no es una versión aprobada'));
    assert.ok(!rubricsText.includes('Versión 2026-11-12 · versión aprobada'),
      'a draft rubric version was presented as approved');
    await page.locator('#rubrics [data-version="2026-10-31"] details > summary').click();
    const contents = await page.locator('#rubrics [data-version="2026-10-31"] pre').allInnerTexts();
    assert.deepEqual(contents, ['Contenido sintético de la versión aprobada de la rúbrica.']);

    assert.equal(await page.locator('#evaluation button, #rubrics button').count(), 0,
      'the fixture views offered evaluation or editing actions');
    const sessionsBefore = (await instance.api(
      `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data.length;
    const admissionsBefore = await admittedCount(instance);
    const digestBefore = await hashCapture(instance.captureDirectory);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#history button').length >= 1,
      undefined, { timeout: 60000 });
    await page.locator(`#history button[data-id="${executionId}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#evaluation details').length >= 3,
      undefined, { timeout: 60000 });
    await page.waitForTimeout(3500);
    assert.equal(await admittedCount(instance), admissionsBefore,
      'opening the fixture evaluation views dispatched an evaluator admission');
    assert.equal((await instance.api(
      `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data.length,
    sessionsBefore, 'opening the fixture evaluation views dispatched an evaluator session');
    assert.equal(await hashCapture(instance.captureDirectory), digestBefore,
      'browsing the fixture evaluation views altered captured evidence');
  });
