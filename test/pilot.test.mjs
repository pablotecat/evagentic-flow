import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { OpenCode } from '@opencode/client';
import { eventually, fixture, records, repository } from './support/instance.mjs';

test('preparación integrada del paquete conserva personalizaciones y cambia de proyecto solo por configuración local',
  { timeout: 240000 }, async t => {
    const instance = await fixture(t, { loadRecorder: false, simulation: true, syntheticTools: true,
      syntheticDefinitions: true, nativeWrite: true, modelCost: { input: 1, output: 2 },
      config: { secrets: ['synthetic-secret-42', 'synthetic-definition-secret', 'synthetic-escaped-"credential"'],
        deliverableTools: [{ name: 'write', pathArgument: 'path', role: 'output' },
          { name: 'read', pathArgument: 'path', role: 'input' }] },
      serverConfig: { experimental: { subagent_depth: 3 }, agents: {
        'synthetic-branch': { mode: 'all', description: 'Synthetic preserved agent',
          permissions: [{ action: 'subagent', resource: 'synthetic-branch', effect: 'allow' }] },
      } } });
    t.diagnostic(`Isolated evidence: ${instance.root}`);
    assert.ok(instance.packageDirectory, 'installed package path must be inspectable');
    t.diagnostic(`Installed package: ${instance.packageDirectory}; npm pack shasum ${instance.packageManifest.shasum}`);
    assert.ok(!(await realpath(instance.packageDirectory)).startsWith(await realpath(repository)), 'workspace link is not an installation');
    assert.ok(instance.packageManifest.files.some(file => file.path === 'docs/pilot-verification.md'));
    assert.ok(instance.packageManifest.files.every(file => /^(?:dist\/index\.(?:js|d\.ts)|docs\/(?:capture-v1|pilot-verification)\.md|scripts\/inspect\.mjs|package\.json|README\.md)$/.test(file.path)),
      'unexpected or private file in package');
    const inspect = (directory, sessionID, mode) => execFileSync(process.execPath,
      [join(instance.packageDirectory, 'scripts/inspect.mjs'), directory, ...sessionID ? [sessionID] : [], ...mode ? [mode] : []],
      { encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').filter(Boolean).map(JSON.parse);
    const customizationPaths = [join(instance.root, 'config/opencode/opencode.json'),
      ...await readdir(join(instance.root, 'config/opencode/plugins')).then(names => names.map(name => join(instance.root, 'config/opencode/plugins', name))),
      ...instance.projects.flatMap(project => [join(project, 'AGENTS.md'),
        ...['observed', 'unused'].map(id => join(project, '.opencode/skills', id, 'SKILL.md'))])];
    const before = await Promise.all(customizationPaths.map(path => readFile(path, 'utf8')));
    const permissions = [{ action: 'synthetic.approval', resource: '*', effect: 'ask' }];
    const existing = (await instance.api('/api/session', { location: { directory: instance.projects[0] }, permissions })).data;
    await instance.api(`/api/session/${existing.id}/prompt`, { text: 'Synthetic existing customization', resume: false });
    assert.ok(!(await instance.plugins()).some(plugin => plugin.id === 'evagentic.recorder'));
    const originalAgent = (await instance.api(`/api/agent?location[directory]=${encodeURIComponent(instance.projects[0])}`)).data
      .find(agent => agent.id === 'synthetic-branch');
    assert.ok(originalAgent, 'preserved agent must exist before recorder activation');
    await writeFile(join(instance.root, 'config/opencode/plugins/recorder.ts'),
      `export { default } from ${JSON.stringify(pathToFileURL(join(instance.packageDirectory, 'dist/index.js')).href)};\n`, { flag: 'wx' });
    await instance.api('/api/location/reload', {});
    const stableConfig = JSON.parse(await readFile(instance.configFile, 'utf8'));
    const captures = [];
    for (const index of [0, 1]) {
      const captureDirectory = join(instance.root, `verified-${index}`);
      const local = { ...stableConfig, projectDirectory: instance.projects[index], captureDirectory };
      await writeFile(instance.configFile, JSON.stringify(local));
      for (const directory of instance.projects) await instance.api(
        `/api/location/reload?location[directory]=${encodeURIComponent(directory)}`, {});
      assert.equal((await instance.api('/api/info')).version, '2.1.2');
      const root = (await instance.api('/api/session', { location: { directory: instance.projects[index] },
        title: 'Flujo en Proyecto' })).data;
      const client = OpenCode.make({ baseUrl: instance.url(), headers: {
        authorization: `Basic ${Buffer.from('opencode:synthetic-instance-password').toString('base64')}` } });
      const events = client.event.subscribe()[Symbol.asyncIterator]();
      assert.equal((await events.next()).value.type, 'server.connected');
      await instance.api(`/api/session/${root.id}/prompt`, { text: 'SYNTHETIC_TREE_ROOT synthetic-secret-42' });
      await events.return();
      let evidence = await eventually(async () => {
        const all = await records(captureDirectory);
        return new Set(all.filter(row => row.type === 'session.execution.succeeded').map(row => row.sessionID)).size >= 4 && all;
      }, 'integrated delegation did not finish');
      const children = (await instance.api(`/api/session?directory=${encodeURIComponent(instance.projects[index])}`)).data
        .filter(session => session.parentID === root.id);
      assert.equal(children.length, 2);
      const starts = children.map(child => evidence.find(row => row.type === 'session.execution.started' && row.sessionID === child.id));
      const ends = children.map(child => evidence.find(row => row.type === 'session.execution.succeeded' && row.sessionID === child.id));
      assert.ok(starts.every(Boolean) && ends.every(Boolean));
      assert.ok(Math.max(...starts.map(row => row.sourceTime)) < Math.min(...ends.map(row => row.sourceTime)), 'delegated siblings must overlap');
      for (const scenario of ['SYNTHETIC_PROVIDER_RETRY SYNTHETIC_USAGE_A', 'SYNTHETIC_ACTION_RECOVERY',
        'SYNTHETIC_HUMAN', 'SYNTHETIC_SKILL_LOAD', 'SYNTHETIC_NATIVE_DELIVERABLE']) {
        const session = (await instance.api('/api/session', { parentID: root.id,
          location: { directory: instance.projects[index] }, permissions })).data;
        await instance.api(`/api/session/${session.id}/prompt`, { text: scenario });
        if (scenario === 'SYNTHETIC_HUMAN') {
          const form = await eventually(async () => (await instance.api(`/api/session/${session.id}/form`)).data[0], 'missing question');
          await instance.api(`/api/session/${session.id}/form/${form.id}/reply`, { answer: { [form.fields[0].key]: 'Proceed synthetic-secret-42' } });
          const permission = await eventually(async () => (await instance.api(`/api/session/${session.id}/permission`)).data[0], 'missing approval');
          await instance.api(`/api/session/${session.id}/permission/${permission.id}/reply`, { decision: 'once' });
        }
        await instance.api(`/api/experimental/session/${session.id}/wait`, {});
        await eventually(async () => (await records(captureDirectory)).some(row =>
          row.type === 'session.execution.succeeded' && row.sessionID === session.id), `scenario did not succeed: ${scenario}`);
      }
      const outside = (await instance.api('/api/session', { location: { directory: instance.projects[1 - index] } })).data;
      await instance.api(`/api/session/${outside.id}/prompt`, { text: 'SYNTHETIC_USAGE_B Synthetic excluded project' });
      await instance.api(`/api/experimental/session/${outside.id}/wait`, {});
      await instance.api(`/api/session/${root.id}/prompt`, { text: 'Synthetic integrated barrier', resume: false });
      await eventually(async () => (await records(captureDirectory)).some(row => row.content?.text === 'Synthetic integrated barrier'), 'missing capture barrier');
      evidence = inspect(captureDirectory, root.id, '--tree');
      const ready = evidence.find(row => row.type === 'recorder.ready');
      assert.deepEqual([ready.runtimeVersion, ready.sdkVersion, ready.recorderVersion], ['2.1.2', '2.1.2', '0.1.0']);
      assert.equal((await instance.plugins(instance.projects[index])).find(plugin => plugin.id === 'evagentic.recorder').state.status, 'active');
      assert.ok(evidence.some(row => row.tool?.outcome === 'error'));
      assert.ok(evidence.some(row => row.tool?.outcome === 'success' && row.childSessionID));
      const attempts = inspect(captureDirectory, undefined, '--tools');
      assert.ok(attempts.some(attempt => attempt.outcome === 'error'));
      assert.ok(attempts.some(attempt => attempt.outcome === 'success'));
      assert.ok(attempts.every(attempt => attempt.retryOf === null && attempt.operationID === null));
      assert.ok(evidence.some(row => row.retry?.kind === 'model' && row.retry.attempt === 2));
      for (const type of ['form.created', 'form.replied', 'permission.asked', 'permission.replied']) assert.ok(evidence.some(row => row.type === type), type);
      assert.ok(evidence.filter(row => row.interaction?.phase === 'replied').every(row => row.interaction.origin === 'external-reply-unattributed'));
      assert.ok(evidence.some(row => row.skill?.id === 'transformed'));
      assert.ok(evidence.some(row => row.stage === 'runtime-definition' && row.identity === 'transformed'));
      assert.ok(evidence.some(row => row.stage === 'deployed-file' && row.identity === 'transformed'));
      assert.ok(evidence.some(row => row.stage === 'context-hook' && row.value?.finalContext === false));
      assert.ok(inspect(captureDirectory, undefined, '--deliverables').some(row => row.value.content === 'Synthetic native result.'));
      const metrics = inspect(captureDirectory, root.id, '--metrics');
      assert.ok(metrics.some(row => row.type === 'diagnostic.model-step' && row.tokens.value?.input === 11));
      assert.ok(metrics.some(row => row.type === 'diagnostic.execution-interval' && row.outcome === 'succeeded'));
      const [coverage] = inspect(captureDirectory, root.id, '--coverage');
      assert.equal(coverage.readiness, 'not-assessed');
      assert.equal(coverage.declarations[0].coverage.replay, false);
      assert.ok(coverage.declarations[0].coverage.excluded.includes('final-wire-context'));
      assert.ok(coverage.observed.some(row => row.stage === 'deliverable' && row.status === 'captured'));
      assert.deepEqual(coverage.diagnostics, []);
      const serialized = JSON.stringify(await records(captureDirectory));
      for (const excluded of ['synthetic-secret-42', 'synthetic-definition-secret', 'synthetic-header-secret',
        'synthetic-escaped-"credential"', 'synthetic-input-password', 'synthetic-output-token', outside.id, outside.projectID]) {
        assert.ok(!serialized.includes(excluded), `capture leaked ${excluded}`);
      }
      assert.deepEqual((await instance.api(`/api/session/${existing.id}`)).data.permissions, permissions);
      assert.deepEqual((await instance.api(`/api/agent?location[directory]=${encodeURIComponent(instance.projects[0])}`)).data
        .find(agent => agent.id === 'synthetic-branch'), originalAgent);
      assert.deepEqual(await Promise.all(customizationPaths.map(path => readFile(path, 'utf8'))), before);
      const plugins = await instance.plugins(instance.projects[index]);
      for (const id of ['synthetic.tools', 'synthetic.definitions', 'synthetic.native-write']) {
        assert.equal(plugins.find(plugin => plugin.id === id)?.state.status, 'active', id);
      }
      captures.push({ captureDirectory, rootID: root.id, evidence: await records(captureDirectory), coverage });
      t.diagnostic(`Pass ${index + 1}: ${captureDirectory}; root ${root.id}; coverage --coverage; real pilot NOT assessed`);
    }
    const traffic = instance.simulationLog().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.event === 'request');
    assert.ok(traffic.some(row => row.routeKey === 'model' && row.path === '/v1/chat/completions' && row.statusCode === 200));
    assert.ok(traffic.some(row => row.statusCode === 429));

    const idle = (await instance.api('/api/session', { location: { directory: instance.projects[1] } })).data;
    await instance.api(`/api/session/${idle.id}/prompt`, { text: 'Synthetic idle session', resume: false });
    const running = (await instance.api('/api/session', { location: { directory: instance.projects[1] } })).data;
    const excluded = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
    await instance.api(`/api/session/${excluded.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING Synthetic excluded work' });
    await instance.api(`/api/session/${running.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING Synthetic failure check' });
    const second = captures[1];
    const beforeFailure = await eventually(async () => {
      const all = await records(second.captureDirectory);
      return all.some(row => row.type === 'session.text.delta' && row.sessionID === running.id) && all;
    }, 'isolated failure check did not start');
    const preserved = join(instance.root, 'preserved');
    await rename(second.captureDirectory, preserved);
    await writeFile(second.captureDirectory, 'Synthetic unavailable destination', { flag: 'wx' });
    await instance.api(`/api/session/${running.id}`, { title: 'Synthetic failure barrier' }, 'PATCH');
    const notice = await eventually(async () => {
      const session = (await instance.api(`/api/session/${running.id}`)).data;
      return session.metadata?.evagenticRecorder?.interruption.stop === 'confirmed' && session;
    }, 'running work did not receive a confirmed public interruption');
    assert.match(notice.title, /Fallo del registrador/);
    assert.match(notice.metadata.evagenticRecorder.notice, /Revisar antes de volver a ejecutar/);
    assert.equal(notice.metadata.evagenticRecorder.pilotReady, false);
    assert.equal(notice.metadata.evagenticRecorder.reviewRequired, true);
    assert.deepEqual(notice.metadata.evagenticRecorder.interruption, { requested: true, result: 'accepted', stop: 'confirmed' });
    assert.equal(notice.outcome, 'interrupted');
    const unknown = await eventually(async () => {
      const state = (await instance.api(`/api/session/${idle.id}`)).data.metadata?.evagenticRecorder;
      return state?.interruption.result === 'not-running' && state;
    }, 'idle session did not receive an unconfirmed interruption result');
    assert.deepEqual(unknown.interruption, { requested: true, result: 'not-running', stop: 'unconfirmed' });
    const outside = (await instance.api(`/api/session/${excluded.id}`)).data;
    assert.equal(outside.metadata?.evagenticRecorder, undefined);
    assert.equal((await instance.api('/api/session/active')).data[excluded.id]?.type, 'running');
    assert.ok(!JSON.stringify(await records(preserved)).includes(excluded.id));
    await assert.rejects(instance.api(`/api/session/${running.id}/prompt`, { text: 'Synthetic blocked resumption' }), /500:/);
    assert.deepEqual((await records(preserved)).slice(0, beforeFailure.length), beforeFailure);
    second.captureDirectory = preserved;
    second.coverage = inspect(preserved, second.rootID, '--coverage')[0];
    t.diagnostic(`Failure check: ${preserved}; stop confirmed for active work, unconfirmed for idle work; excluded project still running; no rollback claimed`);
    await instance.stop();
    for (const capture of captures) {
      assert.deepEqual((await records(capture.captureDirectory)).slice(0, capture.evidence.length), capture.evidence);
      assert.deepEqual(inspect(capture.captureDirectory, capture.rootID, '--coverage'), [capture.coverage]);
    }
  });
