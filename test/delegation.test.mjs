import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eventually, fixture, records } from './support/instance.mjs';

test('la delegación anidada y repetida conserva ramas concurrentes consultables', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true, config: { secrets: ['synthetic-secret-42'] },
    serverConfig: { experimental: { subagent_depth: 3 }, agents: { 'synthetic-branch': { mode: 'all', description: 'Synthetic branching agent',
      permissions: [{ action: 'subagent', resource: 'synthetic-branch', effect: 'allow' }] } } } });
  const root = (await instance.api('/api/session', { location: { directory: instance.projects[0] },
    title: 'Synthetic tree' })).data;
  await instance.api(`/api/session/${root.id}/prompt`, { text: 'SYNTHETIC_TREE_ROOT' });
  const evidence = await eventually(async () => {
    const all = await records(instance.captureDirectory);
    return new Set(all.filter(row => row.type === 'session.text.ended').map(row => row.sessionID)).size === 4 && all;
  }, 'nested delegation did not complete');
  const sessions = (await instance.api(`/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  const messages = (await instance.api(`/api/session/${root.id}/message`)).data;
  const children = sessions.filter(session => session.parentID === root.id);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.ok(evidence.some(row => row.sessionID === child.id && row.parentSessionID === root.id));
  }
  for (const session of sessions.filter(session => session.id !== root.id)) {
    assert.ok(evidence.some(row => row.sessionID === session.id && row.agentID === 'synthetic-branch'));
  }
  const tools = messages.flatMap(message => message.content ?? []).filter(part => part.type === 'tool');
  for (const tool of tools) {
    assert.equal(evidence.filter(row => row.type === 'session.tool.success' && row.sessionID === root.id
      && row.callID === tool.id && row.childSessionID === tool.state.metadata.sessionID).length, 1);
  }
  const starts = children.map(child => evidence.find(row => row.type === 'session.execution.started' && row.sessionID === child.id));
  const ends = children.map(child => evidence.find(row => row.type === 'session.execution.succeeded' && row.sessionID === child.id));
  assert.ok(starts.every(Boolean) && ends.every(Boolean));
  assert.ok(Math.max(...starts.map(row => row.sourceTime)) < Math.min(...ends.map(row => row.sourceTime)),
    'sibling execution intervals did not overlap');
  assert.ok(evidence.filter(row => row.source === 'opencode.event').every(row => row.executionID === null));
  const grandchild = sessions.find(session => children.some(child => child.id === session.parentID));
  assert.ok(grandchild);
  assert.ok(evidence.some(row => row.sessionID === grandchild.id && row.parentSessionID === grandchild.parentID));
  assert.ok(evidence.some(row => row.childSessionID === grandchild.id && row.sessionID === grandchild.parentID
    && row.callID === 'call_synthetic_delegate_0'));
  const events = evidence.filter(row => row.source === 'opencode.event');
  assert.equal(new Set(events.map(row => row.eventID)).size, events.length);
  const inspected = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/inspect.mjs', import.meta.url)),
    instance.captureDirectory, root.id, '--tree'], { encoding: 'utf8' });
  assert.ok(children.every(child => inspected.includes(child.id)));
  assert.ok(!inspected.includes('synthetic-secret-42'));
  assert.ok(!JSON.stringify(evidence).includes('synthetic-secret-42'));
  // Admission hooks may run again, but a retried public message ID is still one admission.
  await Promise.all([0, 1].map(() => instance.api(`/api/session/${root.id}/prompt`, {
    id: 'msg_synthetic_retry', text: 'Synthetic retried admission', resume: false })));
  await eventually(async () => (await records(instance.captureDirectory))
    .some(row => row.messageID === 'msg_synthetic_retry'), 'retry admission was not captured');
  assert.equal((await records(instance.captureDirectory)).filter(row => row.type === 'session.inbox.enqueued'
    && row.messageID === 'msg_synthetic_retry').length, 1);
  assert.ok(instance.simulationLog().includes('"path":"/v1/chat/completions"'));
});

test('un fallo interrumpe el árbol observado y nuevos descendientes sin afectar otro proyecto', { timeout: 90000 }, async t => {
  const instance = await fixture(t, { simulation: true, lateDescendant: true,
    serverConfig: { experimental: { subagent_depth: 3 }, agents: { 'synthetic-branch': { mode: 'all',
      description: 'Synthetic branching agent',
      permissions: [{ action: 'subagent', resource: 'synthetic-branch', effect: 'allow' }] } } } });
  const root = (await instance.api('/api/session', { location: { directory: instance.projects[0] } })).data;
  const excluded = (await instance.api('/api/session', { location: { directory: instance.projects[1] } })).data;
  await instance.api(`/api/session/${excluded.id}/prompt`, { text: 'SYNTHETIC_LONG_RUNNING Excluded project' });
  await instance.api(`/api/session/${root.id}/prompt`, { text: 'SYNTHETIC_TREE_ROOT SYNTHETIC_LONG_RUNNING' });
  const evidence = await eventually(async () => {
    const all = await records(instance.captureDirectory);
    return new Set(all.filter(row => row.type === 'session.text.delta').map(row => row.sessionID)).size === 4 && all;
  }, 'concurrent delegated work did not start');
  const before = (await instance.api(`/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data;
  assert.equal(before.length, 4);
  const preserved = join(instance.root, 'preserved');
  await rename(instance.captureDirectory, preserved);
  await writeFile(instance.captureDirectory, 'Synthetic persistence failure');
  await instance.api(`/api/session/${root.id}`, { title: 'Trigger recorder failure' }, 'PATCH');
  const late = await eventually(async () => (await instance.api(
    `/api/session?directory=${encodeURIComponent(instance.projects[0])}`)).data.find(s => s.metadata?.syntheticLate),
  'descendant was not created during interruption checks');
  for (const session of [...before, late]) {
    const notice = await eventually(async () => {
      const { data } = await instance.api(`/api/session/${session.id}`);
      const state = data.metadata?.evagenticRecorder;
      return state?.interruption.result !== 'pending' && state?.interruption.requested && state;
    }, 'an observed descendant did not receive an interruption request');
    if (session.id === late.id) {
      assert.equal(notice.interruption.result, 'not-running');
      assert.equal(notice.interruption.stop, 'unconfirmed');
    } else {
      await instance.api(`/api/experimental/session/${session.id}/wait`, {});
      const stopped = (await instance.api(`/api/session/${session.id}`)).data;
      assert.ok(['accepted', 'not-running'].includes(notice.interruption.result));
      if (stopped.metadata.evagenticRecorder.interruption.stop === 'confirmed') assert.equal(stopped.outcome, 'interrupted');
    }
  }
  const outside = (await instance.api(`/api/session/${excluded.id}`)).data;
  assert.equal(outside.metadata?.evagenticRecorder, undefined);
  assert.equal((await instance.api('/api/session/active')).data[excluded.id]?.type, 'running');
  assert.deepEqual((await records(preserved)).slice(0, evidence.length), evidence);
  assert.ok(!JSON.stringify(await records(preserved)).includes(excluded.id));
  await eventually(async () => {
    const active = (await instance.api('/api/session/active')).data;
    return before.every(session => !active[session.id]);
  }, 'observed execution remained active after interruption');
  // The failed writer must not terminate identity observation after its initial scan.
  const later = (await instance.api('/api/session', { parentID: late.id,
    location: { directory: instance.projects[0] }, title: 'Synthetic descendant after quiet scan' })).data;
  await eventually(async () => (await instance.api(`/api/session/${later.id}`)).data.metadata
    ?.evagenticRecorder?.interruption.requested, 'identity observation stopped with the failed writer');
});
