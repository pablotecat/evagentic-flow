import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eventually, fixture, records } from './support/instance.mjs';

const inspect = (instance, sessionID, mode) => execFileSync(process.execPath,
  [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), instance.captureDirectory, sessionID,
    ...mode ? [mode] : []], { encoding: 'utf8', stdio: 'pipe' })
  .trim().split('\n').filter(Boolean).map(JSON.parse);

test('los entregables JSON excluyen números conocidos en objetos, arrays y escalares sin destruir números seguros',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { config: { secrets: ['986120443'] } });
    const cases = [
      ['numeric.json', '{"code":986120443,"safe":42,"nested":[986120443,false,null]}',
        '{"code":"[REDACTED]","safe":42,"nested":["[REDACTED]",false,null]}'],
      ['scalar.json', '986120443', '"[REDACTED]"'],
      ['exponent.json', '9.86120443e8', '"[REDACTED]"'],
      ['partial.json', '-986120443.5', '"-[REDACTED].5"'],
      ['safe.json', '{"count":123,"ratio":-12.5,"large":1e21,"enabled":true}',
        '{"count":123,"ratio":-12.5,"large":1e+21,"enabled":true}'],
    ];
    for (const [path, content] of cases) await writeFile(join(instance.projects[0], path), content);
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    const prompt = (await instance.api(`/api/session/${session.id}/prompt`, {
      text: 'Synthetic numeric attachments', resume: false,
      files: cases.map(([path]) => ({ uri: pathToFileURL(join(instance.projects[0], path)).href })),
    })).data;
    const evidence = await eventually(async () => {
      const rows = (await records(instance.captureDirectory)).filter(row => row.stage === 'deliverable');
      return rows.length === cases.length && rows;
    }, 'numeric attachments were not captured');
    for (const [path, original, expected] of cases) {
      const row = evidence.find(row => row.value?.path === path);
      assert.equal(row?.value.content, expected, path);
      assert.doesNotThrow(() => JSON.parse(row.value.content));
      assert.equal(row.messageID, prompt.id);
      assert.ok(row.eventID);
      assert.equal(row.sessionID, session.id);
      assert.equal(row.value.acquisition, 'runtime-content');
      assert.equal(row.status, 'captured');
      assert.ok(row.omissions.includes('deliverable-json-normalized'));
      assert.deepEqual(row.redactions, path === 'safe.json' ? [] : ['configured-literal']);
      assert.equal(row.sha256, createHash('sha256').update(JSON.stringify(row.value)).digest('hex'));
      if (path !== 'safe.json') assert.notEqual(row.sha256,
        createHash('sha256').update(JSON.stringify({ ...row.value, content: original })).digest('hex'));
      assert.equal(await readFile(join(instance.projects[0], path), 'utf8'), original);
      await writeFile(join(instance.projects[0], path), 'Synthetic later revision.');
    }
    await instance.stop();
    assert.deepEqual(inspect(instance, session.id, '--deliverables'), evidence);
    inspect(instance, session.id);
    const persisted = (await Promise.all((await readdir(instance.captureDirectory))
      .map(name => readFile(join(instance.captureDirectory, name), 'utf8')))).join('\n');
    assert.ok(!persisted.includes('986120443'));
  });

test('los booleanos excluidos conservan JSON válido en adjuntos e interacciones y no cambian los valores originales',
  { timeout: 180000 }, async t => {
    for (const excluded of [true, false]) await t.test(String(excluded), { timeout: 90000 }, async t => {
      const instance = await fixture(t, { config: { secrets: ['986120443', String(excluded)] } });
      const originals = [String(excluded), JSON.stringify({ flag: excluded, safe: !excluded, code: 986120443 })];
      for (const [index, content] of originals.entries()) await writeFile(join(instance.projects[0], `boolean-${index}.json`), content);
      const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
      await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic boolean attachments', resume: false,
        files: originals.map((_, index) => ({ uri: pathToFileURL(join(instance.projects[0], `boolean-${index}.json`)).href })) });
      const form = (await instance.api(`/api/session/${session.id}/form`, { title: 'Synthetic scalar answers', fields: [
        { key: 'code', type: 'integer' }, { key: 'ratio', type: 'number' },
        { key: 'flag', type: 'boolean', required: excluded },
        { key: 'safe', type: 'boolean', required: !excluded }, { key: 'count', type: 'integer' },
      ] })).data;
      const answer = { code: 986120443, ratio: -986120443.5, flag: excluded, safe: !excluded, count: 42 };
      await instance.api(`/api/session/${session.id}/form/${form.id}/reply`, { answer });
      await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic scalar barrier', resume: false });
      const evidence = await eventually(async () => {
        const rows = await records(instance.captureDirectory);
        return rows.some(row => row.content?.text === 'Synthetic scalar barrier') && rows;
      }, 'boolean and form evidence was not captured');
      const attachments = evidence.filter(row => row.stage === 'deliverable');
      assert.equal(attachments.length, 2);
      assert.deepEqual(attachments.map(row => JSON.parse(row.value.content)),
        ['[REDACTED]', { flag: '[REDACTED]', safe: !excluded, code: '[REDACTED]' }]);
      for (const row of attachments) {
        assert.deepEqual(row.redactions, ['configured-literal']);
        assert.equal(row.sha256, createHash('sha256').update(JSON.stringify(row.value)).digest('hex'));
      }
      const request = evidence.find(row => row.type === 'form.created');
      const response = evidence.find(row => row.type === 'form.replied');
      assert.equal(request.interaction.request.fields.find(field => field.key === 'flag').required, '[REDACTED]');
      assert.equal(request.interaction.request.fields.find(field => field.key === 'safe').required, !excluded);
      assert.deepEqual(response.interaction.response,
        { code: '[REDACTED]', ratio: '-[REDACTED].5', flag: '[REDACTED]', safe: !excluded, count: 42 });
      assert.ok(response.redactions.includes('configured-literal'));
      assert.ok(!JSON.stringify(evidence).includes('986120443'));
      for (const [index, original] of originals.entries()) {
        assert.equal(await readFile(join(instance.projects[0], `boolean-${index}.json`), 'utf8'), original);
      }
      await instance.stop();
      assert.deepEqual(inspect(instance, session.id, '--deliverables'), attachments);
      assert.deepEqual(inspect(instance, session.id).find(row => row.eventID === response.eventID), response);
    });
  });

test('el filtrado común alcanza argumentos y resultados sin invalidar proyecciones tipadas ni atribuir consumo excluido',
  { timeout: 120000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticTools: true, modelCost: { input: 1, output: 2 },
      config: { secrets: ['986120443', 'true', 'false', '0.000025'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, {
      text: 'SYNTHETIC_ACTION_SUCCESS SYNTHETIC_SCALAR_VALUES SYNTHETIC_USAGE_A' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const rows = await records(instance.captureDirectory);
      return rows.some(row => row.type === 'session.execution.succeeded') && rows;
    }, 'synthetic scalar tool did not finish');
    const input = evidence.find(row => row.type === 'session.tool.called');
    const inputText = evidence.find(row => row.type === 'session.tool.input.ended');
    for (const payload of [input.tool.input.payload, JSON.parse(inputText.tool.inputText).payload]) {
      assert.equal(payload.code, '[REDACTED]');
      assert.equal(payload.enabled, '[REDACTED]');
      assert.equal(payload.disabled, '[REDACTED]');
      assert.equal(payload.safe, 42);
    }
    assert.ok(input.redactions.includes('configured-literal'));
    assert.ok(inputText.redactions.includes('configured-literal'));
    const output = evidence.find(row => row.type === 'session.tool.success');
    assert.equal(output.tool.outcome, 'success');
    assert.equal(output.tool.output[0].text, 'Synthetic result synthetic-secret-42 [REDACTED]\n[REDACTED]');
    const context = evidence.find(row => row.source === 'opencode.session.hook.context');
    assert.equal(context.status, 'unrecognized');
    assert.equal(context.value, null);
    assert.equal(context.sha256, null);
    assert.ok(context.omissions.includes('redacted-observation-shape'));
    assert.ok(context.redactions.includes('configured-literal'));
    const metric = evidence.find(row => row.type === 'session.step.ended' && row.measurement === null);
    assert.equal(metric.status, 'unrecognized');
    assert.ok(metric.redactions.includes('configured-literal'));
    assert.ok(metric.omissions.includes('unrecognized-measurement-format'));
    assert.ok(!JSON.stringify(evidence).includes('986120443'));
    assert.ok(!evidence.some(row => row.type === 'recorder.failed'));
    await instance.stop();
    inspect(instance, session.id);
    const [attempt] = inspect(instance, session.id, '--tools');
    assert.deepEqual(attempt.input, input.tool.input);
    assert.deepEqual(attempt.output, output.tool.output);
    const metrics = inspect(instance, session.id, '--metrics');
    const step = metrics.find(row => row.type === 'diagnostic.model-step'
      && row.evidence.some(ref => ref.captureID === metric.captureID && ref.arrival === metric.arrival));
    assert.equal(step.tokens.value, null);
    assert.ok(step.omissions.includes('unrecognized-measurement-format'));
    assert.ok(metrics.some(row => row.type === 'diagnostic.model-step' && row.tokens.value?.input === 0));
  });
