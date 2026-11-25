import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eventually, fixture, records } from './support/instance.mjs';
import { appFetch, createExecution, executionDetail, launchExecution, launchWebapp, replyInteraction } from './support/webapp.mjs';
import { startApp } from '../webapp/server.mjs';

test('el cleanup cierra la app incluso si una aserción falla antes del cierre explícito', async () => {
  const temporary = process.env.OPENCODE_TEST_TMP ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir());
  const root = await mkdtemp(join(temporary, 'webapp-cleanup-'));
  const project = join(root, 'project');
  await mkdir(project);
  const script = `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { launchWebapp } from ${JSON.stringify(new URL('./support/webapp.mjs', import.meta.url).href)};
    test('synthetic early failure', async t => {
      await launchWebapp(t, { root: ${JSON.stringify(root)}, projects: [${JSON.stringify(project)}],
        captureDirectory: ${JSON.stringify(join(root, 'capture'))}, url: () => 'http://127.0.0.1:1' });
      assert.fail('synthetic assertion before explicit app.close');
    });
  `;
  const result = await new Promise(resolve => execFile(process.execPath,
    ['--input-type=module', '--eval', script], { timeout: 15000 },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  assert.equal(result.error?.killed, false, result.stderr);
  assert.equal(result.error?.code, 1, 'the failed assertion must remain a normal test failure, not a hung server');
  assert.match(result.stdout + result.stderr, /synthetic assertion before explicit app.close/);
  await assert.rejects(readFile(join(root, 'webapp-data', 'index-review-required')), { code: 'ENOENT' });
});

test('la app lanza una ejecución desde su API y conserva el resultado autorizado', { timeout: 300000 }, async t => {
  const instance = await fixture(t, { simulation: true, config: { secrets: ['synthetic-secret-42'] } });
  const { app, configPath } = await launchWebapp(t, instance);
  const first = await createExecution(app, 'corte-25-uno', 'Encargo sintético del corte. clave synthetic-secret-42.');
  assert.equal(first.status, 201);
  const executionId = first.body.execution.id;
  assert.ok(executionId);
  const completed = await eventually(async () => {
    const detail = await executionDetail(app, executionId);
    return detail.body.execution.status === 'succeeded' ? detail.body : undefined;
  }, 'launched execution did not reach a technical completion', 120000);
  assert.equal(completed.execution.dispatch, 'admitted');
  assert.notEqual(completed.execution.sessionID, executionId);
  assert.match(completed.execution.sessionID, /^ses_/);
  assert.match(completed.execution.promptMessageID, /^msg_/);
  assert.equal(completed.conversation.entries.length, 1);
  assert.equal(completed.conversation.entries[0].text, 'Encargo sintético del corte. clave [REDACTED].');
  assert.equal(completed.conversation.responses.length, 1);
  assert.equal(completed.conversation.responses[0].text, 'Respuesta autorizada. clave [REDACTED].');
  assert.ok(completed.capture.readable);
  assert.ok(completed.capture.captureIDs.length >= 1);
  assert.ok(completed.capture.captureIDs.every(captureID => captureID !== completed.execution.sessionID));
  const retried = await createExecution(app, 'corte-25-uno', 'Encargo sintético del corte. clave synthetic-secret-42.');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.execution.id, executionId);
  const admitted = (await records(instance.captureDirectory)).filter(row =>
    row.type === 'session.inbox.enqueued' && row.content?.role === 'user');
  assert.equal(admitted.length, 1, 'a repeated request key dispatched the assignment twice');

  const held = await createExecution(app, 'corte-25-held', 'SYNTHETIC_HELD_ADMISSION');
  assert.equal(held.status, 201);
  await eventually(async () => (await executionDetail(app, held.body.execution.id))
    .body.execution.sessionID !== null, 'held execution did not confirm its root session');
  const rejected = await createExecution(app, 'corte-25-otro', 'Encargo durante ocupación.');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error, 'project-busy');
  assert.equal(rejected.body.execution.id, held.body.execution.id);
  await writeFile(join(instance.root, 'admission-release'), 'release');
  await eventually(async () => (await executionDetail(app, held.body.execution.id))
    .body.execution.status === 'succeeded', 'held execution did not complete after release', 120000);
  const afterBusy = await createExecution(app, 'corte-25-final', 'Encargo tras liberar el proyecto.');
  assert.equal(afterBusy.status, 201);

  await app.close();
  const restarted = await startApp({ configPath });
  t.after(() => restarted.close());
  const listed = await appFetch(restarted, '/api/executions');
  assert.equal(listed.status, 200);
  const keys = listed.body.executions.map(execution => execution.requestKey);
  for (const key of ['corte-25-uno', 'corte-25-held', 'corte-25-final']) {
    assert.ok(keys.includes(key), `history lost ${key} after restart`);
  }
  const persisted = await executionDetail(restarted, executionId);
  assert.equal(persisted.body.execution.status, 'succeeded');
  assert.equal(persisted.body.conversation.entries[0].text, 'Encargo sintético del corte. clave [REDACTED].');
  assert.equal(persisted.body.conversation.responses[0].text, 'Respuesta autorizada. clave [REDACTED].');
  await instance.stop();
  const withoutEngine = await executionDetail(restarted, executionId);
  assert.equal(withoutEngine.body.execution.status, 'succeeded');
  assert.equal(withoutEngine.body.conversation.responses[0].text, 'Respuesta autorizada. clave [REDACTED].');
  const health = await appFetch(restarted, '/api/health');
  assert.equal(health.body.engine.reachable, false);
  assert.equal(health.body.capture.status, 'prepared');
});

test('un desenlace sin comprobar permanece pendiente y no reenvía el trabajo', { timeout: 300000 }, async t => {
  const instance = await fixture(t, { simulation: true, admissionGate: true });
  const { app, configPath } = await launchWebapp(t, instance);
  const held = await createExecution(app, 'perdido-uno', 'SYNTHETIC_HELD_ADMISSION');
  assert.equal(held.status, 201);
  let heldSession = null;
  await eventually(async () => {
    const detail = await executionDetail(app, held.body.execution.id);
    return detail.body.execution.sessionID !== null ? heldSession = detail.body.execution : undefined;
  }, 'held execution did not confirm its root session');
  const rejected = await createExecution(app, 'perdido-dos', 'Encargo durante ocupación.');
  assert.equal(rejected.status, 409);

  await app.close();
  const restarted = await startApp({ configPath });
  t.after(() => restarted.close());
  const retried = await createExecution(restarted, 'perdido-uno', 'SYNTHETIC_HELD_ADMISSION');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.execution.id, held.body.execution.id);
  assert.equal(retried.body.execution.sessionID, heldSession.sessionID);
  assert.equal(retried.body.execution.status, 'pending');
  assert.equal(retried.body.execution.dispatch, 'possibly-sent');
  assert.equal(retried.body.execution.dispatchedAt, null);
  const rejectedAfterRestart = await createExecution(restarted, 'perdido-dos', 'Encargo durante ocupación.');
  assert.equal(rejectedAfterRestart.status, 409);

  await writeFile(join(instance.root, 'admission-release'), 'release');
  await instance.api(`/api/experimental/session/${heldSession.sessionID}/wait`, {});
  await assert.rejects(eventually(async () => {
    const modelTraffic = instance.simulationLog().split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(event => event.event === 'request' && event.routeKey === 'model');
    return modelTraffic.length > 0 ? modelTraffic : undefined;
  }, 'no synthetic model traffic', 15000), /no synthetic model traffic/);
  const detail = await executionDetail(restarted, held.body.execution.id);
  assert.equal(detail.body.execution.status, 'pending');
  assert.equal(detail.body.execution.sessionID, heldSession.sessionID);
  const admitted = (await records(instance.captureDirectory)).filter(row =>
    row.type === 'session.inbox.enqueued' && row.content?.role === 'user');
  assert.equal(admitted.length, 0, 'a possibly lost dispatch left admitted work behind');
  const sessions = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(sessions.filter(session => (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 1,
    'the app created a second root session for a possibly lost dispatch');
  const stillBusy = await createExecution(restarted, 'perdido-tres', 'Encargo tras perder el despacho.');
  assert.equal(stillBusy.status, 409, 'an unchecked outcome released the project');

  await instance.stop();
  const withoutEngine = await executionDetail(restarted, held.body.execution.id);
  assert.equal(withoutEngine.body.execution.status, 'pending');
  assert.equal(withoutEngine.body.conversation.entries.length, 0);
});

test('la app rechaza peticiones ajenas y valida la creación', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'webapp-app-'));
  const projectDirectory = join(root, 'project');
  await mkdir(projectDirectory, { recursive: true });
  const socket = net.createServer(client => client.destroy());
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => socket.close(resolve)));
  const deadPort = socket.address().port;
  const configPath = join(root, 'webapp.local.json');
  await writeFile(configPath, JSON.stringify({ version: 1,
    opencodeURL: `http://127.0.0.1:${deadPort}`, opencodePassword: 'synthetic-opencode-password',
    projectDirectory, captureDirectory: join(root, 'captures'), dataDirectory: join(root, 'data') }));
  const app = await startApp({ configPath });
  t.after(() => app.close());

  const post = (headers, body = JSON.stringify({ requestKey: 'seg-uno', text: 'Encargo sintético.' })) =>
    new Promise(resolve => {
      const request = http.request(app.url, { method: 'POST', path: '/api/executions', headers: {
        'content-type': 'application/json', ...headers } }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
      });
      request.end(body);
    });

  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ host: 'evil.example' })).status, 403);
  assert.equal((await post({}, '{}')).status, 400);
  assert.equal((await appFetch(app, '/api/executions/unknown')).status, 404);

  const created = await post({});
  assert.equal(created.status, 201);
  await eventually(async () => (await executionDetail(app, created.body.execution.id))
    .body.execution.status === 'pending', 'unreachable engine did not leave a pending execution');
  const detail = await executionDetail(app, created.body.execution.id);
  assert.equal(detail.body.execution.dispatch, 'unconfirmed');
  assert.equal(detail.body.execution.sessionID, null);
  assert.equal(detail.body.capture.reason, 'session-not-confirmed');
  const retried = await createExecution(app, 'seg-uno', 'Encargo sintético.');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.execution.id, created.body.execution.id);
  const listed = await appFetch(app, '/api/executions');
  assert.equal(listed.body.executions.length, 1, 'an unreachable engine produced duplicate executions');
  const health = await appFetch(app, '/api/health');
  assert.equal(health.body.engine.reachable, false);
  assert.notEqual(health.body.capture.status, 'prepared');

  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Flujo en Proyecto'));
});

test('la misma clave sigue siendo idempotente al reconciliar el cierre anterior', { timeout: 180000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { app } = await launchWebapp(t, instance);
  const previous = await createExecution(app, 'race-previous', 'Encargo previo sintético.');
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.type === 'session.execution.succeeded'), 'previous assignment did not finish');
  const responses = await Promise.all(Array.from({ length: 8 }, () =>
    createExecution(app, 'race-same-key', 'Encargo repetido tras cierre.')));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 200).length, 7);
  const ids = new Set(responses.map(response => response.body.execution.id));
  assert.equal(ids.size, 1);
  assert.ok(!ids.has(previous.body.execution.id));
  const id = responses[0].body.execution.id;
  await eventually(async () => (await executionDetail(app, id)).body.execution.status === 'succeeded',
    'raced assignment did not finish');
  const admissions = (await records(instance.captureDirectory)).filter(row => row.type === 'session.inbox.enqueued');
  assert.equal(admissions.length, 2);
});

test('el cierre de la raíz no libera un árbol activo ni una pregunta pendiente', { timeout: 240000 }, async t => {
  const instance = await fixture(t, { simulation: true, admissionGate: true });
  const { app } = await launchWebapp(t, instance);
  const created = await createExecution(app, 'tree-root', 'SYNTHETIC_HELD_ADMISSION');
  const id = created.body.execution.id;
  const root = await eventually(async () => (await executionDetail(app, id)).body.execution.sessionID,
    'missing root session');
  await eventually(async () => readFile(join(instance.root, 'admission-entered'), 'utf8'), 'admission gate not entered');
  const child = (await instance.api('/api/session', { parentID: root,
    location: { directory: instance.projects[0] } })).data;
  await instance.api(`/api/session/${child.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING' });
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === child.id && row.type === 'session.text.delta'), 'child did not start');
  await writeFile(join(instance.root, 'admission-release'), 'release');
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === root && row.type === 'session.execution.succeeded'), 'root did not finish');
  assert.equal((await executionDetail(app, id)).body.execution.status, 'running');
  assert.equal((await createExecution(app, 'tree-other', 'No debe despacharse.')).status, 409);
  const form = (await instance.api(`/api/session/${root}/form`, {
    title: 'Synthetic pending question', fields: [{ key: 'answer', type: 'string' }] })).data;
  await instance.api(`/api/session/${child.id}/interrupt`, { resume: false });
  await instance.api(`/api/experimental/session/${child.id}/wait`, {});
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === child.id && row.type === 'session.execution.interrupted'), 'child did not stop');
  await eventually(async () => {
    const detail = (await executionDetail(app, id)).body;
    const rows = (await records(instance.captureDirectory)).filter(row => [root, child.id].includes(row.sessionID));
    const lastObserved = rows.reduce((latest, row) => Math.max(latest, row.observedAt), 0);
    assert.deepEqual(new Set(detail.capture.scope.sessionIDs), new Set([root, child.id]));
    assert.equal(detail.capture.scope.kind, 'observed-session-tree');
    assert.equal(detail.capture.scope.rootSessionID, root);
    assert.ok(detail.capture.omissions.some(row => row.sessionID === child.id));
    return detail.capture.horizon === new Date(lastObserved).toISOString();
  }, 'the public evidence horizon did not include the observed descendant');
  assert.equal((await executionDetail(app, id)).body.execution.status, 'running');
  assert.equal((await createExecution(app, 'tree-question', 'No debe despacharse.')).status, 409);
  await instance.api(`/api/session/${root}/form/${form.id}/reply`, { answer: { answer: 'Synthetic answer' } });
  await eventually(async () => (await executionDetail(app, id)).body.execution.status === 'succeeded',
    'resolved tree did not reach technical completion');
});

test('el cierre no oculta un permiso pendiente en un descendiente', { timeout: 240000 }, async t => {
  const instance = await fixture(t, { simulation: true, syntheticTools: true, admissionGate: true });
  const { app } = await launchWebapp(t, instance);
  const created = await createExecution(app, 'permission-root', 'SYNTHETIC_HELD_ADMISSION');
  const id = created.body.execution.id;
  const root = await eventually(async () => (await executionDetail(app, id)).body.execution.sessionID,
    'missing root session');
  const child = (await instance.api('/api/session', { parentID: root,
    location: { directory: instance.projects[0] },
    permissions: [{ action: 'synthetic.approval', resource: '*', effect: 'ask' }] })).data;
  await instance.api(`/api/session/${child.id}/prompt`, { text: 'SYNTHETIC_HUMAN' });
  const form = await eventually(async () => (await instance.api(`/api/session/${child.id}/form`)).data[0],
    'missing descendant question');
  await instance.api(`/api/session/${child.id}/form/${form.id}/reply`, {
    answer: { [form.fields[0].key]: 'Proceed synthetic-secret-42' } });
  const permission = await eventually(async () => (await instance.api(`/api/session/${child.id}/permission`)).data[0],
    'missing pending permission');
  await writeFile(join(instance.root, 'admission-release'), 'release');
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === root && row.type === 'session.execution.succeeded'), 'root did not finish');
  assert.equal((await executionDetail(app, id)).body.execution.status, 'running');
  assert.equal((await createExecution(app, 'permission-other', 'No debe despacharse.')).status, 409);
  await instance.api(`/api/session/${child.id}/permission/${permission.id}/reply`, { decision: 'once' });
  await eventually(async () => (await executionDetail(app, id)).body.execution.status === 'succeeded',
    'approved tree did not finish');
});

for (const failureTarget of ['index', 'directory']) test(`un fallo real de ${failureTarget} no publica cierre ni libera y exige revisión incluso tras reparar y reiniciar`,
  { timeout: 240000 }, async t => {
    const instance = await fixture(t, { simulation: true });
    const { app, configPath } = await launchWebapp(t, instance);
    const created = await createExecution(app, 'index-root', 'SYNTHETIC_LONG_RUNNING');
    const id = created.body.execution.id;
    await eventually(async () => (await executionDetail(app, id)).body.execution.dispatch === 'admitted',
      'admission not confirmed');
    const root = (await executionDetail(app, id)).body.execution.sessionID;
    const index = join(instance.root, 'webapp-data', 'executions.json');
    const target = failureTarget === 'index' ? index : join(instance.root, 'webapp-data');
    const preserved = `${target}.preserved`;
    await rename(target, preserved);
    if (failureTarget === 'index') await mkdir(target);
    else await writeFile(target, 'Synthetic lost data directory');
    await instance.api(`/api/session/${root}/interrupt`, { resume: false });
    await instance.api(`/api/experimental/session/${root}/wait`, {});
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.sessionID === root && row.type === 'session.execution.interrupted'), 'root did not stop');
    await eventually(async () => (await executionDetail(app, id)).status === 500,
      'failed index write was not reported');
    const failed = await executionDetail(app, id);
    assert.equal(failed.body.execution.status, 'running');
    assert.equal(failed.body.execution.finishedAt, null);
    assert.equal((await appFetch(app, '/api/health')).body.index.status, 'review-required');
    assert.equal((await createExecution(app, 'index-other', 'No debe despacharse.')).status, 503);
    if (failureTarget === 'index') await rmdir(target);
    else await unlink(target);
    await rename(preserved, target);
    assert.equal((await executionDetail(app, id)).body.execution.status, 'running');
    assert.equal((await createExecution(app, 'index-other', 'No debe despacharse.')).status, 503);
    await app.close();
    const restarted = await startApp({ configPath });
    t.after(() => restarted.close());
    assert.equal((await executionDetail(restarted, id)).body.execution.status, 'running');
    assert.equal((await createExecution(restarted, 'index-other', 'No debe despacharse.')).status, 503);
    const retry = await createExecution(restarted, 'index-root', 'SYNTHETIC_LONG_RUNNING');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.execution.id, id);
    const admitted = (await records(instance.captureDirectory)).filter(row => row.type === 'session.inbox.enqueued');
    assert.equal(admitted.length, 1);
  });

const selectionFixtureOptions = {
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
};

test('la app expone opciones de la instancia y lanza un encargo con agente, modelo y comando elegidos', { timeout: 300000 }, async t => {
  const instance = await fixture(t, selectionFixtureOptions);
  const { app, configPath } = await launchWebapp(t, instance);

  const options = await appFetch(app, '/api/options');
  assert.equal(options.status, 200);
  assert.equal(options.body.state, 'ready');
  assert.ok(options.body.agents.some(agent => agent.id === 'synthetic-choice'));
  assert.ok(options.body.agents.some(agent => agent.id === 'build'));
  assert.ok(options.body.models.some(model => model.value === 'synthetic/synthetic#low'));
  assert.ok(options.body.commands.some(command => command.name === 'synthetic-echo'));
  assert.ok(options.body.commands.some(command => command.name === 'review'));

  const request = { requestKey: 'corte-27-uno',
    agent: 'synthetic-choice', model: 'synthetic/synthetic#low',
    command: { name: 'synthetic-echo', arguments: 'argumento-alfa valor-beta synthetic-secret-42',
      extra: { secret: 'synthetic-extra-secret' } } };
  const created = await launchExecution(app, request);
  assert.equal(created.status, 201);
  const id = created.body.execution.id;
  assert.equal(created.body.execution.requestedAgent, 'synthetic-choice');
  assert.equal(created.body.execution.requestedModel, 'synthetic/synthetic#low');
  assert.equal(created.body.execution.requestedCommand.name, 'synthetic-echo');
  assert.deepEqual(created.body.execution.requestedCommand, { name: 'synthetic-echo' });

  const completed = await eventually(async () => {
    const detail = await executionDetail(app, id);
    return detail.body.execution.status === 'succeeded' ? detail.body : undefined;
  }, 'launched command execution did not reach a technical completion', 120000);
  assert.equal(completed.execution.dispatch, 'admitted');
  assert.equal(completed.execution.knownAgent, 'synthetic-choice');
  assert.equal(completed.execution.knownAgentSource, 'public-session');
  assert.equal(completed.execution.knownModel.value, 'synthetic/synthetic#low');
  assert.equal(completed.execution.knownModelSource, 'public-session');
  assert.ok(completed.execution.selectionObservedAt);
  assert.equal(completed.conversation.entries.length, 1);
  assert.equal(completed.conversation.entries[0].text, 'Encargo sintético de comando: argumento-alfa valor-beta [REDACTED]');
  assert.equal(completed.conversation.responses.length, 1);
  assert.match(completed.conversation.responses[0].text, /respuesta autorizada/i);

  const traffic = instance.simulationLog().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.event === 'request' && event.routeKey === 'model');
  assert.ok(traffic.length >= 1, 'no synthetic model traffic for the command execution');

  const retried = await launchExecution(app, request);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.execution.id, id);
  const admitted = (await records(instance.captureDirectory)).filter(row =>
    row.type === 'session.inbox.enqueued' && row.content?.text === 'Encargo sintético de comando: argumento-alfa valor-beta [REDACTED]');
  assert.equal(admitted.length, 1, 'a repeated request key dispatched the command twice');
  const sessions = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(sessions.filter(session => (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 1,
    'the idempotent retry created a second root session');

  const indexPath = join(instance.root, 'webapp-data', 'executions.json');
  const index = await readFile(indexPath, 'utf8');
  for (const exposed of [index, JSON.stringify(completed), JSON.stringify((await appFetch(app, '/api/executions')).body)]) {
    assert.ok(!exposed.includes('synthetic-secret-42'));
    assert.ok(!exposed.includes('synthetic-extra-secret'));
    assert.ok(!exposed.includes('"arguments"'));
  }

  await rm(join(instance.root, 'config/opencode/commands/synthetic-echo.md'));
  await eventually(async () => !(await appFetch(app, '/api/options')).body.commands
    .some(command => command.name === 'synthetic-echo'), 'deleted command still listed', 30000);
  const vanishedRetry = await launchExecution(app, request);
  assert.equal(vanishedRetry.status, 200);
  assert.equal(vanishedRetry.body.execution.id, id);
  await instance.stop();
  const offlineRetry = await launchExecution(app, request);
  assert.equal(offlineRetry.status, 200);
  assert.equal(offlineRetry.body.execution.id, id);

  await app.close();
  const legacy = JSON.parse(index);
  legacy.executions[0].requestedCommand = request.command;
  const legacyText = JSON.stringify(legacy);
  await writeFile(indexPath, legacyText);
  const restarted = await startApp({ configPath });
  t.after(() => restarted.close());
  const legacyDetail = await executionDetail(restarted, id);
  assert.deepEqual(legacyDetail.body.execution.requestedCommand, { name: 'synthetic-echo' });
  for (const body of [legacyDetail.body, (await appFetch(restarted, '/api/executions')).body,
    (await launchExecution(restarted, request)).body]) {
    assert.ok(!JSON.stringify(body).includes('synthetic-secret-42'));
    assert.ok(!JSON.stringify(body).includes('synthetic-extra-secret'));
  }
  assert.equal(await readFile(indexPath, 'utf8'), legacyText, 'loading history must not destroy legacy evidence');
  const captureBefore = JSON.stringify(await records(instance.captureDirectory));
  assert.equal((await createExecution(restarted, 'legacy-next-offline', 'Otro encargo sintético.')).status, 201);
  const rewritten = await readFile(indexPath, 'utf8');
  assert.ok(!rewritten.includes('synthetic-secret-42'));
  assert.ok(!rewritten.includes('synthetic-extra-secret'));
  assert.ok(!rewritten.includes('"arguments"'));
  assert.equal(JSON.stringify(await records(instance.captureDirectory)), captureBefore,
    'sanitizing the app index must not modify recorder evidence');
});

test('un error 404 ajeno al comando conserva el envío posible y la exclusión', { timeout: 180000 }, async t => {
  const instance = await fixture(t, { ...selectionFixtureOptions, removeCommandSession: true });
  const { app } = await launchWebapp(t, instance);
  const options = await appFetch(app, '/api/options');
  assert.ok(options.body.commands.some(command => command.name === 'synthetic-echo'));
  const request = { requestKey: 'ambiguous-command', command: {
    name: 'synthetic-echo', arguments: 'Encargo sin sesión disponible.' } };
  const created = await launchExecution(app, request);
  assert.equal(created.status, 201);
  const sessionID = await eventually(async () => readFile(join(instance.root, 'command-session-removed'), 'utf8'),
    'the real plugin did not remove the session');
  const response = await fetch(`${instance.url()}/api/session/${sessionID}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Basic ${Buffer.from('opencode:synthetic-instance-password').toString('base64')}` },
    body: JSON.stringify({ name: 'synthetic-echo', text: request.command.arguments }),
  });
  const error = await response.text();
  assert.equal(response.status, 404, error);
  assert.ok(!error.includes('CommandNotFoundError'), error);
  await eventually(async () => (await executionDetail(app, created.body.execution.id))
    .body.execution.dispatch === 'possibly-sent', 'command was not attempted');
  const detail = await executionDetail(app, created.body.execution.id);
  assert.equal(detail.body.execution.status, 'pending');
  assert.equal(detail.body.execution.finishedAt, null);
  assert.equal((await createExecution(app, 'ambiguous-other', 'No debe lanzarse.')).status, 409);
  const retry = await launchExecution(app, request);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.execution.id, created.body.execution.id);
  assert.equal(await readFile(join(instance.root, 'command-session-removed'), 'utf8'), sessionID,
    'an ambiguous response must not create another root session');
});

test('una opción elegida que no está expuesta se rechaza explícitamente sin despachar el encargo', { timeout: 300000 }, async t => {
  const instance = await fixture(t, selectionFixtureOptions);
  const { app } = await launchWebapp(t, instance);
  const before = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data.length;

  for (const selection of [
    { agent: 'missing-agent', body: { text: 'Encargo con agente incompatible.' } },
    { model: 'missing/model', body: { text: 'Encargo con modelo incompatible.' } },
    { commandName: 'missing-command', body: { command: { name: 'missing-command', arguments: 'x' } } },
  ]) {
    const rejected = await launchExecution(app, { requestKey: `corte-27-rechazo-${selection.agent ?? selection.model ?? selection.commandName}`,
      ...selection.body, ...(selection.agent ? { agent: selection.agent } : {}), ...(selection.model ? { model: selection.model } : {}) });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error, 'selection-unavailable');
  }

  assert.equal((await appFetch(app, '/api/executions')).body.executions.length, 0,
    'a rejected selection created an execution');
  const admitted = (await records(instance.captureDirectory)).filter(row =>
    row.type === 'session.inbox.enqueued' && row.content?.role === 'user');
  assert.equal(admitted.length, 0, 'a rejected selection dispatched work');
  const sessions = (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(sessions.length, before, 'a rejected selection created a session');

  await rm(join(instance.root, 'config/opencode/commands/synthetic-echo.md'));
  const gone = await eventually(async () => {
    const options = await appFetch(app, '/api/options');
    return options.body.commands.some(command => command.name === 'synthetic-echo') ? undefined : options.body.commands;
  }, 'the deleted synthetic command stayed listed', 30000);
  assert.ok(gone.some(command => command.name === 'review'));

  const vanished = await launchExecution(app, { requestKey: 'corte-27-desaparecido',
    command: { name: 'synthetic-echo', arguments: 'no debe despacharse' } });
  assert.equal(vanished.status, 422);
  assert.equal(vanished.body.error, 'selection-unavailable');
  assert.equal(vanished.body.kind, 'command');
  assert.equal((await appFetch(app, '/api/executions')).body.executions.length, 0,
    'a vanished command created an execution');

  const valid = await launchExecution(app, { requestKey: 'corte-27-valido',
    command: { name: 'review', arguments: 'encargo tras la opción desaparecida' } });
  assert.equal(valid.status, 201, 'a vanished option left the project locked');
  await eventually(async () => (await executionDetail(app, valid.body.execution.id))
    .body.execution.status === 'succeeded', 'execution after the vanished option did not complete', 120000);

  await instance.stop();
  const offline = await appFetch(app, '/api/options');
  assert.equal(offline.status, 200);
  assert.equal(offline.body.state, 'engine-unreachable');
  assert.equal(offline.body.agents, null);
});

const pendingInteraction = (app, id, filter) => eventually(async () => {
  const detail = (await executionDetail(app, id)).body;
  return detail.interactions?.pending?.find(filter) ?? undefined;
}, 'pending interaction was not surfaced');

const answerValue = field => {
  if (field.type === 'boolean') return true;
  if (field.type === 'number' || field.type === 'integer') return 1;
  const first = (field.options ?? [])[0];
  if (field.type === 'multiselect') return [first?.value ?? first?.label ?? 'Proceed'].filter(Boolean);
  return first?.value ?? first?.label ?? 'Continuar sintético';
};

test('la app responde preguntas y permisos nativos de la raíz y subejecuciones sin doble respuesta ni solicitudes ajenas',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true,
      config: { secrets: ['synthetic-secret-42'] } });
    const { app, configPath } = await launchWebapp(t, instance);
    const created = await createExecution(app, 'intervencion-raiz', 'SYNTHETIC_HUMAN');
    assert.equal(created.status, 201);
    const id = created.body.execution.id;
    const root = await eventually(async () => {
      const sessionID = (await executionDetail(app, id)).body.execution.sessionID;
      return sessionID ?? undefined;
    }, 'root session was not confirmed');
    const rootQuestion = await pendingInteraction(app, id,
      item => item.kind === 'form' && item.sessionID === root);
    assert.ok(rootQuestion.requestID);
    assert.ok(rootQuestion.request.fields.length >= 1);
    assert.equal(typeof rootQuestion.request.title, 'string');
    const rootField = rootQuestion.request.fields[0];
    let detail = (await executionDetail(app, id)).body;
    assert.equal(detail.execution.status, 'running', 'an execution waiting for intervention was not running');
    assert.equal(detail.execution.sessionID, root);
    const rootRequest = (await records(instance.captureDirectory))
      .find(row => row.type === 'form.created' && row.sessionID === root);
    assert.equal(rootRequest.interaction.requestID, rootQuestion.requestID);

    const child = (await instance.api('/api/session', { parentID: root,
      location: { directory: instance.projects[0] },
      permissions: [{ action: 'synthetic.approval', resource: '*', effect: 'ask' }] })).data;
    await instance.api(`/api/session/${child.id}/prompt`, { text: 'SYNTHETIC_HUMAN' });
    const childQuestion = await pendingInteraction(app, id,
      item => item.kind === 'form' && item.sessionID === child.id);
    assert.notEqual(childQuestion.sessionID, root);
    const childField = childQuestion.request.fields[0];

    const foreign = (await instance.api('/api/session',
      { location: { directory: instance.projects[0] } })).data;
    const foreignForm = (await instance.api(`/api/session/${foreign.id}/form`, {
      title: 'Pregunta ajena sintética', fields: [{ key: 'answer', type: 'string' }] })).data;
    detail = (await executionDetail(app, id)).body;
    assert.ok(!detail.interactions.pending.some(item => item.sessionID === foreign.id),
      'a foreign interaction leaked into the execution detail');
    const foreignReply = await replyInteraction(app, id, { kind: 'form', sessionID: foreign.id,
      requestID: foreignForm.id, answer: { answer: 'Respuesta ajena' } });
    assert.equal(foreignReply.status, 403);
    assert.equal(foreignReply.body.error, 'session-not-in-execution');
    const foreignPending = (await instance.api(`/api/session/${foreign.id}/form`)).data;
    assert.equal(foreignPending.length, 1, 'a foreign interaction was answered from the app');
    assert.ok(!(await records(instance.captureDirectory))
      .some(row => row.type === 'form.replied' && row.sessionID === foreign.id));

    const unauthorized = await replyInteraction(app, id, { kind: 'form', sessionID: root,
      requestID: rootQuestion.requestID, answer: { [rootField.key]: 'x', ajeno: 'y' } });
    assert.equal(unauthorized.status, 400);
    assert.equal(unauthorized.body.error, 'answer-fields-not-authorized');
    const missing = await replyInteraction(app, id, { kind: 'form', sessionID: root,
      requestID: 'frm_missing', answer: { [rootField.key]: 'x' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'unknown-interaction');

    const childAnswer = await replyInteraction(app, id, { kind: 'form', sessionID: child.id,
      requestID: childQuestion.requestID, answer: { [childField.key]: answerValue(childField) } });
    assert.equal(childAnswer.status, 200);
    assert.equal(childAnswer.body.interaction.phase, 'replied');
    const childPermission = await pendingInteraction(app, id,
      item => item.kind === 'permission' && item.sessionID === child.id);
    assert.equal(childPermission.request.action, 'synthetic.approval');
    assert.deepEqual(childPermission.request.resources, ['Synthetic resource [REDACTED]']);
    const badDecision = await replyInteraction(app, id, { kind: 'permission', sessionID: child.id,
      requestID: childPermission.requestID, decision: 'forever' });
    assert.equal(badDecision.status, 400);
    assert.equal(badDecision.body.error, 'invalid-request');
    const childDecision = await replyInteraction(app, id, { kind: 'permission', sessionID: child.id,
      requestID: childPermission.requestID, decision: 'once' });
    assert.equal(childDecision.status, 200);

    await app.close();
    const restarted = await startApp({ configPath });
    t.after(() => restarted.close());
    const rebuilt = await pendingInteraction(restarted, id,
      item => item.kind === 'form' && item.sessionID === root);
    assert.equal(rebuilt.requestID, rootQuestion.requestID, 'a reload did not rebuild pending interactions');

    const rootAnswer = await replyInteraction(restarted, id, { kind: 'form', sessionID: root,
      requestID: rootQuestion.requestID, answer: { [rootField.key]: answerValue(rootField) } });
    assert.equal(rootAnswer.status, 200);
    const duplicated = await replyInteraction(restarted, id, { kind: 'form', sessionID: root,
      requestID: rootQuestion.requestID, answer: { [rootField.key]: answerValue(rootField) } });
    assert.equal(duplicated.status, 409);
    assert.equal(duplicated.body.error, 'interaction-resolved');
    const rootReplies = await eventually(async () => {
      const replies = (await records(instance.captureDirectory)).filter(row =>
        row.type === 'form.replied' && row.sessionID === root
        && row.interaction.requestID === rootQuestion.requestID);
      return replies.length ? replies : undefined;
    }, 'the root reply was not captured');
    assert.equal(rootReplies.length, 1, 'the same interaction was replied twice');

    const maybeRootPermission = await eventually(async () => {
      const current = (await executionDetail(restarted, id)).body;
      if (current.execution.status === 'succeeded') return 'closed';
      return current.interactions.pending.find(
        item => item.kind === 'permission' && item.sessionID === root) ?? false;
    }, 'the root neither finished nor asked for intervention', 30000).catch(() => false);
    if (maybeRootPermission !== 'closed' && maybeRootPermission !== false) {
      const rootDecision = await replyInteraction(restarted, id, { kind: 'permission',
        sessionID: root, requestID: maybeRootPermission.requestID, decision: 'once' });
      assert.equal(rootDecision.status, 200);
    }

    await eventually(async () => (await executionDetail(restarted, id)).body.execution.status === 'succeeded',
      'the execution did not continue after answering its interactions', 240000);
    detail = (await executionDetail(restarted, id)).body;
    assert.equal(detail.interactions.pending.length, 0);
    const resolvedChild = detail.interactions.resolved.find(item =>
      item.kind === 'form' && item.requestID === childQuestion.requestID);
    assert.ok(resolvedChild);
    const expectedAnswer = { [childField.key]: answerValue(childField) };
    assert.deepEqual(resolvedChild.response,
      JSON.parse(JSON.stringify(expectedAnswer).replaceAll('synthetic-secret-42', '[REDACTED]')));
    assert.ok(detail.interactions.resolved.some(item => item.kind === 'permission'
      && item.sessionID === child.id && item.response.decision === 'once'));
    assert.equal(detail.execution.id, id);
    if (maybeRootPermission !== 'closed' && maybeRootPermission !== false) {
      assert.ok(detail.interactions.resolved.some(item => item.kind === 'permission'
        && item.sessionID === root && item.requestID === maybeRootPermission.requestID));
    }
    const admitted = (await records(instance.captureDirectory)).filter(row =>
      row.type === 'session.inbox.enqueued' && row.sessionID === root && row.content?.role === 'user');
    assert.equal(admitted.length, 1, 'answering an interaction dispatched the assignment again');
    const sessions = (await instance.api(
      `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
    assert.equal(sessions.filter(session =>
      (session.title ?? '').startsWith('Flujo en Proyecto ·')).length, 1,
      'answering an interaction created a second root session');
  });

test('responder con el motor caído falla de forma explícita sin conceder permisos ni relanzar',
  { timeout: 300000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true });
    const { app } = await launchWebapp(t, instance);
    const created = await createExecution(app, 'intervencion-sin-motor', 'SYNTHETIC_HUMAN');
    assert.equal(created.status, 201);
    const id = created.body.execution.id;
    const root = await eventually(async () => {
      const sessionID = (await executionDetail(app, id)).body.execution.sessionID;
      return sessionID ?? undefined;
    }, 'root session was not confirmed');
    const question = await pendingInteraction(app, id,
      item => item.kind === 'form' && item.sessionID === root);
    const field = question.request.fields[0];

    await instance.stop();
    const reply = await replyInteraction(app, id, { kind: 'form', sessionID: root,
      requestID: question.requestID, answer: { [field.key]: answerValue(field) } });
    assert.equal(reply.status, 503);
    assert.equal(reply.body.error, 'engine-unreachable');
    const evidence = await records(instance.captureDirectory);
    assert.ok(!evidence.some(row => row.type === 'form.replied' && row.sessionID === root),
      'an unreachable engine produced a reply');
    const detail = (await executionDetail(app, id)).body;
    assert.equal(detail.execution.status, 'running');
    assert.equal(detail.interactions.pending.length, 1, 'the visible wait was lost with the engine down');
    assert.deepEqual(detail.interactions.readErrors, [{ error: 'engine-unreachable' }]);
    assert.notEqual((await createExecution(app, 'intervencion-otro', 'No debe lanzarse.')).status, 201,
      'a failed reply released the project');
  });

const stopCall = (app, executionId) => appFetch(app, `/api/executions/${executionId}/stop`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});

test('la detención interrumpe el árbol delegado verificado sin tocar sesiones ajenas', { timeout: 300000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { app } = await launchWebapp(t, instance);
  const created = await createExecution(app, 'detencion-arbol', 'Encargo raíz largo. SYNTHETIC_LONG_RUNNING');
  assert.equal(created.status, 201);
  const id = created.body.execution.id;
  const root = await eventually(async () => (await executionDetail(app, id)).body.execution.sessionID,
    'root session was not confirmed');
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === root && row.type === 'session.text.delta'), 'root work did not start');
  const child = (await instance.api('/api/session', { parentID: root,
    location: { directory: instance.projects[0] } })).data;
  await instance.api(`/api/session/${child.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING Hijo delegado' });
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === child.id && row.type === 'session.text.delta'), 'child work did not start');
  const foreign = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
  await instance.api(`/api/session/${foreign.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING Sesión ajena al alcance' });
  const finished = (await instance.api('/api/session', { parentID: root,
    location: { directory: instance.projects[0] } })).data;
  await instance.api(`/api/session/${finished.id}/prompt`, { text: 'Hijo delegado que termina solo' });
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.sessionID === finished.id && row.type === 'session.execution.succeeded'),
    'the finished child did not complete before the stop');

  assert.equal((await stopCall(app, 'urn:not-an-execution')).status, 404);
  assert.equal((await stopCall(app, 'urn:not-an-execution')).body.error, 'unknown-execution');

  const stopped = await stopCall(app, id);
  assert.equal(stopped.status, 200);
  const entries = new Map(stopped.body.stop.sessions.map(entry => [entry.sessionID, entry]));
  assert.deepEqual(new Set(entries.keys()), new Set([root, child.id, finished.id]),
    'the stop scope did not match the verified execution tree');
  for (const entry of [entries.get(root), entries.get(child.id)]) {
    assert.ok(['accepted', 'not-running', 'already-interrupted'].includes(entry.result),
      `unexpected stop request result: ${entry.result}`);
    assert.equal(entry.stop, 'confirmed', `a stopped session remained unconfirmed: ${entry.sessionID}`);
  }
  assert.equal(entries.get(finished.id).result, 'not-running');
  assert.equal(entries.get(finished.id).stop, 'unconfirmed',
    'a session ended on its own was presented as stopped by the request');
  assert.equal(((await instance.api(`/api/session/${child.id}`)).data).outcome, 'interrupted');
  const foreignData = (await instance.api(`/api/session/${foreign.id}`)).data;
  assert.notEqual(foreignData.outcome, 'interrupted', 'the app interrupted a foreign session');
  assert.equal(foreignData.metadata?.evagenticRecorder, undefined);

  const detail = await eventually(async () => {
    const body = (await executionDetail(app, id)).body;
    const finishedEntry = (body.stop.sessions ?? []).find(session => session.sessionID === finished.id);
    return body.execution.status === 'interrupted'
      && (body.stop.sessions ?? []).every(session => session.sessionID === finished.id
        ? session.stop === 'unconfirmed' : session.stop === 'confirmed')
      && body.stop.sessions.length === 3 ? body : undefined;
  }, 'a stopped execution did not reach an observed, confirmed stop state', 120000);
  assert.equal(detail.execution.stop.requested, true);
  assert.ok(detail.execution.stop.requestedAt);
  assert.equal(detail.stop.requested, true);
  assert.equal(detail.conversation.entries.length, 1);
  assert.ok(detail.conversation.entries[0].text.includes('Encargo raíz largo.'));
  assert.ok(detail.execution.finishedAt, 'the interrupted execution lost its real terminal timestamp');
  assert.ok(detail.conversation.responses.length <= 1, 'an interrupted execution invented final responses');
  const indexPath = join(instance.root, 'webapp-data', 'executions.json');
  const indexText = await readFile(indexPath, 'utf8');
  assert.ok(indexText.includes('"stopRequested": true'), 'the stop request was not persisted as metadata');
  assert.ok(!indexText.includes('Encargo raíz largo.'), 'the index persisted stop content out of the capture');

  assert.equal((await stopCall(app, id)).status, 409);
  assert.equal((await stopCall(app, id)).body.error, 'execution-terminal');
  const next = await createExecution(app, 'detencion-despues', 'Encargo tras liberar la detención.');
  assert.equal(next.status, 201, 'a confirmed and reconciled stop did not release the project');
});

test('un fallo público del registrador sin fila de captura nunca libera el proyecto', { timeout: 300000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { app } = await launchWebapp(t, instance);
  const created = await createExecution(app, 'fallo-publico', 'Encargo corto antes del fallo público.');
  assert.equal(created.status, 201);
  const id = created.body.execution.id;
  const root = await eventually(async () => (await executionDetail(app, id)).body.execution.sessionID,
    'root session was not confirmed');
  await instance.api(`/api/session/${root}`, { metadata: { evagenticRecorder: {
    status: 'failed', reason: 'synthetic-public-failure', reviewRequired: true, pilotReady: false,
    notice: 'Revisar antes de volver a ejecutar.', interruption: { requested: true, result: 'accepted', stop: 'confirmed' } } } }, 'PATCH');
  await instance.api(`/api/experimental/session/${root}/wait`, {});
  const rows = await eventually(async () => {
    const all = await records(instance.captureDirectory);
    return all.some(row => row.sessionID === root && row.type === 'session.execution.succeeded') && all;
  }, 'the execution did not reach a terminal capture phase');
  assert.ok(!rows.some(row => row.type === 'recorder.failed'), 'the failure was recorded in the capture');
  for (let index = 0; index < 3; index++) {
    const body = (await executionDetail(app, id)).body;
    assert.equal(body.recorder.status, 'failed');
    assert.equal(body.recorder.reviewRequired, true);
    assert.ok(!['interrupted', 'succeeded', 'failed'].includes(body.execution.status),
      `a public recorder failure closed the execution as ${body.execution.status}`);
  }
  assert.notEqual((await createExecution(app, 'fallo-publico-otro', 'No debe lanzarse.')).status, 201,
    'a public recorder failure released the project');
});
test('la detención sin sesión confirmada no interrumpe nada y lo dice', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'webapp-stop-'));
  const projectDirectory = join(root, 'project');
  await mkdir(projectDirectory, { recursive: true });
  const socket = net.createServer(client => client.destroy());
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => socket.close(resolve)));
  const deadPort = socket.address().port;
  const configPath = join(root, 'webapp.local.json');
  await writeFile(configPath, JSON.stringify({ version: 1,
    opencodeURL: `http://127.0.0.1:${deadPort}`, opencodePassword: 'synthetic-opencode-password',
    projectDirectory, captureDirectory: join(root, 'captures'), dataDirectory: join(root, 'data') }));
  const app = await startApp({ configPath });
  t.after(() => app.close());
  const created = await createExecution(app, 'detencion-sin-sesion', 'Encargo sintético.');
  assert.equal(created.status, 201);
  await eventually(async () => (await executionDetail(app, created.body.execution.id))
    .body.execution.sessionID === null, 'the execution did not stay without a session');
  const stop = await stopCall(app, created.body.execution.id);
  assert.equal(stop.status, 409);
  assert.equal(stop.body.error, 'session-not-confirmed');
  const indexText = await readFile(join(root, 'data', 'executions.json'), 'utf8');
  assert.ok(!indexText.includes('stopRequested'), 'a rejected stop request persisted stop metadata');
  assert.equal((await createExecution(app, 'detencion-sin-sesion', 'Encargo repetido.')).status, 200);
  assert.equal((await createExecution(app, 'detencion-distinta', 'Encargo distinto.')).status, 409,
    'a stop without a confirmed session must not release the project');
});

const runReader = (instance, sessionID, mode) => execFileSync(process.execPath,
  [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), instance.captureDirectory, sessionID, mode],
  { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(JSON.parse);

const traceOf = (app, executionId, sessionID) => appFetch(app,
  `/api/executions/${executionId}/trace${sessionID ? `?session=${sessionID}` : ''}`);

const deliverablesOf = (app, executionId, sessionID) => appFetch(app,
  `/api/executions/${executionId}/deliverables${sessionID ? `?session=${sessionID}` : ''}`);

test('la traza expone árbol, intervalos y herramientas de la delegación anidada sin mezclar ejecuciones',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true, modelCost: { input: 1, output: 2 },
      config: { secrets: ['synthetic-secret-42'] },
      serverConfig: { experimental: { subagent_depth: 3 }, agents: { 'synthetic-branch': { mode: 'all',
        description: 'Synthetic branching agent',
        permissions: [{ action: 'subagent', resource: 'synthetic-branch', effect: 'allow' }] } } } });
    const { app } = await launchWebapp(t, instance);
    const created = await createExecution(app, 'traza-arbol', 'Encargo delegado anidado. SYNTHETIC_TREE_ROOT');
    assert.equal(created.status, 201);
    const executionId = created.body.execution.id;
    const completed = await eventually(async () => {
      const body = (await executionDetail(app, executionId)).body;
      return body.execution.sessionID && body.execution.status === 'succeeded' ? body : undefined;
    }, 'the delegated execution did not finish', 300000);
    const root = completed.execution.sessionID;

    const tree = await eventually(async () => {
      const body = (await traceOf(app, executionId)).body;
      return body?.readable === true && body.tree?.nodes?.length === 4 ? body : undefined;
    }, 'the trace did not expose the four delegated sessions', 120000);
    const readerRows = runReader(instance, root, '--tree');
    const readerSessions = [...new Set(readerRows.map(row => row.sessionID).filter(Boolean))];
    assert.deepEqual(new Set(tree.tree.sessionIDs), new Set(readerSessions),
      'the trace tree diverged from the independent reader');
    assert.deepEqual(new Set(tree.tree.sessionIDs), new Set(completed.capture.scope.sessionIDs));
    const nodes = new Map(tree.tree.nodes.map(node => [node.sessionID, node]));
    assert.equal(nodes.get(root).relation, 'view-root');
    assert.ok(!nodes.get(root).delegations.length, 'an external parent was turned into a delegation link');
    const children = [...nodes.values()].filter(node => node.observedParents.includes(root));
    assert.equal(children.length, 2, 'the root did not expose both concurrent branches');
    assert.ok(children.every(node => node.agentIDs.includes('synthetic-branch')));
    assert.ok(children.every(node => node.delegations.length === 1
      && node.delegations[0].parentSessionID === root), 'a child lacked its observed delegation call');
    assert.ok(new Set(children.map(node => node.delegations[0].callID))
      .has('call_synthetic_delegate_0'), 'the delegation call identity was lost');
    const grandchild = [...nodes.values()].find(node => !node.isViewRoot
      && node.observedParents.length === 1 && !node.observedParents.includes(root));
    assert.ok(grandchild, 'the nested grandchild was not represented');
    assert.equal(grandchild.relation, 'delegation-call-observed');
    assert.equal(grandchild.delegations[0].callID, 'call_synthetic_delegate_0');

    const intervals = tree.timeline.intervals;
    assert.deepEqual(new Set(intervals.map(interval => interval.sessionID)),
      new Set(tree.tree.sessionIDs), 'the sessions with intervals diverged from the tree');
    const siblings = intervals.filter(interval => children
      .some(child => child.sessionID === interval.sessionID));
    assert.equal(new Set(siblings.map(interval => interval.sessionID)).size, 2,
      'both concurrent branches must expose intervals');
    const firstRound = sessionID => siblings.filter(interval => interval.sessionID === sessionID)
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    const [firstSibling, secondSibling] = children.map(child => firstRound(child.sessionID));
    assert.ok(firstSibling.startedAt < secondSibling.endedAt
      && secondSibling.startedAt < firstSibling.endedAt,
      'sibling intervals did not overlap');
    assert.ok(intervals.every(interval => interval.durationSource === 'opencode.event.sourceTime'));
    assert.ok(intervals.every(interval => interval.evidence.length >= 2
      && interval.intervalRef?.captureID));

    const attempts = tree.tools.attempts;
    assert.equal(attempts.length, 2, 'the root tool attempts were not exposed');
    assert.ok(attempts.every(attempt => attempt.sessionID === root && attempt.outcome === 'success'));
    assert.deepEqual(new Set(attempts.map(attempt => attempt.callID)),
      new Set(['call_synthetic_delegate_0', 'call_synthetic_delegate_1']));
    assert.ok(attempts.every(attempt => attempt.consumption === null && attempt.retryOf === null
      && attempt.operationID === null));
    assert.ok(attempts.every(attempt => attempt.evidence.length >= 2
      && attempt.evidence.some(ref => ref.type === 'session.tool.input.started')));

    assert.deepEqual(new Set(tree.metrics.steps.map(step => step.sessionID)),
      new Set(tree.tree.sessionIDs), 'model steps did not cover the observed tree');
    assert.ok(tree.metrics.steps.length >= 4);
    assert.ok(tree.metrics.steps.every(step => step.executionID === null
      && step.tokens.providerReported === null
      && (step.tokens.basis === undefined || step.tokens.basis === 'runtime-normalized-unverified')));
    assert.ok(tree.metrics.steps.every(step => ['observed', 'unknown'].includes(step.tokens.status)
      && ['estimated', 'unknown'].includes(step.costUSD.status)));
    assert.equal(tree.metrics.coverage.flowElapsedMs, null);
    assert.ok(tree.metrics.coverage.omissions.includes('no-concurrent-duration-sum'));
    assert.equal(tree.captureDiagnostics.readiness, 'not-assessed');
    assert.deepEqual(new Set(tree.captureDiagnostics.sessions), new Set(tree.tree.sessionIDs));
    assert.ok(!JSON.stringify(tree).includes('synthetic-secret-42'), 'the trace leaked a secret');

    const branchSessionID = grandchild.observedParents[0];
    const scoped = await eventually(async () => {
      const body = (await traceOf(app, executionId, branchSessionID)).body;
      return body?.readable === true && body.selectedSessionID === branchSessionID
        && body.tree?.nodes?.length === 2 ? body : undefined;
    }, 'the sub-execution trace did not scope to its subtree', 120000);
    assert.deepEqual(new Set(scoped.tree.sessionIDs), new Set([branchSessionID, grandchild.sessionID]));
    assert.ok(scoped.timeline.intervals.every(interval =>
      [branchSessionID, grandchild.sessionID].includes(interval.sessionID)),
      'the scoped timeline mixed other executions or branches');
    assert.equal(scoped.tools.attempts.length, 1, 'the branch attempts were not exposed by session');
    assert.equal(scoped.tools.attempts[0].sessionID, branchSessionID);
    assert.equal(scoped.captureDiagnostics.sessions.length, 2);

    const foreign = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${foreign.id}/prompt`, { text: 'Sesión ajena a la ejecución.' });
    const rejected = await traceOf(app, executionId, foreign.id);
    assert.equal(rejected.status, 404);
    assert.equal(rejected.body.error, 'session-not-in-execution');
    assert.equal((await traceOf(app, 'urn:not-an-execution')).status, 404);

    const second = await createExecution(app, 'traza-segunda', 'Encargo corto tras el árbol.');
    assert.equal(second.status, 201, 'a finished execution did not release the project');
    const secondExecutionId = second.body.execution.id;
    const secondRoot = await eventually(async () => (await executionDetail(app, secondExecutionId))
      .body.execution.sessionID, 'the second execution did not confirm its session');
    const secondTrace = await eventually(async () => {
      const body = (await traceOf(app, secondExecutionId)).body;
      return body?.readable === true && body.tree?.nodes?.length === 1 ? body : undefined;
    }, 'the second execution did not expose its single-session tree', 120000);
    assert.ok(!secondTrace.tree.sessionIDs.includes(root),
      'the trace of the second execution mixed the first tree');
    assert.ok(!JSON.stringify(secondTrace.timeline.intervals).includes(root),
      'the timeline of the second execution mixed the first tree');
    const firstAgain = (await traceOf(app, executionId)).body;
    assert.ok(firstAgain.tree.sessionIDs.includes(root));
    assert.ok(!firstAgain.tree.sessionIDs.includes(secondRoot),
      'the trace of the first execution mixed a later execution');
  });

test('la traza mantiene desconocidas una llamada sin desenlace y una relación sin llamada observada',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true,
      config: { secrets: ['synthetic-secret-42'] } });
    const { app } = await launchWebapp(t, instance);
    const created = await createExecution(app, 'traza-desconocido', 'Encargo retenido. SYNTHETIC_ACTION_HOLD');
    assert.equal(created.status, 201);
    const executionId = created.body.execution.id;
    const root = await eventually(async () => (await executionDetail(app, executionId))
      .body.execution.sessionID, 'root session was not confirmed');

    const openCall = await eventually(async () => {
      const body = (await traceOf(app, executionId)).body;
      return body?.tools?.attempts?.find(attempt => attempt.callID === 'call_synthetic_action') ?? undefined;
    }, 'the open tool call did not surface in the trace', 120000);
    assert.equal(openCall.outcome, 'not-observed');
    assert.equal(openCall.sessionID, root);
    assert.ok(openCall.messageID);
    assert.equal(openCall.consumption, null);
    assert.equal(openCall.retryOf, null);
    assert.equal(openCall.operationID, null);
    assert.deepEqual(openCall.incident, { kind: 'outcome-not-observed', cause: null });
    assert.ok(openCall.evidence.some(ref => ref.type === 'session.tool.input.started'));
    assert.ok(openCall.evidence.some(ref => ref.type === 'session.tool.called'));
    const readerAttempt = runReader(instance, root, '--tools')
      .find(row => row.callID === 'call_synthetic_action');
    assert.equal(readerAttempt.outcome, 'not-observed');
    assert.equal(readerAttempt.startedAt, openCall.startedAt);
    assert.deepEqual(readerAttempt.evidence, openCall.evidence);

    const child = (await instance.api('/api/session', { parentID: root,
      location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${child.id}/prompt`, { text: 'Hijo observado sin llamada de delegación.' });
    const traced = await eventually(async () => {
      const body = (await traceOf(app, executionId)).body;
      return body?.tree?.nodes?.some(node => node.sessionID === child.id) ? body : undefined;
    }, 'the parent-observed child did not join the tree', 120000);
    const childNode = traced.tree.nodes.find(node => node.sessionID === child.id);
    assert.equal(childNode.relation, 'parent-observed-call-unknown');
    assert.deepEqual(childNode.observedParents, [root]);
    assert.equal(childNode.delegations.length, 0,
      'a creation call was invented for a child without an observed link');
    const rootNode = traced.tree.nodes.find(node => node.sessionID === root);
    assert.equal(rootNode.delegations.length, 0,
      'the open call without outcome was linked to a child session');
    const stillOpen = traced.tools.attempts.find(attempt => attempt.callID === 'call_synthetic_action');
    assert.ok(stillOpen);
    assert.equal(stillOpen.outcome, 'not-observed');
    assert.ok(!JSON.stringify(traced).includes('synthetic-secret-42'), 'the trace leaked a secret');

    const stopped = await stopCall(app, executionId);
    assert.equal(stopped.status, 200);
    await eventually(async () => (await executionDetail(app, executionId)).body.execution.status
      === 'interrupted', 'the stopped execution did not close', 180000);

    const recovered = await createExecution(app, 'traza-recuperado',
      'Encargo con fallo recuperado. SYNTHETIC_ACTION_RECOVERY');
    assert.equal(recovered.status, 201);
    const recoveredTrace = await eventually(async () => {
      const body = (await traceOf(app, recovered.body.execution.id)).body;
      return body?.tools?.attempts?.length === 2 ? body : undefined;
    }, 'the recovered attempts did not surface separately', 120000);
    assert.equal(new Set(recoveredTrace.tools.attempts.map(attempt => attempt.toolName)).size, 1,
      'attempts of the same tool were not expected');
    assert.equal(recoveredTrace.tools.attempts.filter(attempt => attempt.outcome === 'error').length, 1);
    assert.equal(recoveredTrace.tools.attempts.filter(attempt => attempt.outcome === 'success').length, 1);
    assert.ok(recoveredTrace.tools.attempts.every(attempt => attempt.retryOf === null
      && attempt.operationID === null && attempt.consumption === null),
      'retries were grouped by name or arguments instead of observed links');
    assert.equal(recoveredTrace.tools.attempts.filter(attempt => attempt.incident?.kind === 'tool-error').length, 1);
    assert.equal(recoveredTrace.tools.attempts[0].callID, 'call_synthetic_action_1');
    assert.equal(recoveredTrace.tools.attempts[1].callID, 'call_synthetic_action_2');
  });

test('los entregables consultan snapshots por sesión del árbol acreditado sin mezclar ejecuciones',
  { timeout: 480000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticDeliverables: true,
      config: { secrets: ['synthetic-deliverable-secret', 'synthetic-secret-42'] },
      serverConfig: { experimental: { subagent_depth: 3 }, agents: { 'synthetic-branch': { mode: 'all',
        description: 'Synthetic branching agent',
        permissions: [{ action: 'subagent', resource: 'synthetic-branch', effect: 'allow' }] } } } });
    const directory = instance.projects[0];
    await mkdir(join(directory, 'directory'));
    await writeFile(join(directory, 'binary.bin'), Buffer.from([0, 255, 1, 2]));
    await writeFile(join(instance.projects[1], 'outside.txt'), 'synthetic-outside-deliverable');
    await symlink(instance.projects[1], join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const { app } = await launchWebapp(t, instance);
    const created = await createExecution(app, 'entregables-arbol',
      'Encargo con entregables delegados. SYNTHETIC_DELIVERABLE_TREE');
    assert.equal(created.status, 201);
    const executionId = created.body.execution.id;
    const completed = await eventually(async () => {
      const body = (await executionDetail(app, executionId)).body;
      return body.execution.sessionID && body.execution.status === 'failed' ? body : undefined;
    }, 'the deliverable execution did not fail with partial results', 300000);
    const root = completed.execution.sessionID;
    assert.equal(completed.execution.dispatch, 'admitted');
    assert.equal(completed.capture.scope.sessionIDs.length, 4,
      'the synthetic deliverable tree did not expose root and three children');

    const overview = await eventually(async () => {
      const body = (await deliverablesOf(app, executionId)).body;
      return body?.readable === true && body.sessions?.length === 4 ? body : undefined;
    }, 'the deliverables overview did not gather the known sessions', 120000);
    assert.equal(overview.query.mode, 'known-sessions-explicit');
    assert.deepEqual(overview.query.sessions, completed.capture.scope.sessionIDs);
    const bySession = new Map(overview.sessions.map(group => [group.sessionID, group]));
    const readerDeliverables = sessionID => runReader(instance, sessionID, '--deliverables');
    for (const group of overview.sessions) {
      const reader = readerDeliverables(group.sessionID);
      assert.equal(group.deliverables.length, reader.length,
        `the webapp diverged from the independent reader for ${group.sessionID}`);
      for (const deliverable of group.deliverables) {
        const row = reader.find(reader => reader.sha256 === deliverable.sha256
          || (reader.value?.path === deliverable.value?.path && reader.observationTime === deliverable.observationTime));
        assert.ok(row, `a webapp deliverable of ${group.sessionID} was not backed by the reader`);
      }
    }
    const rootGroup = bySession.get(root);
    assert.equal(rootGroup.isRoot, true);
    assert.equal(rootGroup.deliverables.length, 1);
    const rootDeliverable = rootGroup.deliverables[0];
    assert.equal(rootDeliverable.source, 'opencode.session.tool.content');
    assert.equal(rootDeliverable.value.content, 'Synthetic produced result. [REDACTED]\n[REDACTED]');
    assert.equal(rootDeliverable.value.acquisition, 'post-event-file-read');
    assert.equal(rootDeliverable.value.role, 'output');
    assert.equal(rootDeliverable.value.finality, null);
    assert.equal(rootDeliverable.value.callID, 'call_synthetic_deliverable');
    assert.equal(rootDeliverable.value.path, 'result.txt');
    assert.match(rootDeliverable.sha256, /^[0-9a-f]{64}$/);
    assert.equal(rootDeliverable.hashBasis, 'redacted-json-utf8');
    assert.ok(rootDeliverable.evidence.captureID && rootDeliverable.evidence.arrival >= 1);
    assert.ok(rootDeliverable.omissions.includes('file-read-is-not-runtime-version'));
    assert.equal(rootGroup.responses.length, 0,
      'the failed root must expose an absent response, not a reconstructed one');
    const responded = overview.sessions.find(group => group.responses.length > 0);
    assert.ok(responded && responded.responses.some(item => item.text.includes('[REDACTED].')),
      'no session preserved an authorized filtered response');

    const produceSession = overview.sessions.find(group => group.sessionID !== root
      && group.deliverables.some(item => item.value?.content !== null && item.value?.content !== undefined
        && item.value.content.includes('Synthetic produced result')))?.sessionID;
    assert.ok(produceSession, 'no child session produced a deliverable snapshot');
    const emptySession = overview.sessions.find(group => !group.isRoot
      && group.deliverables.length === 0 && group.responses.length > 0)?.sessionID;
    assert.ok(emptySession, 'no child session with an explicit deliverable absence');
    const limitsGroup = overview.sessions.find(group => group.deliverables.some(item =>
      item.value?.acquisition === 'not-acquired')) ?? undefined;
    assert.ok(limitsGroup, 'no child session exposed not-acquired deliverable references');
    const escape = limitsGroup.deliverables.find(item => item.value?.path === join('escape', 'outside.txt'));
    assert.ok(escape && escape.value.content === null
      && escape.omissions.includes('deliverable-outside-project'), 'the escaping reference was captured or resolved');
    const missing = limitsGroup.deliverables.find(item => item.value?.path === 'missing.txt');
    assert.ok(missing && missing.value.acquisition === 'not-acquired'
      && missing.omissions.includes('deliverable-reference-unavailable'));
    const binary = limitsGroup.deliverables.find(item => item.value?.path === 'binary.bin');
    assert.ok(binary && binary.omissions.includes('deliverable-format-not-supported'));

    const rootOnly = await deliverablesOf(app, executionId, root);
    assert.equal(rootOnly.status, 200);
    assert.equal(rootOnly.body.query.mode, 'selected-session');
    assert.deepEqual(rootOnly.body.query.sessions, [root]);
    assert.equal(rootOnly.body.sessions.length, 1);
    assert.ok(!rootOnly.body.sessions.some(group => group.sessionID === produceSession),
      'a root deliverables query included a descendant');
    const childOnly = await deliverablesOf(app, executionId, limitsGroup.sessionID);
    assert.equal(childOnly.status, 200);
    assert.equal(childOnly.body.sessions.length, 1);
    assert.equal(childOnly.body.sessions[0].sessionID, limitsGroup.sessionID);

    const foreign = (await instance.api('/api/session', { location: { directory } })).data;
    await instance.api(`/api/session/${foreign.id}/prompt`, { text: 'Sesión ajena a la ejecución.' });
    const rejected = await deliverablesOf(app, executionId, foreign.id);
    assert.equal(rejected.status, 404);
    assert.equal(rejected.body.error, 'session-not-in-execution');
    assert.equal((await deliverablesOf(app, 'urn:not-an-execution')).status, 404);

    await writeFile(join(directory, 'result.txt'), 'Synthetic later unobserved revision.');
    const afterChange = await deliverablesOf(app, executionId, root);
    assert.equal(afterChange.body.sessions[0].deliverables[0].value.content,
      'Synthetic produced result. [REDACTED]\n[REDACTED]');
    assert.equal(afterChange.body.sessions[0].deliverables[0].sha256, rootDeliverable.sha256);
    await rm(join(directory, 'result.txt'));
    const afterDelete = await deliverablesOf(app, executionId, root);
    assert.equal(afterDelete.body.sessions[0].deliverables[0].value.content,
      'Synthetic produced result. [REDACTED]\n[REDACTED]');
    assert.equal(afterDelete.body.sessions[0].deliverables[0].sha256, rootDeliverable.sha256);

    const second = await createExecution(app, 'entregables-segunda', 'Encargo corto sin entregables.');
    assert.equal(second.status, 201, 'a failed execution did not release the project');
    const secondExecutionId = second.body.execution.id;
    const secondRoot = await eventually(async () => {
      const body = (await executionDetail(app, secondExecutionId)).body;
      return body.execution.sessionID && body.execution.status === 'succeeded'
        ? body.execution.sessionID : undefined;
    }, 'the second execution did not finish', 300000);
    const secondDeliverables = await eventually(async () => {
      const body = (await deliverablesOf(app, secondExecutionId)).body;
      return body?.readable === true && body.sessions?.length === 1 ? body : undefined;
    }, 'the second execution did not expose its single session', 120000);
    assert.equal(secondDeliverables.query.mode, 'known-sessions-explicit');
    assert.equal(secondDeliverables.sessions[0].deliverables.length, 0,
      'the second execution inherited deliverables from the first tree');
    assert.ok(secondDeliverables.sessions[0].responses.length, 'the second execution lost its response');
    assert.ok(!secondDeliverables.sessions.some(group => group.sessionID === root
      || group.sessionID === produceSession));
    const firstAgain = (await deliverablesOf(app, executionId)).body;
    assert.ok(!firstAgain.sessions.some(group => group.sessionID === secondRoot),
      'the first execution mixed a later execution session');

    const captureBefore = JSON.stringify(await records(instance.captureDirectory));
    await instance.stop();
    const offline = await deliverablesOf(app, executionId);
    assert.equal(offline.status, 200);
    assert.equal(offline.body.readable, true);
    assert.equal(offline.body.sessions.length, 4);
    assert.equal(offline.body.sessions.find(group => group.sessionID === root)
      .deliverables[0].value.content, 'Synthetic produced result. [REDACTED]\n[REDACTED]');
    const reported = JSON.stringify(overview) + JSON.stringify(afterDelete.body)
      + JSON.stringify(secondDeliverables);
    for (const excluded of ['synthetic-deliverable-secret', 'synthetic-deliverable-token',
      'synthetic-outside-deliverable', 'Synthetic later unobserved revision.']) {
      assert.ok(!reported.includes(excluded), excluded);
    }
    assert.equal(JSON.stringify(await records(instance.captureDirectory)), captureBefore,
      'consulting deliverables altered the recorder evidence');
    const indexPath = join(instance.root, 'webapp-data', 'executions.json');
    const storedIndex = await readFile(indexPath, 'utf8');
    for (const excluded of ['synthetic-deliverable-secret', 'synthetic-deliverable-token',
      'result.txt', 'Synthetic produced result.']) {
      assert.ok(!storedIndex.includes(excluded), `the app index persisted deliverable content: ${excluded}`);
    }
  });

test('un adjunto de entrada posterior conserva snapshot con finalidad nula sin alterar el estado y la consulta valida ?session=',
  { timeout: 300000 }, async t => {
    const instance = await fixture(t, { simulation: true, config: { secrets: ['synthetic-deliverable-secret'] } });
    const directory = instance.projects[0];
    const input = join(directory, 'input.txt');
    await writeFile(input, 'Synthetic attached input. synthetic-deliverable-secret');
    const { app } = await launchWebapp(t, instance);
    const created = await createExecution(app, 'entregables-exito', 'Encargo corto sin herramientas.');
    assert.equal(created.status, 201);
    const executionId = created.body.execution.id;
    const completed = await eventually(async () => {
      const body = (await executionDetail(app, executionId)).body;
      return body.execution.sessionID && body.execution.status === 'succeeded' ? body : undefined;
    }, 'the execution did not succeed', 240000);
    const root = completed.execution.sessionID;
    await instance.api(`/api/session/${root}/prompt`, {
      text: 'Synthetic attached input', files: [{ uri: pathToFileURL(input).href }], resume: false });
    const body = await eventually(async () => {
      const read = (await deliverablesOf(app, executionId)).body;
      return read?.readable && read.sessions?.[0]?.deliverables.length ? read : undefined;
    }, 'the attached snapshot was not exposed', 120000);
    assert.equal((await executionDetail(app, executionId)).body.execution.status, 'succeeded');
    const [snapshot] = body.sessions[0].deliverables;
    assert.equal(snapshot.value.role, 'input');
    assert.equal(snapshot.value.finality, null);
    assert.equal(snapshot.value.content, 'Synthetic attached input. [REDACTED]');
    assert.equal(body.sessions[0].readable, true);
    assert.ok(!JSON.stringify(body).includes('synthetic-deliverable-secret'));
    for (const query of ['?session=', '?session=--tree', `?session=${'x'.repeat(201)}`]) {
      const response = await appFetch(app, `/api/executions/${executionId}/deliverables${query}`);
      assert.equal(response.status, query === '?session=--tree' ? 404 : 400, query);
    }
    assert.equal((await appFetch(app, `/api/executions/${executionId}/trace?session=`)).status, 400);
  });

const syntheticRubricFixtureRows = () => ([
  { rubricID: 'refinamiento-historias', version: '2026-10-31', status: 'approved',
    title: 'Rúbrica sintética de refinamiento',
    criteria: [
      { id: 'cobertura', title: 'Cobertura del encargo', weight: 2, mandatory: false },
      { id: 'verificabilidad', title: 'Criterios de aceptación verificables', weight: 1, mandatory: false },
      { id: 'fidelidad', title: 'Fidelidad a las decisiones', weight: 1, mandatory: true },
    ],
    content: 'Contenido sintético de la versión aprobada de la rúbrica.',
    observedAt: 1764000000000 },
  { rubricID: 'refinamiento-historias', version: '2026-11-12', status: 'draft',
    title: 'Rúbrica sintética de refinamiento',
    criteria: [
      { id: 'cobertura', title: 'Cobertura del encargo', weight: 2, mandatory: false },
    ],
    content: 'Contenido sintético del borrador posterior.',
    observedAt: 1764300000000 },
  { rubricID: 'generacion-codigo', version: null,
    title: 'Rúbrica sintética sin versión identificada',
    criteria: [{ id: 'contratos', title: 'Preservación de contratos', weight: 1, mandatory: false }],
    content: null, observedAt: null },
]);

const syntheticEvaluationFixtureRows = executionID => ([
  { evaluationID: 'eval-sintetica-1', executionID, captureID: 'cap-sintetica',
    captureReference: 'captura sintética de la sesión raíz de la ejecución',
    reevaluationOf: null, evaluatedAt: 1764000001000,
    rubric: { rubricID: 'refinamiento-historias', version: '2026-10-31' },
    versions: { component: 'depurador-historias@1', case: 'caso-refinamiento@1',
      rubric: '2026-10-31', evaluator: 'juez-sintetico@1' },
    criteria: [
      { id: 'cobertura', status: 'evaluated', score: 0.9, weight: 2, mandatory: false,
        evidence: ['cap-sintetica · fila 3 (session.text.ended)'] },
      { id: 'verificabilidad', status: 'evaluated', score: 0.5, weight: 1, mandatory: false,
        evidence: ['cap-sintetica · fila 4 (session.text.ended)'] },
      { id: 'fidelidad', status: 'not-evaluable',
        reason: 'sin evidencia suficiente de la decisión aprobada', weight: 1, mandatory: true },
    ],
    score: { value: 0.77, basis: 'criterios-evaluados' },
    coverage: { evaluatedWeight: 3, applicableWeight: 4 },
    acceptance: 'pending' },
  { evaluationID: 'eval-sintetica-2', executionID, captureID: 'cap-sintetica',
    captureReference: 'captura sintética de la sesión raíz de la ejecución',
    reevaluationOf: 'eval-sintetica-1', evaluatedAt: 1764300001000,
    rubric: { rubricID: 'refinamiento-historias', version: '2026-11-12' },
    versions: { component: 'depurador-historias@1', case: 'caso-refinamiento@1',
      rubric: '2026-11-12', evaluator: null },
    criteria: [
      { id: 'cobertura', status: 'evaluated', score: 0.95, weight: 2, mandatory: false,
        evidence: ['cap-sintetica · fila 5 (session.text.ended)'] },
    ],
    score: { value: 0.95, basis: 'criterios-evaluados' },
    coverage: { evaluatedWeight: 1, applicableWeight: 1 },
    acceptance: null },
  { evaluationID: 'eval-sintetica-3', executionID, captureID: 'cap-sintetica',
    captureReference: 'captura sintética de la sesión raíz de la ejecución',
    reevaluationOf: 'eval-sintetica-1', evaluatedAt: 1764600001000,
    rubric: { rubricID: 'refinamiento-historias', version: '2026-12-01' },
    versions: { component: null, case: null, rubric: '2026-12-01', evaluator: null },
    criteria: [], score: null, coverage: null, acceptance: null },
]);

test('las vistas de rúbricas y evaluaciones muestran ausencia real sin fuente de datos', { timeout: 300000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const { app } = await launchWebapp(t, instance);
  const created = await createExecution(app, 'rLEN-ausencia', 'Encargo sintético del corte de evaluaciones.');
  assert.equal(created.status, 201);
  const executionId = created.body.execution.id;
  await eventually(async () => (await executionDetail(app, executionId))
    .body.execution.status === 'succeeded', 'execution did not succeed', 240000);
  const evaluations = await appFetch(app, `/api/executions/${executionId}/evaluations`);
  assert.equal(evaluations.status, 200);
  assert.equal(evaluations.body.source, 'none');
  assert.deepEqual(evaluations.body.evaluations, []);
  const rubrics = await appFetch(app, '/api/rubrics');
  assert.equal(rubrics.status, 200);
  assert.equal(rubrics.body.source, 'none');
  assert.deepEqual(rubrics.body.rubrics, []);
  assert.equal((await appFetch(app, '/api/executions/sin-existir/evaluations')).status, 404);
  const configPath = join(instance.root, 'webapp.local.json');
  await writeFile(join(instance.root, 'config-prohibida.json'), JSON.stringify({
    version: 1, opencodeURL: instance.url(), opencodePassword: 'synthetic-instance-password',
    projectDirectory: instance.projects[0], captureDirectory: instance.captureDirectory,
    dataDirectory: join(instance.root, 'webapp-data-prohibida'),
    evaluationFixtures: join(instance.root, 'cualquier-directorio'),
  }));
  await assert.rejects(startApp({ configPath: join(instance.root, 'config-prohibida.json') }),
    /unknown keys/);
});

test('las rúbricas y evaluaciones leen fixtures sintéticos de sólo lectura sin mezclar ejecuciones', { timeout: 300000 }, async t => {
  const instance = await fixture(t, { simulation: true });
  const fixturesDirectory = join(instance.root, 'evaluation-fixtures');
  const { app } = await launchWebapp(t, instance, { evaluationFixtures: fixturesDirectory });
  const created = await createExecution(app, 'rLEN-fixtures', 'Encargo sintético del corte de evaluaciones.');
  const executionId = created.body.execution.id;
  await eventually(async () => (await executionDetail(app, executionId))
    .body.execution.status === 'succeeded', 'execution did not succeed', 240000);
  const writeFixtures = async (rubrics, evaluations) => {
    await mkdir(fixturesDirectory, { recursive: true });
    await writeFile(join(fixturesDirectory, 'rubrics.jsonl'),
      rubrics.map(row => `${JSON.stringify(row)}\n`).join(''));
    await writeFile(join(fixturesDirectory, 'evaluations.jsonl'),
      evaluations.map(row => `${JSON.stringify(row)}\n`).join(''));
  };
  await writeFixtures(syntheticRubricFixtureRows(), syntheticEvaluationFixtureRows(executionId));

  const rubrics = (await appFetch(app, '/api/rubrics')).body;
  assert.equal(rubrics.source, 'synthetic-fixtures');
  assert.equal(rubrics.state, 'ready');
  const refinement = rubrics.rubrics.find(rubric => rubric.rubricID === 'refinamiento-historias');
  assert.ok(refinement);
  assert.deepEqual(refinement.versions.map(version => [version.version, version.status]),
    [['2026-10-31', 'approved'], ['2026-11-12', 'draft']]);
  assert.equal(refinement.versions[0].content, 'Contenido sintético de la versión aprobada de la rúbrica.');
  assert.deepEqual(refinement.versions[0].criteria.map(criterion => criterion.id),
    ['cobertura', 'verificabilidad', 'fidelidad']);
  const unidentified = rubrics.rubrics.find(rubric => rubric.rubricID === 'generacion-codigo');
  assert.equal(unidentified.versions[0].version, null);
  assert.equal(unidentified.versions[0].content, null);

  const evaluations = (await appFetch(app, `/api/executions/${executionId}/evaluations`)).body;
  assert.equal(evaluations.source, 'synthetic-fixtures');
  assert.equal(evaluations.state, 'ready');
  assert.deepEqual(evaluations.evaluations.map(evaluation => evaluation.evaluationID),
    ['eval-sintetica-1', 'eval-sintetica-2', 'eval-sintetica-3']);
  const [first, second, third] = evaluations.evaluations;
  assert.equal(first.rubric.rubricID, 'refinamiento-historias');
  assert.equal(first.rubric.version, '2026-10-31');
  assert.equal(first.rubric.status, 'approved');
  assert.equal(first.rubric.versionAvailable, true);
  assert.equal(first.versions.evaluator, 'juez-sintetico@1');
  assert.equal(first.acceptance, 'pending');
  assert.equal(first.score.value, 0.77);
  assert.equal(first.coverage.evaluatedWeight, 3);
  const notEvaluable = first.criteria.find(criterion => criterion.id === 'fidelidad');
  assert.equal(notEvaluable.status, 'not-evaluable');
  assert.equal(notEvaluable.reason, 'sin evidencia suficiente de la decisión aprobada');
  assert.equal(notEvaluable.score, null);
  const covered = first.criteria.find(criterion => criterion.id === 'cobertura');
  assert.equal(covered.score, 0.9);
  assert.deepEqual(covered.evidence, ['cap-sintetica · fila 3 (session.text.ended)']);
  assert.equal(second.reevaluationOf, 'eval-sintetica-1');
  assert.equal(second.rubric.status, 'draft');
  assert.equal(second.acceptance, null);
  assert.equal(second.versions.evaluator, null);
  assert.equal(third.rubric.version, '2026-12-01');
  assert.equal(third.rubric.status, null);
  assert.equal(third.rubric.versionAvailable, false);
  assert.equal(third.score, null);
  assert.equal(third.coverage, null);
  assert.equal(third.versions.component, null);

  const secondExecution = await createExecution(app, 'rLEN-otra', 'Encargo sintético de otra ejecución.');
  const isolated = (await appFetch(app, `/api/executions/${secondExecution.body.execution.id}/evaluations`)).body;
  assert.deepEqual(isolated.evaluations, []);

  await writeFile(join(fixturesDirectory, 'evaluations.jsonl'), '{"evaluationID": roto\n');
  const broken = (await appFetch(app, `/api/executions/${executionId}/evaluations`)).body;
  assert.equal(broken.state, 'read-error');
  assert.equal(broken.evaluations, null);
  assert.ok(broken.reason.includes('no válida') || broken.reason.includes('is not valid JSON') || broken.reason.length > 0);
  const stillReadable = (await appFetch(app, '/api/rubrics')).body;
  assert.equal(stillReadable.state, 'ready');
  await writeFile(join(fixturesDirectory, 'rubrics.jsonl'), '{"rubricID": roto\n');
  const brokenRubrics = (await appFetch(app, '/api/rubrics')).body;
  assert.equal(brokenRubrics.state, 'read-error');
  assert.equal(brokenRubrics.rubrics, null);
});