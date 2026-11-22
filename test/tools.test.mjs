import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, records } from './support/instance.mjs';

const inspect = (instance, sessionID, mode) => execFileSync(process.execPath,
  [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), instance.captureDirectory, sessionID,
    ...(mode ? [mode] : [])], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('Cookie y Set-Cookie completos se filtran en argumentos, salidas, errores e interacciones',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    const interactionText = 'Cookie: session=synthetic-interaction-first; auth=synthetic-interaction-second\n'
      + 'Set-Cookie: id=synthetic-interaction-set; Path=/synthetic-interaction-path; HttpOnly\nWork after cookies.';
    await instance.api(`/api/session/${session.id}/prompt`, {
      text: 'SYNTHETIC_ACTION_RECOVERY SYNTHETIC_COOKIE_HEADERS\n' + interactionText });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const form = (await instance.api(`/api/session/${session.id}/form`, { title: interactionText,
      fields: [{ key: 'answer', type: 'string' }] })).data;
    await instance.api(`/api/session/${session.id}/form/${form.id}/reply`, { answer: { answer: interactionText } });
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Barrera de cookies.', resume: false });
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.content?.text === 'Barrera de cookies.') && all;
    }, 'cookie evidence was not persisted');
    const filtered = '[REDACTED]\n[REDACTED]\nWork after cookies.';
    assert.equal(evidence.find(row => row.type === 'session.inbox.enqueued').content.text,
      'SYNTHETIC_ACTION_RECOVERY SYNTHETIC_COOKIE_HEADERS\n' + filtered);
    assert.equal(evidence.find(row => row.type === 'form.created').interaction.request.title, filtered);
    assert.equal(evidence.find(row => row.type === 'form.replied').interaction.response.answer, filtered);
    const filteredTool = '[REDACTED]\r\n[REDACTED]\r\n[REDACTED]\r\nWork after cookies.';
    assert.equal(evidence.find(row => row.type === 'session.tool.called').tool.input.payload.cookieText, filteredTool);
    assert.equal(JSON.parse(evidence.find(row => row.type === 'session.tool.input.ended').tool.inputText)
      .payload.cookieText, filteredTool);
    assert.ok(evidence.find(row => row.type === 'session.tool.failed').tool.error.message.endsWith(filteredTool));
    assert.ok(evidence.find(row => row.type === 'session.tool.success').tool.output[0].text.endsWith(filteredTool));
    assert.ok(evidence.find(row => row.type === 'session.text.ended').content.text.endsWith(filteredTool));
    await instance.stop();
    const persisted = (await Promise.all((await readdir(instance.captureDirectory))
      .map(name => readFile(join(instance.captureDirectory, name), 'utf8')))).join('\n');
    for (const secret of ['synthetic-first-cookie', 'synthetic-second-cookie', 'synthetic-set-cookie',
      'synthetic-next-cookie', 'synthetic-cookie-path', 'synthetic-fold-first', 'synthetic-fold-second',
      'synthetic-interaction-first', 'synthetic-interaction-second', 'synthetic-interaction-set', 'synthetic-interaction-path']) {
      assert.ok(!persisted.includes(secret), `cookie leaked: ${secret}`);
    }
    assert.ok(!evidence.some(row => row.type === 'recorder.failed'));
    assert.deepEqual(inspect(instance, session.id, '--tools').map(attempt => attempt.outcome), ['error', 'success']);
    inspect(instance, session.id);
  });

test('una herramienta efectiva conserva argumentos, resultado e identidad sin contar el catálogo como llamadas',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true,
      config: { secrets: ['synthetic-secret-42', 'synthetic-escaped-"credential"'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_ACTION_SUCCESS' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.type === 'session.tool.success') && all;
    }, 'synthetic action did not finish');
    const called = evidence.find(row => row.type === 'session.tool.called');
    const result = evidence.find(row => row.type === 'session.tool.success');
    assert.equal(called.toolName, 'synthetic_actions_inspect');
    assert.equal(called.callID, 'call_synthetic_action');
    assert.equal(called.sessionID, session.id);
    assert.equal(called.projectID, session.projectID);
    assert.equal(called.executionID, null);
    assert.match(called.messageID, /^msg_/);
    assert.deepEqual(called.tool.input, { mode: 'success', payload: {
      work: 'Authorized [REDACTED]', escaped: '[REDACTED]', nested: { password: '[REDACTED]', authorization: '[REDACTED]',
        headers: { 'X-Api-Key': '[REDACTED]' } } } });
    assert.equal(called.tool.outcome, 'not-observed');
    assert.equal(called.tool.executed, false); // Runtime flag, not proof that the local executor did not run.
    const completedInput = evidence.find(row => row.type === 'session.tool.input.ended');
    assert.ok(!completedInput.tool.inputText.includes('synthetic-escaped-'));
    assert.equal(result.toolName, called.toolName);
    assert.equal(result.messageID, called.messageID);
    assert.equal(result.tool.outcome, 'success');
    assert.deepEqual(result.tool.output, [{ type: 'text', text: 'Synthetic result [REDACTED] [REDACTED]' }]);
    assert.equal(result.tool.consumption, null);
    assert.equal(result.tool.retryOf, null);
    assert.ok(result.sourceTime >= called.sourceTime);
    const available = evidence.find(row => row.type === 'recorder.tools.available');
    assert.ok(available.toolNames.includes('unused'));
    assert.ok(available.toolNames.includes('synthetic_actions_inspect'));
    assert.ok(!evidence.some(row => row.callID && row.toolName === 'unused'));
    for (const secret of ['synthetic-secret-42', 'synthetic-input-password', 'synthetic-output-token',
      'synthetic-input-authorization', 'synthetic-x-api-key']) {
      assert.ok(!JSON.stringify(evidence).includes(secret), `secret leaked: ${secret}`);
    }
    const inspected = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)),
      instance.captureDirectory, session.id], { encoding: 'utf8' });
    assert.ok(inspected.includes('Synthetic result'));
  });

test('un reintento de proveedor conserva su número, mensaje y error sin convertirlo en intento de herramienta',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, config: { secrets: ['synthetic-secret-42'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_PROVIDER_RETRY' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.type === 'session.execution.succeeded') && all;
    }, 'provider retry did not recover');
    const retry = evidence.find(row => row.type === 'session.retry.scheduled');
    assert.equal(retry.retry.kind, 'model');
    assert.equal(retry.retry.attempt, 2);
    assert.ok(Number.isSafeInteger(retry.retry.at));
    assert.equal(retry.retry.error.status, 429);
    assert.ok(retry.retry.error.message.includes('Synthetic retry [REDACTED] [REDACTED]'));
    assert.match(retry.messageID, /^msg_/);
    assert.equal(retry.callID, null);
    assert.deepEqual(inspect(instance, session.id, '--tools'), []);
    const traffic = instance.simulationLog().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(traffic.some(event => event.event === 'request' && event.statusCode === 429));
    assert.ok(traffic.some(event => event.event === 'request' && event.statusCode === 200));
    assert.ok(!JSON.stringify(evidence).includes('synthetic-retry-token'));
    inspect(instance, session.id);
  });

test('formularios excluyen campos ocultos, formatos no admitidos y contenido de otro proyecto',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t);
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Admitir sin modelo.', resume: false });
    const form = (await instance.api(`/api/session/${session.id}/form`, { title: 'Synthetic safe form', fields: [
      { key: 'visible', type: 'string', title: 'Visible question' },
      { key: 'opaque', type: 'string', hidden: true, default: 'synthetic-hidden-secret' },
    ] })).data;
    await instance.api(`/api/session/${session.id}/form/${form.id}/reply`, {
      answer: { visible: 'Authorized answer', opaque: 'synthetic-hidden-secret' } });
    const unknown = (await instance.api(`/api/session/${session.id}/form`, { title: 'Unsupported form', fields: [
      { key: 'external', type: 'external', url: 'https://synthetic.invalid/synthetic-unsafe-format-secret' },
    ] })).data;
    await instance.api(`/api/session/${session.id}/form/${unknown.id}`, undefined, 'DELETE');
    const outside = (await instance.api('/api/session', { location: { directory: instance.projects[1] } })).data;
    const excluded = (await instance.api(`/api/session/${outside.id}/form`, { title: 'synthetic-excluded-form-secret',
      fields: [{ key: 'excluded', type: 'string' }] })).data;
    await instance.api(`/api/session/${outside.id}/form/${excluded.id}/reply`, { answer: { excluded: 'synthetic-excluded-answer-secret' } });
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Barrera de formularios.', resume: false });
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.content?.text === 'Barrera de formularios.') && all;
    }, 'form barrier was not captured');
    for (const secret of ['synthetic-hidden-secret', 'synthetic-unsafe-format-secret', 'synthetic-excluded-form-secret',
      'synthetic-excluded-answer-secret', outside.id, excluded.id]) assert.ok(!JSON.stringify(evidence).includes(secret), secret);
    const answer = evidence.find(row => row.type === 'form.replied');
    assert.deepEqual(answer.interaction.response, { visible: 'Authorized answer' });
    const unrecognized = evidence.find(row => row.type === 'form.created' && row.status === 'unrecognized');
    assert.equal(unrecognized.interaction, null);
    assert.deepEqual(unrecognized.omissions, ['unrecognized-interaction-format']);
    const cancellation = evidence.find(row => row.type === 'form.cancelled');
    assert.equal(cancellation.interaction.phase, 'cancelled');
    assert.equal(cancellation.interaction.origin, 'runtime-cancellation');
    assert.ok(!evidence.some(row => row.type === 'recorder.failed'));
    inspect(instance, session.id);
  });

test('el diagnóstico conserva sin duplicar las omisiones de una salida exclusivamente de archivo',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_ACTION_FILE' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.type === 'session.tool.success') && all;
    }, 'file-only tool result was not persisted');
    const result = evidence.find(row => row.type === 'session.tool.success');
    assert.equal(result.tool.outcome, 'success');
    assert.deepEqual(result.tool.output, []);
    assert.ok(result.omissions.includes('tool-file-content-not-captured'));
    assert.ok(!JSON.stringify(evidence).includes('synthetic-file-secret'));
    assert.ok(!JSON.stringify(evidence).includes('synthetic-file-name'));
    await instance.stop();
    const [attempt] = inspect(instance, session.id, '--tools');
    assert.equal(attempt.outcome, 'success');
    assert.equal(attempt.incident, null);
    assert.deepEqual(attempt.output, []);
    assert.deepEqual(attempt.omissions, [
      'tool-native-and-metadata-not-captured', 'tool-retry-relation-not-exposed', 'tool-consumption-not-exposed',
      'tool-input-text-normalized-json', 'tool-file-content-not-captured',
    ]);
  });

test('un intento sin desenlace observado queda como incidente desconocido, no como éxito ni consumo cero',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true,
      config: { secrets: ['synthetic-secret-42'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_ACTION_HOLD' });
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.type === 'session.tool.called'), 'held tool did not start');
    await instance.stop(); // Public process boundary: no private runtime or recorder collaborators.
    const [attempt] = inspect(instance, session.id, '--tools');
    assert.equal(attempt.outcome, 'not-observed');
    assert.deepEqual(attempt.incident, { kind: 'outcome-not-observed', cause: null });
    assert.equal(attempt.endedAt, null);
    assert.equal(attempt.error, null);
    assert.equal(attempt.output, null);
    assert.equal(attempt.consumption, null);
    assert.deepEqual(attempt.omissions, [
      'tool-native-and-metadata-not-captured', 'tool-retry-relation-not-exposed', 'tool-consumption-not-exposed',
      'tool-input-text-normalized-json',
    ]);
    assert.ok(attempt.horizons[0].arrival >= attempt.evidence.at(-1).arrival);
  });

test('un payload de profundidad no admitida conserva su omisión aunque otra fase aporte un desenlace',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_ACTION_UNKNOWN' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.type === 'session.tool.success') && all;
    }, 'unrecognized input evidence was not persisted');
    const called = evidence.find(row => row.type === 'session.tool.called');
    assert.equal(called.status, 'unrecognized');
    assert.equal(called.tool, null);
    assert.deepEqual(called.omissions, ['unrecognized-tool-format']);
    const input = evidence.find(row => row.type === 'session.tool.input.ended');
    assert.equal(input.tool, null);
    assert.deepEqual(input.omissions, ['unrecognized-tool-format']);
    assert.ok(!JSON.stringify(evidence).includes('synthetic-unknown-payload-secret'));
    const result = evidence.find(row => row.type === 'session.tool.success');
    assert.equal(result.tool.outcome, 'success');
    await instance.stop();
    const [attempt] = inspect(instance, session.id, '--tools');
    assert.equal(attempt.outcome, 'success');
    assert.equal(attempt.incident, null);
    assert.equal(attempt.endedAt, result.sourceTime);
    assert.equal(attempt.input, null);
    assert.equal(attempt.error, null);
    assert.equal(attempt.inputText, null);
    assert.deepEqual(attempt.output, [{ type: 'text', text: 'Synthetic result synthetic-secret-42 [REDACTED]' }]);
    assert.deepEqual(attempt.omissions, [
      'tool-native-and-metadata-not-captured', 'tool-retry-relation-not-exposed', 'tool-consumption-not-exposed',
      'unrecognized-tool-format',
    ]);
    assert.ok(attempt.evidence.some(row => row.eventID === result.eventID));
    assert.ok(!evidence.some(row => row.type === 'recorder.failed'));
  });

test('preguntas y aprobaciones conservan solicitudes y respuestas externas sin atribuirlas al agente',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true,
      config: { secrets: ['synthetic-secret-42'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] },
      permissions: [{ action: 'synthetic.approval', resource: '*', effect: 'ask' }] })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_HUMAN' });
    const form = await eventually(async () => (await instance.api(`/api/session/${session.id}/form`)).data[0],
      'native question did not create a form');
    const field = form.fields[0];
    await instance.api(`/api/session/${session.id}/form/${form.id}/reply`, {
      answer: { [field.key]: 'Proceed synthetic-secret-42' } });
    const permission = await eventually(async () => (await instance.api(`/api/session/${session.id}/permission`)).data[0],
      'controlled permission was not requested');
    await instance.api(`/api/session/${session.id}/permission/${permission.id}/reply`, { decision: 'once' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.type === 'permission.replied') && all;
    }, 'human interaction was not captured');
    const asked = evidence.find(row => row.type === 'form.created');
    const answered = evidence.find(row => row.type === 'form.replied');
    const approval = evidence.find(row => row.type === 'permission.asked');
    const decision = evidence.find(row => row.type === 'permission.replied');
    assert.equal(asked.interaction.requestID, form.id);
    assert.equal(asked.callID, 'call_synthetic_question');
    assert.equal(asked.messageID, form.metadata.tool.messageID);
    assert.equal(asked.interaction.relationSource, 'form-question-metadata');
    assert.equal(answered.callID, asked.callID);
    assert.equal(answered.interaction.relationSource, 'form-request-event');
    assert.ok(JSON.stringify(asked.interaction.request).includes('Choose [REDACTED]'));
    assert.deepEqual(answered.interaction.response, { [field.key]: 'Proceed [REDACTED]' });
    assert.equal(answered.interaction.origin, 'external-reply-unattributed');
    assert.equal(decision.interaction.origin, 'external-reply-unattributed');
    assert.deepEqual(decision.interaction.response, { decision: 'once' });
    assert.equal(decision.interaction.requestID, approval.interaction.requestID);
    assert.equal(decision.callID, permission.source.id);
    assert.equal(decision.messageID, permission.source.messageID);
    assert.ok(evidence.some(row => row.type === 'session.tool.called' && row.callID === decision.callID));
    for (const row of [asked, answered, approval, decision]) {
      assert.equal(row.sessionID, session.id);
      assert.equal(row.projectID, session.projectID);
      assert.equal(row.content, null);
      assert.equal(row.source, 'opencode.event');
    }
    assert.ok(!JSON.stringify(evidence).includes('synthetic-secret-42'));
    assert.ok(!JSON.stringify(evidence).includes('synthetic-permission-metadata-secret'));
    assert.equal(inspect(instance, session.id).filter(row => row.interaction).length, 4);
  });

test('un fallo seguido de recuperación conserva ambos intentos sin inventar una relación de reintento',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true,
      config: { secrets: ['synthetic-secret-42'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_ACTION_RECOVERY' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.type === 'session.execution.succeeded') && all;
    }, 'recovery did not complete');
    const failed = evidence.find(row => row.type === 'session.tool.failed');
    const recovered = evidence.find(row => row.type === 'session.tool.success');
    assert.equal(failed.tool.outcome, 'error');
    assert.equal(failed.tool.error.message, 'Synthetic failure [REDACTED] [REDACTED]');
    assert.equal(recovered.tool.outcome, 'success');
    assert.notEqual(failed.callID, recovered.callID);
    assert.notEqual(failed.messageID, recovered.messageID);
    assert.ok(!evidence.some(row => row.type === 'recorder.failed'));
    assert.ok(!JSON.stringify(evidence).includes('synthetic-error-token'));
    const attempts = inspect(instance, session.id, '--tools');
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map(attempt => attempt.outcome), ['error', 'success']);
    assert.equal(attempts[0].incident.kind, 'tool-error');
    assert.equal(attempts[0].incident.cause, null);
    assert.equal(attempts[1].incident, null);
    assert.ok(attempts.every(attempt => attempt.retryOf === null && attempt.operationID === null));
    assert.equal(attempts[0].input.mode, 'failure');
    assert.equal(attempts[1].input.mode, 'success');
    assert.ok(attempts.every(attempt => attempt.startedAt <= attempt.calledAt && attempt.calledAt <= attempt.endedAt));
  });
