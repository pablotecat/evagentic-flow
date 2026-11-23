import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eventually, fixture, records } from './support/instance.mjs';

const inspect = (instance, sessionID, mode) => execFileSync(process.execPath,
  [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), instance.captureDirectory,
    ...sessionID ? [sessionID] : [], ...mode ? [mode] : []], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).map(JSON.parse);

test('un adjunto autorizado conserva los bytes observados y sus versiones sin leer archivos ajenos',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { config: { secrets: ['synthetic-deliverable-secret'] } });
    const path = join(instance.projects[0], 'input.txt');
    await writeFile(path, 'Synthetic original input. synthetic-deliverable-secret\nCookie: a=synthetic-cookie-one; b=synthetic-cookie-two\nEnd.');
    await writeFile(join(instance.projects[0], 'unrelated.txt'), 'synthetic-unrelated-deliverable');
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    const prompt = (await instance.api(`/api/session/${session.id}/prompt`, {
      text: 'Synthetic attached input', files: [{ uri: pathToFileURL(path).href }], resume: false })).data;
    const first = await eventually(async () => (await records(instance.captureDirectory))
      .find(row => row.stage === 'deliverable'), 'runtime attachment was not captured');
    assert.equal(first.value.content, 'Synthetic original input. [REDACTED]\n[REDACTED]\nEnd.');
    assert.equal(first.value.acquisition, 'runtime-content');
    assert.equal(first.value.role, 'input');
    assert.equal(first.value.finality, null);
    assert.equal(first.value.path, 'input.txt');
    assert.equal(first.messageID, prompt.id);
    assert.equal(first.sessionID, session.id);
    assert.equal(first.projectID, session.projectID);
    assert.equal(first.executionID, null);
    assert.equal(first.value.callID, null);
    assert.equal(first.source, 'opencode.session.inbox.files');
    assert.ok(first.eventID);
    await writeFile(join(instance.projects[0], 'unrelated.txt'), 'synthetic-unrelated-deliverable-revision');
    await writeFile(path, 'Synthetic changed input.');
    await instance.api(`/api/session/${session.id}/prompt`, {
      text: 'Synthetic changed attachment', files: [{ uri: pathToFileURL(path).href }], resume: false });
    await eventually(async () => (await records(instance.captureDirectory))
      .filter(row => row.stage === 'deliverable').length === 2, 'second attachment version was not captured');
    await instance.stop();
    const selected = inspect(instance, session.id, '--deliverables');
    assert.equal(selected.length, 2);
    assert.deepEqual(selected[0], first);
    assert.equal(selected[1].value.content, 'Synthetic changed input.');
    assert.notEqual(selected[0].sha256, selected[1].sha256);
    const invalid = join(instance.root, 'invalid-capture');
    await mkdir(invalid);
    for (const [value, recompute] of [
      [{ ...first.value, content: 'Synthetic tampered content' }, false],
      [{ ...first.value, role: 'intermediate' }, true],
      [{ ...first.value, content: null }, true],
      [{ ...first.value, path: '../outside.txt' }, true],
    ]) {
      const row = { ...first, value, ...recompute ? {
        sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      } : {} };
      await writeFile(join(invalid, 'invalid.jsonl'), JSON.stringify(row) + '\n');
      assert.throws(() => execFileSync(process.execPath,
        [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), invalid], { encoding: 'utf8', stdio: 'pipe' }),
      error => error.status === 1 && error.stdout === '' && error.stderr.includes('line 1'));
    }
    const persisted = (await Promise.all((await readdir(instance.captureDirectory))
      .map(name => readFile(join(instance.captureDirectory, name), 'utf8')))).join('\n');
    for (const excluded of ['synthetic-deliverable-secret', 'synthetic-cookie-one', 'synthetic-cookie-two',
      'synthetic-unrelated-deliverable', 'unrelated.txt']) assert.ok(!persisted.includes(excluded), excluded);
  });

test('excluir un discriminador del entregable omite su proyección pero conserva las demás evidencias',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { config: { secrets: ['public-file-boundary'] } });
    await writeFile(join(instance.projects[0], 'input.txt'), 'Synthetic input.');
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic shape boundary', resume: false,
      files: [{ uri: pathToFileURL(join(instance.projects[0], 'input.txt')).href }] });
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.stage === 'deliverable'), 'redacted deliverable was not captured');
    const [row] = inspect(instance, session.id, '--deliverables');
    assert.equal(row.status, 'unrecognized');
    assert.equal(row.value, null);
    assert.equal(row.sha256, null);
    assert.ok(row.omissions.includes('redacted-observation-shape'));
    const evidence = inspect(instance, session.id);
    assert.ok(evidence.some(row => row.content?.text === 'Synthetic shape boundary'));
    assert.ok(!evidence.some(row => row.type === 'recorder.failed'));
  });

test('un contrato local con papel no textual no autoriza captura ni admite trabajo',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { config: {
      deliverableTools: [{ name: 'write', pathArgument: 'path', role: ['output'] }],
    } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await assert.rejects(instance.api(`/api/session/${session.id}/prompt`, {
      text: 'Synthetic invalid tool contract', resume: false }), /500:/);
    assert.ok(!(await records(instance.captureDirectory)).some(row => row.type === 'recorder.ready'));
  });

test('referencias inaccesibles, externas, no regulares, binarias o grandes no invalidan las demás evidencias',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticDeliverables: true });
    const directory = instance.projects[0];
    await mkdir(join(directory, 'directory'));
    await writeFile(join(directory, 'binary.bin'), Buffer.from([0, 255, 1, 2]));
    await writeFile(join(directory, 'large.txt'), 'synthetic-oversize-content'.repeat(60000));
    await writeFile(join(instance.projects[1], 'outside.txt'), 'synthetic-outside-deliverable');
    await symlink(instance.projects[1], join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const session = (await instance.api('/api/session', { location: { directory } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_DELIVERABLE_LIMITS' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    await eventually(async () => (await records(instance.captureDirectory))
      .filter(row => row.stage === 'deliverable').length === 5, 'reference limits were not captured');
    const rows = inspect(instance, session.id, '--deliverables');
    for (const [path, omission] of [
      ['missing.txt', 'deliverable-reference-unavailable'], ['directory', 'deliverable-not-regular'],
      ['binary.bin', 'deliverable-format-not-supported'], ['large.txt', 'deliverable-size-limit'],
      [join('escape', 'outside.txt'), 'deliverable-outside-project'],
    ]) {
      const row = rows.find(row => row.value.path === path);
      assert.ok(row, path);
      assert.equal(row.value.content, null);
      assert.equal(row.value.acquisition, 'not-acquired');
      assert.ok(row.omissions.includes(omission), JSON.stringify(row));
    }
    const outside = (await instance.api('/api/session', { location: { directory: instance.projects[1] } })).data;
    await instance.api(`/api/session/${outside.id}/prompt`, { text: 'Synthetic outside attachment',
      files: [{ uri: pathToFileURL(join(instance.projects[1], 'outside.txt')).href }], resume: false });
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic limit barrier', resume: false });
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.content?.text === 'Synthetic limit barrier'), 'limit barrier was not captured');
    const evidence = await records(instance.captureDirectory);
    assert.ok(!evidence.some(row => row.type === 'recorder.failed'));
    assert.ok(evidence.some(row => row.type === 'session.tool.success' && row.tool?.outcome === 'success'));
    for (const excluded of ['synthetic-outside-deliverable', 'synthetic-oversize-content', outside.id]) {
      assert.ok(!JSON.stringify(evidence).includes(excluded), excluded);
    }
    inspect(instance, session.id);
  });

test('escritura y lectura nativas con contrato local preservan el entregable y sus acciones sin inferir rutas',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, nativeWrite: true, config: {
      deliverableTools: [{ name: 'write', pathArgument: 'path', role: 'output' },
        { name: 'read', pathArgument: 'path', role: 'input' }],
    } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_NATIVE_DELIVERABLE' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const row = await eventually(async () => (await records(instance.captureDirectory))
      .find(row => row.source === 'opencode.tool.hook.execute.after'), 'native edit was not captured');
    assert.equal(row.value.path, 'native.txt');
    assert.equal(row.value.content, 'Synthetic native result.');
    assert.equal(row.value.acquisition, 'post-event-file-read');
    assert.equal(row.value.role, 'output');
    assert.equal(row.value.roleSource, 'configured-tool-contract');
    assert.equal(row.value.sourceTimeBasis, 'local-hook-clock');
    assert.equal(row.sessionID, session.id);
    assert.match(row.messageID, /^msg_/);
    assert.equal(row.value.callID, 'call_synthetic_write');
    assert.equal(row.executionID, null);
    assert.equal(row.eventID, null);
    assert.ok(inspect(instance, session.id, '--deliverables').some(row => row.source === 'opencode.tool.hook.execute.after'));
    await eventually(async () => (await records(instance.captureDirectory))
      .filter(row => row.stage === 'deliverable').length === 2, 'native read was not captured');
    const before = inspect(instance, session.id, '--deliverables');
    assert.deepEqual(before.map(row => row.value.role), ['output', 'input']);
    assert.equal(before[1].value.callID, 'call_synthetic_read');
    assert.equal(before[1].value.content, 'Synthetic native result.');
    await writeFile(join(instance.projects[0], 'native.txt'), 'Synthetic changed native result.');
    await instance.stop();
    assert.deepEqual(inspect(instance, session.id, '--deliverables'), before);
  });

test('adjuntos JSON filtran secretos escapados y claves sensibles; los formatos no admitidos quedan explícitos',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { config: { secrets: ['synthetic-escaped-secret'] } });
    const directory = instance.projects[0];
    await writeFile(join(directory, 'input.json'), String.raw`{"work":"Allowed \u0073ynthetic-escaped-secret","password":"synthetic-json-password"}`);
    await writeFile(join(directory, 'opaque.pdf'), '%PDF-1.4\n% synthetic-unsupported-deliverable\n'
      + '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
      + '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n'
      + 'trailer\n<< /Root 1 0 R >>\n%%EOF\n');
    const session = (await instance.api('/api/session', { location: { directory } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic structured input', resume: false,
      files: ['input.json', 'opaque.pdf'].map(path => ({ uri: pathToFileURL(join(directory, path)).href })) });
    await eventually(async () => (await records(instance.captureDirectory))
      .filter(row => row.stage === 'deliverable').length === 2, 'attachment formats were not captured');
    const rows = inspect(instance, session.id, '--deliverables');
    assert.equal(rows[0].value.content, '{"work":"Allowed [REDACTED]","password":"[REDACTED]"}');
    assert.ok(rows[0].omissions.includes('deliverable-json-normalized'));
    assert.equal(rows[1].value.content, null);
    assert.ok(rows[1].omissions.includes('deliverable-format-not-supported'));
    const persisted = JSON.stringify(await records(instance.captureDirectory));
    for (const secret of ['synthetic-escaped-secret', 'synthetic-json-password', 'synthetic-unsupported-deliverable']) {
      assert.ok(!persisted.includes(secret), secret);
    }
  });

test('el plugin produce y consulta una salida, preserva la lectura posterior y enlaza su acción pública',
  { timeout: 120000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticDeliverables: true,
      config: { secrets: ['synthetic-deliverable-secret'] } });
    await writeFile(join(instance.projects[0], 'unrelated.txt'), 'synthetic-unrelated-deliverable');
    const sessions = [];
    for (const mode of ['PRODUCE', 'CONSULT']) {
      const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
      sessions.push(session);
      await instance.api(`/api/session/${session.id}/prompt`, { text: `SYNTHETIC_DELIVERABLE_${mode}` });
      await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    }
    await eventually(async () => (await records(instance.captureDirectory))
      .filter(row => row.stage === 'deliverable').length === 2, 'tool deliverables were not captured');
    const before = sessions.flatMap(session => inspect(instance, session.id, '--deliverables'));
    assert.equal(before.length, 2);
    for (const row of before) {
      assert.equal(row.value.content, 'Synthetic produced result. [REDACTED]\n[REDACTED]');
      assert.equal(row.value.acquisition, 'post-event-file-read');
      assert.equal(row.value.role, 'output'); // Role at this tool boundary, not global finality or proof of production.
      assert.equal(row.value.finality, null);
      assert.equal(row.value.callID, 'call_synthetic_deliverable');
      assert.equal(row.value.path, 'result.txt');
      assert.ok(sessions.some(session => row.sessionID === session.id && row.projectID === session.projectID));
      assert.equal(row.executionID, null);
      assert.match(row.messageID, /^msg_/);
      const terminal = (await records(instance.captureDirectory)).find(event => event.eventID === row.eventID);
      assert.equal(terminal.type, 'session.tool.success');
      assert.equal(terminal.callID, row.value.callID);
      assert.ok(row.observationTime >= terminal.sourceTime);
      assert.ok(row.omissions.includes('file-read-is-not-runtime-version'));
    }
    await writeFile(join(instance.projects[0], 'result.txt'), 'Synthetic later unobserved revision.');
    await instance.stop();
    assert.deepEqual(sessions.flatMap(session => inspect(instance, session.id, '--deliverables')), before);
    const persisted = JSON.stringify(await records(instance.captureDirectory));
    for (const excluded of ['synthetic-deliverable-secret', 'synthetic-deliverable-token',
      'synthetic-unrelated-deliverable', 'Synthetic later unobserved revision.']) assert.ok(!persisted.includes(excluded), excluded);
    assert.ok(instance.simulationLog().split('\n').filter(Boolean).map(JSON.parse)
      .some(event => event.event === 'request' && event.statusCode === 200));
  });
