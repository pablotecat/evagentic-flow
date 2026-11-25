import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { eventually, fixture, records } from './support/instance.mjs';
import { appFetch, launchWebapp } from './support/webapp.mjs';
import { startApp } from '../webapp/server.mjs';

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
