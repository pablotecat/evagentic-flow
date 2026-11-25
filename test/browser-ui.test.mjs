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

test('UI pura: una traza tardía no se pinta bajo otra selección', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(new URL('../webapp/public/index.html', import.meta.url).href);
  await page.addScriptTag({ content: await readFile(new URL('../webapp/public/app.js', import.meta.url), 'utf8') });
  const result = await page.evaluate(async () => {
    const pending = new Map();
    api = path => new Promise(resolve => pending.set(path, resolve));
    renderConversation = () => {};
    state.selected = 'exec-a';
    state.selectedSession = null;
    const late = refreshTrace();
    state.selected = 'exec-b';
    state.trace = null;
    const current = refreshTrace();
    pending.get('/api/executions/exec-b/trace')({ readable: true, selectedSessionID: 'b' });
    await current;
    pending.get('/api/executions/exec-a/trace')({ readable: true, selectedSessionID: 'a' });
    await late;
    const afterExecution = state.trace?.selectedSessionID;
    state.selectedSession = 'child';
    const stale = refreshTrace();
    state.selectedSession = 'other';
    state.trace = null;
    pending.get('/api/executions/exec-b/trace?session=child')({ readable: true, selectedSessionID: 'child' });
    await stale;
    return { afterExecution, afterSession: state.trace };
  });
  assert.equal(result.afterExecution, 'b');
  assert.equal(result.afterSession, null);
});

test('UI pura: los entregables distinguen adquisición, ausencia y finalidad desconocida', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(new URL('../webapp/public/index.html', import.meta.url).href);
  await page.addScriptTag({ content: await readFile(new URL('../webapp/public/app.js', import.meta.url), 'utf8') });
  const deliverable = (sessionID, value, extra = {}) => ({
    source: 'opencode.session.tool.content', identity: null, status: 'captured', value,
    sha256: 'a'.repeat(64), hashBasis: 'redacted-json-utf8', observationTime: 1500, sessionID,
    messageID: 'msg_synthetic', eventID: 'evt_synthetic', omissions: [], redactions: [],
    evidence: { captureID: 'cap-synthetic', arrival: 3, observedAt: 2000 }, ...extra });
  const group = (sessionID, deliverables, responses = []) => ({ sessionID,
    isRoot: sessionID === 'ses_root', entries: [], responses, deliverables });
  await page.evaluate(([first]) => {
    const execution = { id: 'synthetic-id-111111', sessionID: 'ses_root', status: 'interrupted', dispatch: 'admitted' };
    state.detail = { execution, interactions: { pending: [], resolved: [] },
      capture: { readable: true, captureIDs: [], recorderFailed: false, horizon: null,
        scope: { sessionIDs: ['ses_root', 'ses_child', 'ses_empty'] }, gaps: [], omissions: [] } };
    state.deliverables = first;
    renderExecution();
  }, [{
    readable: true, selectedSessionID: 'ses_root',
    query: { mode: 'known-sessions-explicit', sessions: ['ses_root', 'ses_child', 'ses_empty'] },
    sessions: [
      group('ses_root', [
        deliverable('ses_root', { path: 'input.txt', content: 'Contenido del propio evento.',
          acquisition: 'runtime-content', role: 'input', roleSource: 'public-file-boundary',
          sourceTimeBasis: 'runtime-event-created', finality: null, callID: null, sourceTime: 1000 },
          { source: 'opencode.session.inbox.files' }),
        deliverable('ses_root', { path: 'result.txt', content: null, acquisition: 'not-acquired',
          role: 'output', roleSource: 'public-file-boundary', sourceTimeBasis: 'runtime-event-created',
          finality: null, callID: 'call_a', sourceTime: 3000 },
          { omissions: ['deliverable-format-not-supported'] }),
      ], [{ text: 'Respuesta parcial autorizada.' }]),
      group('ses_child', [
        deliverable('ses_child', { path: 'child.txt', content: 'Contenido leído después.',
          acquisition: 'post-event-file-read', role: 'output', roleSource: 'public-file-boundary',
          sourceTimeBasis: 'runtime-event-created', finality: null, callID: 'call_b', sourceTime: 5000 },
          { omissions: ['file-read-is-not-runtime-version'] }),
        deliverable('ses_child', null, { status: 'unrecognized', sha256: null, value: undefined,
          omissions: ['redacted-observation-shape'] }),
      ]),
      group('ses_empty', []),
    ],
    scope: { kind: 'observed-session-tree', rootSessionID: 'ses_root',
      sessionIDs: ['ses_root', 'ses_child', 'ses_empty'] },
    horizon: null,
  }]);
  let panel = await page.locator('#deliverables').innerText();
  assert.ok(panel.includes('reúne explícitamente las sesiones conocida'));
  assert.ok(panel.includes('consultadas una a una'));
  assert.ok(panel.includes('una consulta de raíz no incluye descendientes'));
  assert.ok(panel.includes('contenido capturado del propio evento del runtime'));
  assert.ok(panel.includes('lectura posterior al evento o hook'));
  assert.ok(panel.includes('Contenido no adquirido'));
  assert.ok(panel.includes('Proyección no reconocida'));
  assert.ok(panel.includes('Sin entregables capturados para esta sesión'));
  assert.ok(panel.includes('SHA-256 (redacted-json-utf8)'));
  assert.ok(panel.includes('no acredita qué bytes produjo o utilizó la acción original'));
  assert.ok(panel.includes('La finalidad global no está acreditada'));
  assert.ok(panel.includes('no acredita que este contenido sea el resultado final del flujo'));
  assert.ok(panel.includes('Resultados parciales de una ejecución fallida o interrumpida'));
  assert.ok(panel.includes('no equivale a éxito ni a aceptación'));
  assert.ok(panel.includes('Respuesta parcial autorizada.'));
  assert.ok(panel.includes('ninguna observada en la captura'));
  for (let index = 0; index < await page.locator('#deliverables details > summary').count(); index++) {
    await page.locator('#deliverables details > summary').nth(index).click();
  }
  const contents = await page.locator('#deliverables pre').allInnerTexts();
  assert.deepEqual(contents, ['Contenido del propio evento.', 'Contenido leído después.']);

  await page.evaluate(() => {
    state.deliverables = { ...state.deliverables, query: { mode: 'selected-session',
      sessions: ['ses_root'] }, sessions: [state.deliverables.sessions[0]] };
    state.detail.execution.status = 'failed';
    renderExecution();
  });
  panel = await page.locator('#deliverables').innerText();
  assert.ok(panel.includes('Consulta de una sola sesión (ses_root)'));
  assert.ok(panel.includes('no incluye los entregables de sus descendientes'));
  assert.ok(panel.includes('Resultados parciales de una ejecución fallida o interrumpida'));
});
