import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { eventually, fixture, records } from './support/instance.mjs';
import { launchWebapp } from './support/webapp.mjs';
import { startApp } from '../webapp/server.mjs';

const upload = async (page, text) => {
  await page.getByLabel('Encargo').fill(text);
  await page.getByRole('button', { name: 'Enviar' }).click();
};

const awaitStatus = (page, fragment, timeout = 180000) =>
  page.waitForFunction(value =>
    document.querySelector('#execution-status')?.textContent?.includes(value) ?? false,
    fragment, { timeout });

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
});
