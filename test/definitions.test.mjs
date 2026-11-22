import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eventually, fixture, records } from './support/instance.mjs';

test('una skill cargada conserva su activación pública sin contar disponibilidad como activación',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticDefinitions: true,
      config: { secrets: ['synthetic-definition-secret'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'SYNTHETIC_SKILL_LOAD' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const plugin = (await instance.plugins()).find(plugin => plugin.id === 'synthetic.definitions');
    assert.equal(plugin?.state.status, 'active', JSON.stringify(await instance.plugins()));
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.type === 'session.execution.succeeded') && all;
    }, 'synthetic skill work did not finish');
    const activation = evidence.find(row => row.type === 'session.tool.success' && row.skill);
    assert.equal(activation?.status, 'captured');
    assert.equal(activation.skill.id, 'transformed');
    assert.equal(activation.skill.origin, 'successful-skill-tool-result');
    assert.match(activation.skill.text, /Transformed observed body/);
    assert.equal(activation.sessionID, session.id);
    assert.equal(activation.executionID, null);
    assert.match(activation.messageID, /^msg_/);
    assert.equal(activation.skill.contextID, null);
    assert.equal(activation.skill.consumption, null);
    assert.ok(!evidence.some(row => row.skill?.id === 'unused'));
    assert.ok(!JSON.stringify(evidence).includes('synthetic-definition-secret'));
    const available = evidence.find(row => row.stage === 'availability');
    assert.ok(available?.value.some(skill => skill.id === 'unused'));
    assert.ok(available.value.every(skill => ['observed', 'unused', 'transformed', 'outside', 'opencode', 'report'].includes(skill.id)),
      'isolated instance discovered non-synthetic user skills');
    const runtime = evidence.find(row => row.stage === 'runtime-definition' && row.identity === 'transformed');
    const deployed = evidence.find(row => row.stage === 'deployed-file' && row.identity === 'transformed');
    assert.equal(runtime?.source, 'opencode.skill.list');
    assert.match(runtime.value.content, /^Transformed observed body/);
    assert.match(deployed?.value.content, /Deployed observed body/);
    assert.notEqual(runtime.sha256, deployed.sha256);
    assert.ok(runtime.observationTime >= activation.sourceTime);
    assert.ok(!JSON.stringify(evidence).includes('synthetic-definition-cookie-two'));
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)),
      instance.captureDirectory, session.id], { encoding: 'utf8' });
    const invalid = join(instance.root, 'invalid-capture');
    await mkdir(invalid);
    for (const row of [
      { ...deployed, observationVersion: 2 },
      { ...deployed, value: { ...deployed.value, content: 'Synthetic tampered definition' } },
      { ...activation, skill: { ...activation.skill, text: 'Synthetic tampered skill' } },
    ]) {
      await writeFile(join(invalid, 'invalid.jsonl'), JSON.stringify(row) + '\n');
      assert.throws(() => execFileSync(process.execPath,
        [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), invalid], { encoding: 'utf8', stdio: 'pipe' }),
      error => error.status === 1 && error.stdout === '' && error.stderr.includes('line 1'));
    }
  });

test('admisión y activaciones públicas conservan versiones aunque cambie la ruta desplegada',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { syntheticDefinitions: true,
      config: { secrets: ['synthetic-definition-secret'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    const prompt = (await instance.api(`/api/session/${session.id}/prompt`, {
      text: 'Synthetic attached skill', skills: [{ id: 'transformed' }], resume: false })).data;
    const admitted = await eventually(async () => (await records(instance.captureDirectory))
      .find(row => row.stage === 'admitted-skill'), 'attached skill admission was not captured');
    assert.equal(admitted.identity, 'transformed');
    assert.equal(admitted.messageID, prompt.id);
    assert.equal(admitted.eventID === null, false);
    assert.match(admitted.value.text, /Transformed observed body/);
    assert.ok(admitted.omissions.includes('admission-is-not-model-dispatch'));
    for (const revision of [1, 2]) {
      if (revision === 2) await writeFile(join(instance.projects[0], '.opencode/skills/observed/SKILL.md'),
        'Synthetic deployed revision two.\n');
      await instance.api(`/api/experimental/session/${session.id}/skill`, { id: 'transformed', resume: false });
      await eventually(async () => (await records(instance.captureDirectory))
        .filter(row => row.stage === 'deployed-file').length >= revision + 1, 'skill definition snapshot was not captured');
    }
    const evidence = await records(instance.captureDirectory);
    const activations = evidence.filter(row => row.type === 'session.skill.activated');
    assert.equal(activations.length, 2);
    assert.notEqual(activations[0].eventID, activations[1].eventID);
    for (const activation of activations) {
      assert.equal(activation.skill.origin, 'runtime-activation-event');
      assert.equal(activation.skill.id, 'transformed');
      assert.equal(activation.sessionID, session.id);
      assert.equal(activation.messageID, null);
      assert.equal(activation.executionID, null);
      assert.equal(activation.skill.contextID, null);
      assert.equal(activation.skill.consumption, null);
    }
    const files = evidence.filter(row => row.stage === 'deployed-file');
    assert.match(files[0].value.content, /Deployed observed body/);
    assert.equal(files.at(-1).value.content, 'Synthetic deployed revision two.\n');
    assert.equal(files[0].value.path, files.at(-1).value.path);
    assert.notEqual(files[0].sha256, files.at(-1).sha256);
    assert.ok(!evidence.some(row => row.stage === 'context-hook' || row.type.startsWith('session.execution.')),
      'resume:false admission was mistaken for model execution');
    assert.ok(!JSON.stringify(evidence).includes('synthetic-definition-secret'));
    const other = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${other.id}/prompt`, {
      text: 'Synthetic unrelated session', skills: [{ id: 'transformed' }], resume: false });
    await eventually(async () => (await records(instance.captureDirectory))
      .some(row => row.stage === 'deployed-file' && row.sessionID === other.id), 'other session snapshot was not captured');
    for (const mode of [[], ['--tree']]) {
      const inspected = execFileSync(process.execPath,
        [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), instance.captureDirectory, session.id, ...mode],
        { encoding: 'utf8' });
      assert.ok(!inspected.includes(other.id), 'session inspection included unrelated context observations');
    }
  });

test('definiciones transformadas, instrucciones y versiones identifican el punto observado, no el contexto final',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticDefinitions: true });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic context provenance' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.type === 'session.execution.succeeded') && all;
    }, 'synthetic context work did not finish');
    const ready = evidence.find(row => row.type === 'recorder.ready');
    assert.equal(ready.runtimeVersion, '2.1.2');
    assert.equal(ready.sdkVersion, '2.1.2');
    assert.equal(ready.recorderVersion, '0.1.0');
    assert.deepEqual(ready.versionSources, { runtime: 'ctx.app.version', sdk: 'resolved-package-manifest',
      recorder: 'recorder-package-manifest', hostSdk: null });
    const context = evidence.find(row => row.source === 'opencode.session.hook.context');
    assert.equal(context.value.kind, 'primary');
    assert.equal(context.value.finalContext, false);
    assert.match(JSON.stringify(context.value.system), /Synthetic project instructions/);
    assert.match(JSON.stringify(context.value.system), /Synthetic transformed agent instructions/);
    assert.ok(!JSON.stringify(context.value).includes('Synthetic later hook instructions'));
    assert.ok(context.omissions.includes('later-hooks-and-protocol-transforms-not-observed'));
    assert.ok(context.omissions.includes('request-execution-link-not-exposed'));
    const agent = evidence.find(row => row.source === 'opencode.agent.get');
    assert.equal(agent.requestObservationID, context.requestObservationID);
    assert.equal(agent.value.system, 'Synthetic transformed agent instructions.');
    const environment = evidence.find(row => row.stage === 'environment');
    const plugin = environment.value.plugins.find(plugin => plugin.id === 'synthetic.definitions');
    assert.deepEqual(plugin, { id: 'synthetic.definitions', source: 'local', version: null, status: 'active' });
    assert.equal(environment.value.configurationSources, null);
    assert.equal(environment.value.transformations, null);
    for (const row of evidence.filter(row => row.type === 'recorder.observation')) {
      assert.equal(row.sha256, createHash('sha256').update(JSON.stringify(row.value), 'utf8').digest('hex'));
      assert.equal(row.hashBasis, 'redacted-json-utf8');
      assert.equal(row.sessionID, session.id);
      assert.equal(row.executionID, null);
      assert.ok(row.observationTime > 0 && row.observedAt >= row.observationTime);
    }
    // The synthetic provider is independent of the recorder's earlier hook.
    const wire = await (await fetch(`${instance.simulationURL}/control/context-provenance`)).json();
    assert.ok(wire.laterHookRequests > 0, 'later public hook did not change the dispatched request');
    await instance.stop();
    for (const mode of [[], ['--tree']]) {
      const inspected = execFileSync(process.execPath,
        [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), instance.captureDirectory, session.id, ...mode],
        { encoding: 'utf8' }).trim().split('\n').map(JSON.parse);
      assert.deepEqual(inspected.filter(row => row.type === 'recorder.observation'),
        (await records(instance.captureDirectory)).filter(row => row.type === 'recorder.observation'));
    }
  });

test('los hooks separan peticiones primarias, generación transitoria, título y compactación',
  { timeout: 120000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticDefinitions: true });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic auxiliary requests' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    await instance.api(`/api/session/${session.id}/generate`, { prompt: 'Synthetic transient instructions' });
    await instance.api(`/api/session/${session.id}/compact`, {});
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return ['context', 'generate', 'title', 'compaction'].every(hook =>
        all.some(row => row.source === `opencode.session.hook.${hook}`)) && all;
    }, 'one public session request hook was not observed');
    const contexts = evidence.filter(row => row.stage === 'context-hook');
    assert.equal(new Set(contexts.map(row => row.requestObservationID)).size, contexts.length);
    for (const row of contexts) {
      assert.equal(row.value.finalContext, false);
      assert.equal(row.sessionID, session.id);
      assert.equal(row.value.kind, row.identity === 'context' ? 'primary' : row.identity);
      assert.equal(row.executionID, null);
    }
    const title = contexts.find(row => row.identity === 'title');
    assert.equal(title.value.agentID, null);
    assert.equal(title.value.tools, null);
    assert.ok(contexts.find(row => row.identity === 'generate').value.messages
      .some(message => message.text.some(text => text.includes('Synthetic transient instructions'))));
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)),
      instance.captureDirectory, session.id], { encoding: 'utf8' });
  });

test('una definición del registro no autoriza leer su archivo fuera del proyecto seleccionado',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { syntheticDefinitions: true });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic scope preparation', resume: false });
    await instance.api(`/api/experimental/session/${session.id}/skill`, { id: 'outside', resume: false });
    const evidence = await eventually(async () => {
      const all = await records(instance.captureDirectory);
      return all.some(row => row.stage === 'deployed-file' && row.identity === 'outside') && all;
    }, 'out-of-project definition limit was not captured');
    const file = evidence.find(row => row.stage === 'deployed-file' && row.identity === 'outside');
    assert.deepEqual(file.value, { path: null, content: null });
    assert.ok(file.omissions.includes('definition-file-outside-project-not-read'));
    assert.ok(evidence.some(row => row.skill?.id === 'outside'));
    assert.ok(!JSON.stringify(evidence).includes('synthetic-unrelated-file-content'));
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)),
      instance.captureDirectory, session.id], { encoding: 'utf8' });
  });

test('el contexto real con identidad excluida no se incluye al consultar otra sesión',
  { timeout: 90000 }, async t => {
    const instance = await fixture(t, { simulation: true, syntheticDefinitions: true, config: { secrets: ['ses_'] } });
    const session = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    assert.ok(session.id.startsWith('ses_'));
    await instance.api(`/api/session/${session.id}/prompt`, { text: 'Synthetic excluded session identity' });
    await instance.api(`/api/experimental/session/${session.id}/wait`, {});
    const context = await eventually(async () => (await records(instance.captureDirectory))
      .find(row => row.stage === 'context-hook'), 'context with excluded identity was not captured');
    assert.equal(context.sessionID, null);
    assert.ok(context.omissions.includes('unsafe-identifier'));
    await instance.stop();
    const script = fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url));
    const all = execFileSync(process.execPath, [script, instance.captureDirectory], { encoding: 'utf8' });
    assert.ok(all.includes('"stage":"context-hook"'), 'unscoped inspection lost excluded-identity evidence');
    for (const mode of [[], ['--tree']]) {
      const selected = execFileSync(process.execPath,
        [script, instance.captureDirectory, 'ses_synthetic_other', ...mode], { encoding: 'utf8' })
        .trim().split('\n').map(JSON.parse);
      assert.deepEqual(selected.map(row => row.type), ['recorder.ready']);
    }
  });
