import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('UI pura: borradores aislados por tipo, sesión y solicitud y errores de lectura visibles', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(new URL('../webapp/public/index.html', import.meta.url).href);
  await page.addScriptTag({ content: await readFile(new URL('../webapp/public/app.js', import.meta.url), 'utf8') });
  await page.evaluate(() => {
    const execution = { sessionID: 'root' };
    const fields = [{ key: 'answer', type: 'string' }];
    window.sent = [];
    replyInteraction = payload => { window.sent.push(payload); };
    state.interactionAnswers[interactionKey({ kind: 'permission', sessionID: 'root', requestID: 'shared' })]
      = { answer: 'permission-only' };
    window.drawQuestions = () => conversationPanel.replaceChildren(
      ...['root', 'child'].map(sessionID => renderQuestion(execution,
        { kind: 'form', sessionID, requestID: 'shared', request: { fields } })),
      renderQuestion(execution,
        { kind: 'form', sessionID: 'root', requestID: 'other', request: { fields } }));
    window.drawQuestions();
  });
  const root = page.locator('[data-session="root"][data-request="shared"]');
  const child = page.locator('[data-session="child"][data-request="shared"]');
  const other = page.locator('[data-request="other"]');
  assert.equal(await root.locator('input').inputValue(), '', 'a permission draft leaked into a form');
  await root.locator('input').fill('root-only');
  await child.locator('input').fill('child-only');
  await other.locator('input').fill('other-only');
  await page.evaluate(() => window.drawQuestions());
  assert.equal(await root.locator('input').inputValue(), 'root-only');
  assert.equal(await child.locator('input').inputValue(), 'child-only');
  assert.equal(await other.locator('input').inputValue(), 'other-only');
  await child.getByRole('button').click();
  assert.deepEqual(await page.evaluate(() => window.sent), [
    { kind: 'form', sessionID: 'child', requestID: 'shared', answer: { answer: 'child-only' } },
  ]);
  await page.evaluate(() => {
    state.detail = { execution: { sessionID: 'root' }, interactions: {
      pending: [], resolved: [], readErrors: [{ sessionID: 'child', error: 'interaction-read-failed' }],
    } };
    conversationPanel.replaceChildren(...renderInteractions());
  });
  const error = await page.getByRole('alert').innerText();
  assert.ok(error.includes('No se pudieron leer las solicitudes pendientes de child'));
  assert.ok(error.includes('su vigencia no está comprobada'));
});

test('UI pura: la detención distingue solicitud, desenlace por sesión y fallo del registrador', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(new URL('../webapp/public/index.html', import.meta.url).href);
  await page.addScriptTag({ content: await readFile(new URL('../webapp/public/app.js', import.meta.url), 'utf8') });
  await page.evaluate(() => {
    const execution = { id: 'synthetic-id-111111', sessionID: 'ses_root', status: 'running', dispatch: 'admitted' };
    state.detail = {
      execution,
      stop: { requested: true, requestedAt: 1, readError: null, sessions: [
        { sessionID: 'ses_root', outcome: 'interrupted', stop: 'confirmed' },
        { sessionID: 'ses_child', outcome: 'succeeded', stop: 'unconfirmed' },
      ] },
      recorder: { readable: true, status: 'failed', reason: 'synthetic-reason',
        reviewRequired: true, pilotReady: false, source: 'public-session-metadata' },
      capture: { readable: true, recorderFailed: true, captureIDs: [], scope: { sessionIDs: [] },
        horizon: null, gaps: [], omissions: [] },
    };
    state.stopRequest = { requested: true, requestedAt: 1, sessions: [
      { sessionID: 'ses_root', result: 'accepted', stop: 'confirmed' },
      { sessionID: 'ses_child', result: 'not-running', stop: 'unconfirmed' },
    ] };
    state.health = { engine: { reachable: true } };
    renderExecution();
  });
  const stopPanel = await page.locator('#stop-requested').innerText();
  assert.ok(stopPanel.includes('Detención solicitada'));
  assert.ok(stopPanel.includes('Sesión raíz · Solicitud: aceptada · Detención: confirmada'));
  assert.ok(stopPanel.includes('Subejecución ses_child · Solicitud: sesión no activa · Detención: no confirmada'));
  assert.ok(stopPanel.includes('no hay interrupción instantánea'));
  await page.locator('#stop').waitFor();
  const recorder = await page.locator('#recorder-failure').innerText();
  assert.ok(recorder.includes('Fallo del registrador'));
  assert.ok(recorder.includes('fallo del registrador declarado en la captura'));
  assert.ok(recorder.includes('Motivo público declarado: synthetic-reason'));
  assert.ok(recorder.includes('no hay desbloqueo automático'));
});
