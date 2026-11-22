import { Plugin } from '@opencode/plugin';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

type CapturedEvent = {
  type: string;
  source: 'opencode.event';
  eventID: string | null;
  sourceTime: number;
  sourceSequence: number | null;
  sourceVersion: number | null;
  sourceAggregateID: string | null;
  projectID: string | null;
  sessionID: string | null;
  parentSessionID: string | null;
  agentID: string | null;
  sessionObservedAt: number;
  callID: string | null;
  toolName: string | null;
  childSessionID: string | null;
  executionID: null;
  messageID: string | null;
  ordinal: number | null;
  content: { role: 'user' | 'assistant'; text: string } | null;
  status: 'captured' | 'omitted' | 'unrecognized';
  omissions: string[];
  redactions: string[];
};

type Interruption = {
  requested: boolean;
  result: 'pending' | 'accepted' | 'not-running' | 'failed' | 'not-requested';
  stop: 'unconfirmed' | 'confirmed';
};

type SessionScope = { id: string; projectID: string; location: { directory: string } };

export default Plugin.define({
  id: 'evagentic.recorder',
  async setup(ctx) {
    if (ctx.app.version !== '2.1.2' || typeof ctx.event?.subscribe !== 'function'
      || typeof ctx.tool?.hook !== 'function' || typeof ctx.shell?.hook !== 'function'
      || ['get', 'list', 'hook', 'update', 'interrupt', 'wait'].some(key =>
        typeof ctx.session?.[key as keyof typeof ctx.session] !== 'function')
      || ['get', 'set', 'remove'].some(key => typeof ctx.storage?.[key as keyof typeof ctx.storage] !== 'function')) {
      throw new Error('Recorder: unsupported runtime; requires OpenCode V2 2.1.2. Pilot blocked; review before running.');
    }
    const location = await realpath(ctx.location.directory);
    let project: string | undefined;
    let selected = false;
    let failed = false;
    let failureReason = 'preparation-failure';
    let failure: Promise<void> | undefined;
    const observed = new Map<string, string>();
    const interruptions = new Map<string, Promise<void>>();
    const inScope = async (session: SessionScope, allowMissingPath = false) => {
      if (session.projectID !== ctx.location.project.id) return false;
      try { return await realpath(session.location.directory) === location; }
      catch (error) {
        if (allowMissingPath && observed.get(session.id) === session.location.directory) return true;
        throw error;
      }
    };
    const notice = 'Fallo del registrador. Captura incompleta. Revisar antes de volver a ejecutar. '
      + 'La solicitud de interrupción no revierte efectos externos ni garantiza su cancelación inmediata.';
    const publish = async (sessionID: string, interruption: Interruption) => {
      const session = await ctx.session.get({ sessionID }, { signal: AbortSignal.timeout(5000) });
      if (!await inScope(session, true)) return;
      await ctx.session.update({ sessionID,
        title: 'Fallo del registrador · Revisar antes de volver a ejecutar',
        metadata: { ...session.metadata, evagenticRecorder: {
          status: 'failed', reason: failureReason, notice, reviewRequired: true, pilotReady: false,
          interruption: { ...interruption },
        } } }, { signal: AbortSignal.timeout(5000) });
    };
    const interrupt = async (sessionID: string) => {
      const current = await ctx.session.get({ sessionID }, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (current) {
        try { if (!await inScope(current, true)) return; }
        catch { console.error('Recorder: cannot verify changed session scope; stop unconfirmed.'); return; }
      } else if (!observed.has(sessionID)) return;
      const interruption: Interruption = { requested: true, result: 'pending', stop: 'unconfirmed' };
      await publish(sessionID, interruption).catch(() => { console.error('Recorder: public notice failed; stop unconfirmed.'); });
      const requestedAt = Date.now();
      try {
        const result = await ctx.session.interrupt({ sessionID, resume: false }, { signal: AbortSignal.timeout(5000) });
        interruption.result = result.interrupted ? 'accepted' : 'not-running';
        await publish(sessionID, interruption).catch(() => {});
        if (result.interrupted) {
          await ctx.session.wait({ sessionID }, { signal: AbortSignal.timeout(5000) });
          const stopped = await ctx.session.get({ sessionID }, { signal: AbortSignal.timeout(5000) });
          if (stopped.outcome === 'interrupted' && (stopped.time.idle ?? 0) >= requestedAt) {
            interruption.stop = 'confirmed';
          }
        }
      } catch { interruption.result = interruption.result === 'pending' ? 'failed' : interruption.result; }
      await publish(sessionID, interruption).catch(() => {});
      console.error(`Recorder: interruption ${interruption.result}; stop ${interruption.stop}.`);
    };
    const stopOnce = (sessionID: string) => {
      if (!interruptions.has(sessionID)) interruptions.set(sessionID, interrupt(sessionID));
      return interruptions.get(sessionID)!;
    };
    const fail = (reason: string) => {
      failed = true;
      if (!failure) failureReason = reason;
      return failure ??= (async () => {
        console.error(`Recorder: ${notice}`);
        // Already armed before capture: failure of THIS write must not erase the safety latch.
        const latch = ctx.storage.set('failure', { reason, reviewRequired: true })
          .catch(() => { console.error('Recorder: failure latch could not be persisted; pilot blocked.'); });
        try {
          if (!selected) return; // Invalid configuration cannot authorize cross-session interruption.
          // Repeat after interruption: delegates may appear while the previous wave is checked.
          // The live subscription below keeps enforcing the latch after a quiet scan too.
          let previousSize = -1;
          do {
            previousSize = interruptions.size;
            const targets = new Set(observed.keys());
            try {
              let cursor: string | undefined;
              do {
                const page = await ctx.session.list(cursor ? { cursor } : { directory: project, limit: 100 },
                  { signal: AbortSignal.timeout(5000) });
                for (const session of page.data) {
                  try { if (await inScope(session, true)) targets.add(session.id); }
                  catch { console.error('Recorder: cannot verify an unknown session; stop unconfirmed.'); }
                }
                cursor = page.cursor.next ?? undefined;
              } while (cursor);
            } catch { console.error('Recorder: enumeration failed; interrupting previously verified sessions only.'); }
            await Promise.all([...targets].map(stopOnce));
          } while (interruptions.size !== previousSize);
        } catch { console.error('Recorder: interruption handling failed; stop unconfirmed.'); }
        finally { await latch; }
      })();
    };
    const rejectFailedWork = async ({ sessionID }: { sessionID: string }) => {
      if (!failed) return;
      try {
        const session = await ctx.session.get({ sessionID }, { signal: AbortSignal.timeout(5000) });
        if (!session.metadata?.evagenticRecorder) {
          await publish(sessionID, { requested: false, result: 'not-requested', stop: 'unconfirmed' });
        }
      } catch { console.error('Recorder: blocked prompt notice failed; pilot blocked.'); }
      throw new Error(`Recorder: ${notice}`);
    };
    const guards = await Promise.all((['prompt', 'context', 'compaction', 'generate', 'title'] as const)
      .map(name => ctx.session.hook(name, rejectFailedWork)));
    guards.push(await ctx.tool.hook('execute.before', rejectFailedWork));
    guards.push(await ctx.shell.hook('create.before', () => {
      if (failed) throw new Error(`Recorder: ${notice}`);
    }));
    try {
      const filename = process.env.EVAGENTIC_CONFIG;
      if (!filename || !isAbsolute(filename)) throw new Error('Recorder: EVAGENTIC_CONFIG must be absolute.');
      let config;
      try { config = JSON.parse(await readFile(filename, 'utf8')); }
      catch { throw new Error('Recorder: cannot read local configuration.'); }
      if (config?.version !== 1 || typeof config.projectDirectory !== 'string'
        || !isAbsolute(config.projectDirectory) || typeof config.captureDirectory !== 'string'
        || !isAbsolute(config.captureDirectory) || !Array.isArray(config.secrets)
        || config.secrets.some((value: unknown) => typeof value !== 'string' || !value.length)
        || Object.keys(config).some(key => !['version', 'projectDirectory', 'captureDirectory', 'secrets'].includes(key))) {
        throw new Error('Recorder: invalid local configuration v1.');
      }
      project = await realpath(config.projectDirectory);
      if (!(await stat(project)).isDirectory()) throw new Error('Recorder: project is not a directory.');
      if (location !== project) { await Promise.all(guards.map(guard => guard.dispose())); return; }
      selected = true;
      const previous = object(await ctx.storage.get('failure'));
      if (previous.reviewRequired === true) {
        await fail(previous.reason === 'preparation-failure' ? previous.reason : 'event-stream-or-persistence-failure');
        return;
      }
      // Arm durably BEFORE declaring capture ready. Only a healthy cleanup may disarm it.
      await ctx.storage.set('failure', { reason: 'event-stream-or-persistence-failure', reviewRequired: true });
      await mkdir(config.captureDirectory, { recursive: true, mode: 0o700 });
      const destination = await realpath(config.captureDirectory);
      const inside = relative(project, destination);
      if (!inside || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) {
        throw new Error('Recorder: capture destination must be outside the authorized project.');
      }
      const captureID = randomUUID();
      const pending = join(destination, `${captureID}.pending`);
      const journal = join(destination, `${captureID}.jsonl`);
      await (await open(pending, 'wx', 0o600)).close();
      let journalPath = pending;
      let arrival = 0;
      let writes = Promise.resolve();
      const append = (record: Record<string, unknown>) => writes = writes.then(async () => {
        // Do not recreate missing evidence. Reopening also detects a lost destination on Windows.
        const file = await open(journalPath, constants.O_WRONLY | constants.O_APPEND);
        try {
          await file.appendFile(`${JSON.stringify({ schemaVersion: 1, captureID,
            arrival: ++arrival, observedAt: Date.now(), ...record })}\n`, 'utf8');
          // ponytail: fsync per event favors evidence over throughput; batching needs an explicit loss window.
          await file.sync();
        } finally { await file.close(); }
      });
      const controller = new AbortController();
      const delegationCalls = new Set<string>();
      const task = (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (!event.type.startsWith('session.')) continue;
            // Context location alone is NOT an authorization boundary: this stream can cross projects.
            if (event.location && await realpath(event.location.directory) !== project) continue;
            const data = object(event.data);
            if (typeof data.sessionID !== 'string'
              || !('created' in event) || !Number.isFinite(event.created)) {
              await append({ type: 'recorder.gap', reason: 'unrecognized-session-envelope' });
              continue;
            }
            const session = await ctx.session.get({ sessionID: data.sessionID });
            if (!await inScope(session)) continue;
            observed.set(session.id, session.location.directory);
            if (failed) { void stopOnce(session.id); continue; }
            let parentSessionID: string | null = null;
            if (session.parentID) {
              const parent = await ctx.session.get({ sessionID: session.parentID });
              if (await inScope(parent)) parentSessionID = parent.id;
            }
            const sessionObservedAt = Date.now();
            const durable = 'durable' in event ? event.durable : undefined;
            const callKey = JSON.stringify([session.id, data.assistantMessageID, data.id]);
            if (event.type === 'session.tool.input.started' && durable?.version === 1 && data.name === 'subagent') {
              delegationCalls.add(callKey);
            }
            let childSessionID: string | null = null;
            if (event.type === 'session.tool.success' && durable?.version === 2 && delegationCalls.has(callKey)) {
              const childID = object(data.metadata).sessionID;
              if (typeof childID === 'string') {
                const child = await ctx.session.get({ sessionID: childID });
                if (await inScope(child) && child.parentID === session.id) childSessionID = child.id;
              }
            }
            if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') delegationCalls.delete(callKey);
            const record: CapturedEvent = {
              type: event.type, source: 'opencode.event', eventID: event.id,
              sourceTime: event.created, sourceSequence: durable?.seq ?? null,
              sourceVersion: durable?.version ?? null, sourceAggregateID: durable?.aggregateID ?? null,
              projectID: session.projectID, sessionID: session.id, executionID: null,
              parentSessionID, agentID: session.agent ?? null, sessionObservedAt,
              callID: event.type.startsWith('session.tool.') && typeof data.id === 'string' ? data.id : null,
              toolName: event.type === 'session.tool.input.started' && typeof data.name === 'string' ? data.name : null,
              childSessionID,
              messageID: [data.assistantMessageID, data.inboxID, data.messageID]
                .find((value): value is string => typeof value === 'string') ?? null,
              ordinal: typeof data.ordinal === 'number' && Number.isSafeInteger(data.ordinal) && data.ordinal >= 0
                ? data.ordinal : null,
              content: null, status: 'omitted',
              omissions: ['event-payload-not-captured'], redactions: [],
            };
            let text: unknown;
            let role: 'user' | 'assistant' | undefined;
            if (event.type === 'session.inbox.enqueued') {
              const item = object(data.item);
              if (item.type === 'user') { text = object(item.payload).text; role = 'user'; }
              else if (!['synthetic', 'compaction', 'move'].includes(String(item.type))) {
                record.status = 'unrecognized';
                record.omissions = ['unrecognized-inbox-format'];
              }
            } else if (event.type === 'session.text.ended') { text = data.text; role = 'assistant'; }
            if (role) {
              if (durable?.version !== 1 || typeof text !== 'string') {
                record.status = 'unrecognized';
                record.omissions = ['unrecognized-content-format'];
              } else {
                const sanitized = redact(text, config.secrets);
                record.content = { role, text: sanitized.text };
                record.status = 'captured';
                record.redactions = sanitized.reasons;
                record.omissions = ['non-text-fields-not-captured'];
              }
            }
            for (const key of ['eventID', 'sourceAggregateID', 'projectID', 'sessionID', 'messageID',
              'parentSessionID', 'agentID', 'callID', 'toolName', 'childSessionID'] as const) {
              const value = record[key];
              if (value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)
                || config.secrets.some((secret: string) => value.includes(secret)))) {
                record[key] = null;
                record.omissions.push('unsafe-identifier');
              }
            }
            record.omissions = [...new Set(record.omissions)];
            await append(record);
          } catch {
            void fail('event-stream-or-persistence-failure');
            try { await append({ type: 'recorder.failed', reason: 'event-stream-or-persistence-failure' }); }
            catch { /* Continue observing identities even when the capture destination has failed. */ }
          }
        }
        if (!controller.signal.aborted) throw new Error('Event stream ended.');
      })().catch(async error => {
        // Only cancellation of the subscription is expected during cleanup. An in-flight
        // acquisition/write can fail AFTER abort; that is still a recorder failure.
        if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') return;
        await fail('event-stream-or-persistence-failure');
        try { await append({ type: 'recorder.failed', reason: 'event-stream-or-persistence-failure' }); }
        catch { /* A failed disk cannot be relied on to record its own failure. */ }
      });
      let promoted = false;
      try {
        if (failed) throw new Error('Subscription failed.');
        await append({ type: 'recorder.ready', runtimeVersion: ctx.app.version, sdkVersion: '2.1.2',
          coverage: { replay: false, content: ['admitted-user-text', 'completed-assistant-text'],
            excluded: ['attachments', 'tools', 'reasoning', 'definitions', 'headers', 'global-config'],
            executionID: 'not-exposed', ordering: 'arrival-is-not-causality' } });
        // Subscription failure can race the durable write: check again before publishing readiness.
        if (failed) throw new Error('Subscription failed during preparation.');
        await rename(pending, journal);
        journalPath = journal;
        promoted = true;
        if (failed) throw new Error('Subscription failed during preparation.');
      } catch {
        controller.abort();
        await task;
        await failure;
        await Promise.all(interruptions.values());
        await writes.catch(() => {});
        if (promoted) await rename(journal, pending).catch(() => {});
        throw new Error('Recorder: capture destination failed the durable write check.');
      }
      return async () => {
        controller.abort();
        await task;
        await failure;
        await Promise.all(interruptions.values());
        try { await writes; }
        catch { await fail('event-stream-or-persistence-failure'); }
        if (!failed) await ctx.storage.remove('failure');
      };
    } catch {
      await fail('preparation-failure');
      // A failed setup is not an admission veto in 2.1.2: keep the rejecting hook registered.
      // Runtime "active" means the safety guard runs, NOT that capture preparation succeeded.
    }
  },
});

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function redact(input: string, secrets: string[]) {
  let text = input;
  const reasons: string[] = [];
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (text.includes(secret)) { text = text.split(secret).join('[REDACTED]'); reasons.push('configured-literal'); }
  }
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/gi,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[=:]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s,;]+)/gi,
  ];
  for (const pattern of patterns) {
    text = text.replace(pattern, () => { reasons.push('credential-pattern'); return '[REDACTED]'; });
  }
  return { text, reasons: [...new Set(reasons)] };
}
