import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const common = { schemaVersion: 1, captureID: '00000000-0000-4000-8000-000000000013', observedAt: 1 };
const context = { kind: 'primary', agentID: 'build', model: { providerID: 'synthetic', id: 'synthetic' },
  system: [{ text: 'Synthetic instructions', instructions: null }], messages: [], tools: {}, finalContext: false };
const observation = (stage, source, value, extra = {}) => ({ ...common, type: 'recorder.observation',
  observationVersion: 1, stage, source, identity: null, observationTime: 1, requestObservationID: null,
  projectID: 'project_synthetic', sessionID: 'session_root', executionID: null, messageID: null, eventID: null,
  value, sha256: createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'),
  hashBasis: 'redacted-json-utf8', status: 'captured', omissions: [], redactions: [], ...extra });
async function capture(rows) {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ??
    (process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : '/tmp'), 'recorder-inspect-'));
  await writeFile(join(directory, 'synthetic.jsonl'), rows.map((row, index) =>
    JSON.stringify({ ...row, arrival: index + 1 })).join('\n') + '\n');
  return directory;
}
const inspect = (directory, ...args) => execFileSync(process.execPath,
  [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)), directory, ...args],
  { encoding: 'utf8', stdio: 'pipe' });

test('seleccionar sesión o árbol no atribuye observaciones ni inventarios con identidad excluida', async t => {
  const rows = [
    { ...common, type: 'recorder.ready', runtimeVersion: '2.1.2', sdkVersion: '2.1.2',
      coverage: { replay: false, content: [], excluded: [], executionID: 'not-exposed', ordering: 'arrival-is-not-causality' } },
    { ...common, type: 'recorder.failed', reason: 'event-stream-or-persistence-failure' },
    { ...common, type: 'recorder.gap', reason: 'unrecognized-session-envelope' },
    observation('context-hook', 'opencode.session.hook.context', context),
    { ...common, type: 'session.created', source: 'opencode.event', eventID: null, sourceTime: 1,
      sourceSequence: null, sourceVersion: null, sourceAggregateID: null, projectID: 'project_synthetic',
      sessionID: 'session_child', executionID: null, messageID: null, ordinal: null, content: null,
      status: 'omitted', omissions: ['event-payload-not-captured'], redactions: [], parentSessionID: 'session_root',
      agentID: null, sessionObservedAt: 1, callID: null, toolName: null, childSessionID: null },
    observation('runtime-definition', 'opencode.skill.list', null, { sessionID: 'session_child' }),
    observation('context-hook', 'opencode.session.hook.context', context, { sessionID: 'session_other' }),
    observation('context-hook', 'opencode.session.hook.context', context,
      { sessionID: null, omissions: ['unsafe-identifier'] }),
    observation('runtime-definition', 'opencode.skill.list', null, { sessionID: null, omissions: ['unsafe-identifier'] }),
    { ...common, type: 'recorder.tools.available', source: 'opencode.tool.list', projectID: 'project_synthetic',
      sessionID: null, toolNames: ['synthetic'], modelToolNames: [], omissions: ['unsafe-identifier'] },
  ];
  const directory = await capture(rows);
  assert.equal(inspect(directory).trim().split('\n').length, rows.length, 'unscoped inspection must retain unknown identities');
  for (const mode of [[], ['--tree']]) await t.test(mode[0] ?? 'normal', () => {
    const selected = inspect(directory, 'session_root', ...mode).trim().split('\n').map(JSON.parse);
    assert.deepEqual(selected.map(row => row.arrival), mode.length ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4]);
  });
});

test('un hash correcto no convierte una proyección de contexto malformada en evidencia capturada', async () => {
  for (const value of [42, null, [], { ...context, finalContext: true },
    { ...context, model: { providerID: 'synthetic' } },
    { ...context, system: [{ text: 'Synthetic', instructions: [{ key: 42, text: 'Synthetic' }] }] },
    { ...context, messages: [{ id: null, role: 'user', text: 'Synthetic' }] },
    { ...context, tools: { synthetic: { description: 'Synthetic', input: 42 } } },
    { ...context, kind: 'title' }, { ...context, extra: 'synthetic-unknown-payload' },
  ]) {
    const directory = await capture([observation('context-hook', 'opencode.session.hook.context', value)]);
    for (const args of [[], ['session_root'], ['session_root', '--tree'], ['session_root', '--tools']]) {
      assert.throws(() => inspect(directory, ...args),
        error => error.status === 1 && error.stdout === '' && error.stderr.includes('line 1')
          && !error.stderr.includes('synthetic-unknown-payload'), `accepted malformed context: ${JSON.stringify(value)}`);
    }
  }
});

test('el lector valida definiciones y disponibilidad por etapa y fuente aunque el hash coincida', async () => {
  const skill = { id: 'synthetic', name: 'Synthetic', description: null, content: 'Synthetic body',
    path: 'synthetic/SKILL.md', autoinvoke: null };
  const agent = { id: 'build', name: 'Synthetic', mode: 'primary', description: null, system: null };
  for (const [stage, source, value] of [
    ['availability', 'opencode.skill.list', 42],
    ['availability', 'opencode.skill.list', [{ id: 'synthetic', name: 'Synthetic', description: null, autoinvoke: 'yes' }]],
    ['availability', 'opencode.skill.list', [skill]],
    ['runtime-definition', 'opencode.skill.list', 42],
    ['runtime-definition', 'opencode.skill.list', { ...skill, content: [] }],
    ['runtime-definition', 'opencode.skill.list', agent],
    ['runtime-definition', 'opencode.agent.get', 42],
    ['runtime-definition', 'opencode.agent.get', { ...agent, system: 42 }],
    ['runtime-definition', 'opencode.agent.get', { ...agent, mode: 'unknown' }],
    ['runtime-definition', 'opencode.agent.get', skill],
    ['deployed-file', 'node.fs.readFile', 42],
    ['deployed-file', 'node.fs.readFile', { path: [], content: null }],
    ['deployed-file', 'node.fs.readFile', { path: null, content: null, metadata: 'synthetic-unknown-payload' }],
    ['admitted-skill', 'opencode.session.inbox.skills', 42],
    ['admitted-skill', 'opencode.session.inbox.skills', { id: 'synthetic', name: 'Synthetic', text: [] }],
    ['environment', 'opencode.plugin.list', 42],
    ['environment', 'opencode.plugin.list', { plugins: [42], configurationSources: null, transformations: null }],
    ['environment', 'opencode.plugin.list', { plugins: [{ id: null, source: 'unknown', version: null, status: 'active' }],
      configurationSources: null, transformations: null }],
    ['environment', 'opencode.plugin.list', { plugins: [], configurationSources: {}, transformations: null }],
  ]) {
    const directory = await capture([observation(stage, source, value)]);
    assert.throws(() => inspect(directory),
      error => error.status === 1 && error.stdout === '' && error.stderr.includes('line 1')
        && !error.stderr.includes('synthetic-unknown-payload'), `accepted malformed ${stage}/${source}: ${JSON.stringify(value)}`);
  }
});

test('las proyecciones válidas conservan los desconocidos null y el contenido filtrado sin necesitar OpenCode', async () => {
  const rows = [
    observation('availability', 'opencode.skill.list', [{ id: 'synthetic', name: 'Synthetic', description: null, autoinvoke: null }]),
    observation('availability', 'opencode.skill.list', []),
    observation('runtime-definition', 'opencode.skill.list', { id: 'synthetic', name: 'Synthetic', description: null,
      content: 'Synthetic body', path: 'synthetic/SKILL.md', autoinvoke: false }),
    observation('runtime-definition', 'opencode.skill.list', null, { omissions: ['skill-definition-not-found'] }),
    observation('runtime-definition', 'opencode.agent.get', { id: 'build', name: 'Synthetic', mode: 'all', description: null, system: null }),
    observation('deployed-file', 'node.fs.readFile', { path: 'synthetic/SKILL.md', content: 'Synthetic body' }),
    observation('deployed-file', 'node.fs.readFile', { path: null, content: null }),
    observation('admitted-skill', 'opencode.session.inbox.skills', { id: 'synthetic', name: 'Synthetic', text: 'Synthetic body' }),
    observation('admitted-skill', 'opencode.session.inbox.skills', null, { omissions: ['unrecognized-admitted-skill-format'] }),
    observation('environment', 'opencode.plugin.list', { plugins: [
      { id: null, source: 'local', version: null, status: 'failed' },
      { id: 'synthetic', source: 'package', version: '1.0.0', status: 'active' },
      { id: 'synthetic.sdk', source: 'sdk', version: null, status: 'active' },
    ], configurationSources: null, transformations: null }),
    observation('context-hook', 'opencode.session.hook.title', { ...context, kind: 'title', agentID: null, tools: null }),
    observation('context-hook', 'opencode.session.hook.generate', { ...context, kind: 'generate',
      system: [{ text: 'Synthetic', instructions: [{ key: 'synthetic', text: 'Synthetic source' }] }],
      messages: [{ id: null, role: 'tool', text: [] }, { id: 'msg_synthetic', role: 'user', text: ['Synthetic input'] }],
      tools: { synthetic: { description: 'Synthetic', input: { type: 'object' } },
        'synthetic.boolean': { description: 'Synthetic', input: true }, token: '[REDACTED]' } },
    { redactions: ['credential-pattern'] }),
    observation('context-hook', 'opencode.session.hook.context', null,
      { status: 'unrecognized', sha256: null, omissions: ['unrecognized-observation-format'] }),
  ];
  const directory = await capture(rows);
  for (const args of [[], ['session_root'], ['session_root', '--tree']]) {
    assert.deepEqual(inspect(directory, ...args).trim().split('\n').map(JSON.parse),
      rows.map((row, index) => ({ ...row, arrival: index + 1 })));
  }
});
