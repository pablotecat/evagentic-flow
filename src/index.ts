import { Plugin } from '@opencode/plugin';
import { createHash, randomUUID } from 'node:crypto';
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
  tool: ToolEvidence | null;
  interaction: {
    kind: 'permission' | 'form';
    requestID: string | null;
    phase: 'requested' | 'replied' | 'cancelled';
    origin: 'runtime-request' | 'external-reply-unattributed' | 'runtime-cancellation';
    relationSource: 'permission-source' | 'permission-request-event' | 'form-question-metadata' | 'form-request-event' | null;
    request: Json;
    response: Json;
  } | null;
  retry: { kind: 'model'; attempt: number; at: number; error: NonNullable<ToolEvidence['error']> } | null;
  skill: { id: string | null; name: string | null; text: string; sha256: string; origin: string;
    contextID: null; consumption: null } | null;
  status: 'captured' | 'omitted' | 'unrecognized';
  omissions: string[];
  redactions: string[];
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ToolEvidence = {
  input: Json;
  inputText: string | null;
  output: { type: 'text'; text: string }[] | null;
  error: { type: string; message: string; status?: number } | null;
  outcome: 'not-observed' | 'success' | 'error';
  executed: boolean | null;
  reportedError: boolean | null;
  retryOf: null;
  operationID: null;
  consumption: null;
};

type Interruption = {
  requested: boolean;
  result: 'pending' | 'accepted' | 'not-running' | 'failed' | 'not-requested';
  stop: 'unconfirmed' | 'confirmed';
};

type SessionScope = { id: string; projectID: string; location: { directory: string } };
type Observation = {
  stage: 'availability' | 'deployed-file' | 'runtime-definition' | 'context-hook' | 'environment' | 'admitted-skill';
  source: string;
  identity: string | null;
  observationTime: number;
  requestObservationID?: string | null;
  messageID?: string | null;
  eventID?: string | null;
  omissions?: string[];
};

export default Plugin.define({
  id: 'evagentic.recorder',
  async setup(ctx) {
    if (ctx.app.version !== '2.1.2' || typeof ctx.event?.subscribe !== 'function'
      || typeof ctx.tool?.hook !== 'function' || typeof ctx.shell?.hook !== 'function'
      || typeof ctx.tool?.list !== 'function' || typeof ctx.skill?.list !== 'function'
      || typeof ctx.agent?.get !== 'function' || typeof ctx.plugin?.list !== 'function'
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
      const toolNames = new Map<string, string>();
      const skillLoads = new Map<string, string>();
      const interactionCalls = new Map<string, { callID: string; messageID: string }>();
      const formFields = new Map<string, Set<string>>();
      const observe = async (session: SessionScope, details: Observation, value: unknown) => {
        const redactions: string[] = [];
        const omissions = [...details.omissions ?? []];
        const id = (value: string | null | undefined, name = false) => {
          if (value == null) return null;
          if (safeIdentifier(value, config.secrets, name)) return value;
          omissions.push('unsafe-identifier'); return null;
        };
        let filtered: Json = null;
        let status = 'captured';
        try { filtered = sanitizeJson(value, config.secrets, redactions); }
        catch { status = 'unrecognized'; omissions.push('unrecognized-observation-format'); }
        const identity = details.identity === null ? null : redact(details.identity, config.secrets);
        redactions.push(...identity?.reasons ?? []);
        await append({ type: 'recorder.observation', observationVersion: 1, stage: details.stage,
          source: details.source, identity: identity?.text ?? null,
          observationTime: details.observationTime, requestObservationID: details.requestObservationID ?? null,
          projectID: id(session.projectID), sessionID: id(session.id), executionID: null,
          messageID: id(details.messageID), eventID: id(details.eventID), value: filtered,
          sha256: status === 'captured' ? digest(JSON.stringify(filtered)) : null,
          hashBasis: 'redacted-json-utf8', status, omissions: [...new Set(omissions)], redactions: [...new Set(redactions)] });
      };
      const observeSkill = async (session: SessionScope, skillID: string, eventID: string | null, messageID: string | null) => {
        const { data: skills } = await ctx.skill.list();
        const skill = skills.find(skill => skill.id === skillID);
        await observe(session, { stage: 'runtime-definition', source: 'opencode.skill.list', identity: skillID,
          eventID, messageID, observationTime: Date.now(),
          omissions: ['registry-read-is-not-historical-activation', 'transform-attribution-not-exposed',
            ...(skill ? [] : ['skill-definition-not-found'])] }, skill ? {
          id: skill.id, name: skill.name, description: skill.description ?? null,
          content: skill.content, path: skill.path, autoinvoke: skill.autoinvoke ?? null,
        } : null);
        if (!skill) return;
        let content: string | null = null;
        let path: string | null = null;
        const omissions = ['file-read-is-not-runtime-context'];
        try {
          const resolved = await realpath(skill.path);
          const rel = relative(project!, resolved);
          if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
            omissions.push('definition-file-outside-project-not-read');
          } else if (!(await stat(resolved)).isFile()) omissions.push('definition-file-not-regular');
          else { path = rel; content = await readFile(resolved, 'utf8'); }
        } catch { omissions.push('definition-file-unavailable'); }
        await observe(session, { stage: 'deployed-file', source: 'node.fs.readFile', identity: skillID,
          eventID, messageID, observationTime: Date.now(), omissions }, { path, content });
      };
      const task = (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (!event.type.startsWith('session.') && !['permission.asked', 'permission.replied',
              'form.created', 'form.replied', 'form.cancelled'].includes(event.type)) continue;
            // Context location alone is NOT an authorization boundary: this stream can cross projects.
            if (event.location && await realpath(event.location.directory) !== project) continue;
            const data = object(event.data);
            const sessionID = event.type === 'form.created' ? object(data.form).sessionID : data.sessionID;
            if (event.type.startsWith('form.') && sessionID === 'global') continue; // Authentication/MCP sentinel, not a session.
            if (typeof sessionID !== 'string'
              || !('created' in event) || !Number.isFinite(event.created)) {
              await append({ type: 'recorder.gap', reason: 'unrecognized-session-envelope' });
              continue;
            }
            const session = await ctx.session.get({ sessionID });
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
            if (event.type === 'session.tool.input.started' && durable?.version === 1 && typeof data.name === 'string') {
              toolNames.set(callKey, data.name);
            }
            let childSessionID: string | null = null;
            if (event.type === 'session.tool.success' && durable?.version === 2 && toolNames.get(callKey) === 'subagent') {
              const childID = object(data.metadata).sessionID;
              if (typeof childID === 'string') {
                const child = await ctx.session.get({ sessionID: childID });
                if (await inScope(child) && child.parentID === session.id) childSessionID = child.id;
              }
            }
            const record: CapturedEvent = {
              type: event.type, source: 'opencode.event', eventID: event.id,
              sourceTime: event.created, sourceSequence: durable?.seq ?? null,
              sourceVersion: durable?.version ?? null, sourceAggregateID: durable?.aggregateID ?? null,
              projectID: session.projectID, sessionID: session.id, executionID: null,
              parentSessionID, agentID: session.agent ?? null, sessionObservedAt,
              callID: event.type.startsWith('session.tool.') && typeof data.id === 'string' ? data.id : null,
              toolName: event.type.startsWith('session.tool.') ? toolNames.get(callKey) ?? null : null,
              childSessionID,
              messageID: [data.assistantMessageID, data.inboxID, data.messageID]
                .find((value): value is string => typeof value === 'string') ?? null,
              ordinal: typeof data.ordinal === 'number' && Number.isSafeInteger(data.ordinal) && data.ordinal >= 0
                ? data.ordinal : null,
              content: null, tool: null, interaction: null, retry: null, skill: null, status: 'omitted',
              omissions: ['event-payload-not-captured'], redactions: [],
            };
            captureTool(record, data, config.secrets);
            if (record.toolName === 'skill' && record.type === 'session.tool.called' && record.tool) {
              const id = object(record.tool.input).id;
              if (typeof id === 'string') skillLoads.set(callKey, id);
            }
            const loadedSkill = skillLoads.get(callKey);
            if (loadedSkill && record.type === 'session.tool.success' && record.tool?.outcome === 'success'
              && record.tool.output?.length) {
              const text = record.tool.output.map(part => part.text).join('\n');
              record.skill = { id: safeIdentifier(loadedSkill, config.secrets, true) ? loadedSkill : null,
                name: null, text, sha256: digest(text), origin: 'successful-skill-tool-result', contextID: null, consumption: null };
              record.omissions.push('skill-execution-context-link-not-exposed', 'skill-consumption-not-exposed');
            }
            if (event.type === 'session.skill.activated') {
              if (durable?.version !== 1 || typeof data.id !== 'string'
                || typeof data.name !== 'string' || typeof data.text !== 'string') {
                record.status = 'unrecognized'; record.omissions = ['unrecognized-skill-format'];
              } else {
                const name = redact(data.name, config.secrets);
                const text = redact(data.text, config.secrets);
                record.skill = { id: safeIdentifier(data.id, config.secrets, true) ? data.id : null,
                  name: name.text, text: text.text, sha256: digest(text.text), origin: 'runtime-activation-event',
                  contextID: null, consumption: null };
                record.status = 'captured';
                record.redactions.push(...name.reasons, ...text.reasons);
                record.omissions = ['skill-message-execution-context-link-not-exposed', 'skill-consumption-not-exposed'];
                if (record.skill.id === null) record.omissions.push('unsafe-identifier');
              }
            }
            if (event.type === 'session.retry.scheduled') {
              const error = object(data.error);
              if (durable?.version !== 1 || !Number.isSafeInteger(data.attempt) || Number(data.attempt) < 1
                || !Number.isSafeInteger(data.at) || Number(data.at) < 0
                || typeof error.type !== 'string' || typeof error.message !== 'string') {
                record.status = 'unrecognized'; record.omissions = ['unrecognized-retry-format'];
              } else {
                const type = redact(error.type, config.secrets);
                const message = redact(error.message, config.secrets);
                record.retry = { kind: 'model', attempt: Number(data.attempt), at: Number(data.at),
                  error: { type: type.text, message: message.text } };
                if (Number.isSafeInteger(error.status) && Number(error.status) >= 100 && Number(error.status) <= 599) {
                  record.retry.error.status = Number(error.status);
                }
                record.redactions.push(...type.reasons, ...message.reasons);
                record.status = 'captured'; record.omissions = ['retry-error-response-not-captured', 'provider-internal-attempts-not-exposed'];
              }
            }
            captureInteraction(record, data, config.secrets, formFields);
            if (record.interaction && record.interaction.requestID !== null) {
              const permission = record.interaction.kind === 'permission';
              const requestKey = JSON.stringify([session.id, record.interaction.kind, record.interaction.requestID]);
              const metadata = object(object(data.form).metadata);
              const source = permission ? object(data.source) : metadata.kind === 'question' ? object(metadata.tool) : {};
              if (((event.type === 'permission.asked' && source.type === 'tool') || event.type === 'form.created')
                && typeof source.id === 'string' && typeof source.messageID === 'string') {
                interactionCalls.set(requestKey, { callID: source.id, messageID: source.messageID });
                record.interaction.relationSource = permission ? 'permission-source' : 'form-question-metadata';
              }
              const related = interactionCalls.get(requestKey);
              if (related) {
                record.callID = related.callID; record.messageID = related.messageID;
                if (record.interaction.phase !== 'requested') {
                  record.interaction.relationSource = permission ? 'permission-request-event' : 'form-request-event';
                }
              }
              if (!related) record.omissions.push('interaction-call-link-not-observed');
              if (record.interaction.phase !== 'requested') interactionCalls.delete(requestKey);
            }
            if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
              toolNames.delete(callKey); skillLoads.delete(callKey);
            }
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
              if (value !== null && !safeIdentifier(value, config.secrets, key === 'toolName')) {
                record[key] = null;
                record.omissions.push('unsafe-identifier');
              }
            }
            record.omissions = [...new Set(record.omissions)];
            record.redactions = [...new Set(record.redactions)];
            await append(record);
            if (record.skill?.id) await observeSkill(session, record.skill.id, record.eventID, record.messageID);
            if (event.type === 'session.inbox.enqueued' && durable?.version === 1 && object(data.item).type === 'user') {
              const skills = object(object(data.item).payload).skills;
              if (skills !== undefined) {
                if (!Array.isArray(skills)) {
                  await observe(session, { stage: 'admitted-skill', source: 'opencode.session.inbox.skills', identity: null,
                    eventID: record.eventID, messageID: record.messageID, observationTime: Date.now(),
                    omissions: ['unrecognized-admitted-skill-format'] }, null);
                } else for (const attachment of skills) {
                  const skill = object(attachment);
                  const recognized = typeof skill.id === 'string' && typeof skill.name === 'string' && typeof skill.text === 'string';
                  await observe(session, { stage: 'admitted-skill', source: 'opencode.session.inbox.skills',
                    identity: recognized ? String(skill.id) : null, eventID: record.eventID, messageID: record.messageID,
                    observationTime: Date.now(), omissions: recognized
                      ? ['admission-is-not-model-dispatch', 'skill-consumption-not-exposed'] : ['unrecognized-admitted-skill-format'] },
                  recognized ? { id: skill.id, name: skill.name, text: skill.text } : null);
                  if (recognized) await observeSkill(session, String(skill.id), record.eventID, record.messageID);
                }
              }
            }
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
        for (const hook of ['context', 'compaction', 'generate', 'title'] as const) await ctx.session.hook(hook, async event => {
          const { sessionID } = event;
          if (failed) return rejectFailedWork({ sessionID });
          try {
            const session = await ctx.session.get({ sessionID });
            if (!await inScope(session)) return;
            const observationTime = Date.now();
            const requestObservationID = randomUUID();
            const omissions = ['later-hooks-and-protocol-transforms-not-observed', 'request-execution-link-not-exposed',
              'request-options-not-captured', 'context-metadata-not-captured'];
            const system = event.system.map(part => {
              const instructions = object(object(part.metadata).experimental).instructions;
              if (!Array.isArray(instructions)) omissions.push('instruction-source-list-not-exposed');
              return { text: part.text, instructions: Array.isArray(instructions) ? instructions.flatMap(item => {
                const entry = object(item);
                if (typeof entry.key === 'string' && typeof entry.text === 'string') return [{ key: entry.key, text: entry.text }];
                omissions.push('unrecognized-instruction-source'); return [];
              }) : null };
            });
            const messages = event.messages.map(message => ({
              id: message.id && safeIdentifier(message.id, config.secrets) ? message.id : null,
              role: message.role, text: message.content.flatMap(part => {
                if (part.type === 'text') return [part.text];
                // Do not serialize reasoning, encrypted checkpoints, media, native/provider metadata or arbitrary results.
                omissions.push('non-text-context-part-not-captured'); return [];
              }),
            }));
            const tools = 'tools' in event ? event.tools : null;
            const agentID = 'agent' in event ? event.agent : null;
            await observe(session, { stage: 'context-hook', source: `opencode.session.hook.${hook}`, identity: hook,
              observationTime, requestObservationID, omissions }, {
              kind: hook === 'context' ? 'primary' : hook, agentID, model: { providerID: event.model.providerID, id: event.model.id },
              system, messages, tools, finalContext: false,
            });
            if (agentID) {
              const { data: agent } = await ctx.agent.get({ agentID });
              await observe(session, { stage: 'runtime-definition', source: 'opencode.agent.get', identity: agentID,
                observationTime: Date.now(), requestObservationID,
                omissions: ['agent-source-files-not-exposed', 'transform-attribution-not-exposed', 'agent-request-settings-not-captured'] },
              { id: agent.id, name: agent.name, mode: agent.mode, description: agent.description ?? null, system: agent.system ?? null });
            }
            const { data: skills } = await ctx.skill.list();
            await observe(session, { stage: 'availability', source: 'opencode.skill.list', identity: null,
              observationTime: Date.now(), requestObservationID,
              omissions: ['availability-is-not-activation-or-permission', 'unused-skill-content-not-captured'] },
            skills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description ?? null, autoinvoke: skill.autoinvoke ?? null })));
            const { data: plugins } = await ctx.plugin.list();
            await observe(session, { stage: 'environment', source: 'opencode.plugin.list', identity: null,
              observationTime: Date.now(), requestObservationID,
              omissions: ['plugin-registration-order-and-transform-attribution-not-exposed', 'plugin-local-versions-not-exposed',
                'configuration-sources-not-exposed', 'plugin-locators-and-options-not-captured'] },
            { plugins: plugins.map(plugin => ({ id: plugin.id ?? null, source: plugin.source.type,
              version: plugin.source.type === 'package' ? plugin.source.version ?? null : null, status: plugin.state.status })),
              configurationSources: null, transformations: null });
            if (hook === 'context') {
              const names = (await ctx.tool.list()).map(tool => tool.id);
              const modelNames = Object.keys(tools ?? {});
              const safe = (name: string) => safeIdentifier(name, config.secrets, true);
              await append({ type: 'recorder.tools.available', source: 'opencode.tool.list',
                projectID: safeIdentifier(session.projectID, config.secrets) ? session.projectID : null,
                sessionID: safeIdentifier(session.id, config.secrets) ? session.id : null,
                toolNames: names.filter(safe).sort(), modelToolNames: modelNames.filter(safe).sort(),
                omissions: [...names, ...modelNames].every(safe) ? [] : ['unsafe-identifier'] });
            }
          } catch {
            void fail('event-stream-or-persistence-failure');
            throw new Error('Recorder: context observation failed; pilot blocked.');
          }
        });
        const sdkVersion = await packageVersion(new URL('../../package.json', import.meta.resolve('@opencode/plugin')), '@opencode/plugin');
        const recorderVersion = await packageVersion(new URL('../package.json', import.meta.url), '@evagentic/recorder');
        await append({ type: 'recorder.ready', runtimeVersion: ctx.app.version, sdkVersion, recorderVersion,
          observationVersion: 1,
          versionSources: { runtime: 'ctx.app.version', sdk: sdkVersion ? 'resolved-package-manifest' : 'unknown',
            recorder: recorderVersion ? 'recorder-package-manifest' : 'unknown', hostSdk: null },
          coverage: { replay: false, content: ['admitted-user-text', 'completed-assistant-text', 'tool-input', 'tool-text-result',
            'session-permission-interactions', 'session-form-interactions', 'skill-load-results', 'admitted-skills',
            'selected-runtime-definitions', 'selected-project-skill-files', 'context-hook-text-and-tool-definitions',
            'session-hook.context.primary', 'session-hook.compaction', 'session-hook.generate', 'session-hook.title'],
            excluded: ['attachments', 'tool-internal-http', 'reasoning', 'headers', 'global-config', 'final-wire-context',
              'non-session-generation', 'websocket-frames', 'skill-lifecycle-compliance-and-cost',
              'post-hook-http-and-protocol-transforms', 'request-options', 'non-text-context-parts'],
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

function digest(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function packageVersion(path: URL, name: string) {
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    return manifest.name === name && typeof manifest.version === 'string'
      && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(manifest.version) ? manifest.version as string : null;
  } catch { return null; }
}

function safeIdentifier(value: string, secrets: string[], toolName = false) {
  return (toolName ? /^[A-Za-z0-9_.:-]{1,256}$/ : /^[A-Za-z0-9_-]{1,256}$/).test(value)
    && !secrets.some(secret => value.includes(secret));
}

function captureTool(record: CapturedEvent, data: Record<string, unknown>, secrets: string[]) {
  const version = record.sourceVersion;
  if (!['session.tool.input.started', 'session.tool.input.ended', 'session.tool.called',
    'session.tool.success', 'session.tool.failed'].includes(record.type)) return;
  const terminal = ['session.tool.success', 'session.tool.failed'].includes(record.type);
  if (version !== (terminal ? 2 : 1)) {
    record.status = 'unrecognized'; record.omissions = ['unrecognized-tool-format']; return;
  }
  const tool: ToolEvidence = { input: null, inputText: null, output: null, error: null,
    outcome: 'not-observed', executed: null, reportedError: null, retryOf: null, operationID: null, consumption: null };
  const text = (value: string) => {
    const result = redact(value, secrets);
    record.redactions.push(...result.reasons);
    return result.text;
  };
  try {
    if (record.type === 'session.tool.input.ended') {
      if (typeof data.text !== 'string') throw new Error('Unrecognized tool input');
      let parsed: unknown;
      let isJson = true;
      try { parsed = JSON.parse(data.text); } catch { isJson = false; }
      // Decode complete JSON before filtering: escaped literals must not bypass configured secrets.
      tool.inputText = isJson ? JSON.stringify(sanitizeJson(parsed, secrets, record.redactions)) : text(data.text);
      record.omissions.push(isJson ? 'tool-input-text-normalized-json' : 'tool-input-text-unparsed');
    }
    if (record.type === 'session.tool.called') {
      if (data.input === null || typeof data.input !== 'object' || Array.isArray(data.input)) throw new Error('Unrecognized input');
      tool.input = sanitizeJson(data.input, secrets, record.redactions);
    }
    if (record.type === 'session.tool.called' || terminal) {
      if (typeof data.executed !== 'boolean') throw new Error('Unrecognized executed flag');
      tool.executed = data.executed;
    }
    if (terminal) {
      const reportedError = object(data.metadata).error;
      tool.reportedError = typeof reportedError === 'boolean' ? reportedError : null;
      tool.outcome = record.type === 'session.tool.failed' || reportedError === true ? 'error' : 'success';
      if (data.content !== undefined) {
        if (!Array.isArray(data.content) || !data.content.length) throw new Error('Unrecognized content');
        tool.output = [];
        for (const item of data.content) {
          const part = object(item);
          if (part.type === 'text' && typeof part.text === 'string') tool.output.push({ type: 'text', text: text(part.text) });
          else if (part.type === 'file') record.omissions.push('tool-file-content-not-captured');
          else throw new Error('Unrecognized tool content');
        }
      } else if (record.type === 'session.tool.success') throw new Error('Missing result');
      if (record.type === 'session.tool.failed') {
        const error = object(data.error);
        if (typeof error.type !== 'string' || typeof error.message !== 'string') throw new Error('Unrecognized error');
        tool.error = { type: text(error.type), message: text(error.message) };
        if (Number.isSafeInteger(error.status) && Number(error.status) >= 100 && Number(error.status) <= 599) {
          tool.error.status = Number(error.status);
        }
      }
    }
    record.tool = tool;
    record.status = 'captured';
    record.omissions = record.omissions.filter(reason => reason !== 'event-payload-not-captured');
    record.omissions.push('tool-native-and-metadata-not-captured', 'tool-retry-relation-not-exposed', 'tool-consumption-not-exposed');
    record.redactions = [...new Set(record.redactions)];
  } catch {
    record.tool = null; record.status = 'unrecognized'; record.omissions = ['unrecognized-tool-format'];
  }
}

function captureInteraction(record: CapturedEvent, data: Record<string, unknown>, secrets: string[], formFields: Map<string, Set<string>>) {
  const permission = record.type.startsWith('permission.');
  if (!permission && !record.type.startsWith('form.')) return;
  const requested = ['permission.asked', 'form.created'].includes(record.type);
  const cancelled = record.type === 'form.cancelled';
  const form = object(data.form);
  const id = permission ? (requested ? data.id : data.requestID) : (requested ? form.id : data.id);
  const formKey = JSON.stringify([record.sessionID, id]);
  const interaction: NonNullable<CapturedEvent['interaction']> = {
    kind: permission ? 'permission' : 'form', requestID: null,
    phase: requested ? 'requested' : cancelled ? 'cancelled' : 'replied',
    origin: requested ? 'runtime-request' : cancelled ? 'runtime-cancellation' : 'external-reply-unattributed',
    relationSource: null, request: null, response: null,
  };
  try {
    if (record.sourceVersion !== null || typeof id !== 'string') throw new Error('Unsupported interaction format');
    if (safeIdentifier(id, secrets)) interaction.requestID = id;
    else record.omissions.push('unsafe-identifier');
    if (permission && requested) {
      if (typeof data.action !== 'string' || !Array.isArray(data.resources)
        || !data.resources.every(item => typeof item === 'string')) throw new Error('Unsupported permission');
      interaction.request = sanitizeJson({ action: data.action, resources: data.resources,
        ...(typeof data.message === 'string' ? { message: data.message } : {}),
        ...(Array.isArray(data.save) && data.save.every(item => typeof item === 'string') ? { save: data.save } : {}) },
      secrets, record.redactions);
    } else if (permission) {
      if (!['once', 'always', 'reject'].includes(String(data.reply))) throw new Error('Unsupported decision');
      interaction.response = sanitizeJson({ decision: data.reply }, secrets, record.redactions);
      record.omissions.push('permission-reply-message-not-exposed');
    } else if (requested) {
      if (typeof form.title !== 'string' || !Array.isArray(form.fields) || !form.fields.length) throw new Error('Unsupported form');
      const fields = form.fields.filter(item => {
        if (object(item).hidden !== true) return true;
        record.omissions.push('form-hidden-field-not-captured'); return false;
      }).map(item => {
        const field = object(item);
        if (!['string', 'number', 'integer', 'boolean', 'multiselect'].includes(String(field.type))
          || typeof field.key !== 'string') throw new Error('Unsupported field');
        return Object.fromEntries(['key', 'type', 'title', 'description', 'required', 'options', 'custom', 'when']
          .filter(key => Object.hasOwn(field, key)).map(key => [key, field[key]]));
      });
      interaction.request = sanitizeJson({ title: form.title, fields }, secrets, record.redactions);
      formFields.set(formKey, new Set(fields.map(field => String(field.key))));
      record.omissions.push('form-defaults-and-constraints-not-captured');
    } else if (!cancelled) {
      if (!data.answer || typeof data.answer !== 'object' || Array.isArray(data.answer)) throw new Error('Unsupported answer');
      const authorized = formFields.get(formKey);
      if (!authorized) record.omissions.push('form-request-not-observed-or-unrecognized');
      else {
        const entries = Object.entries(data.answer).filter(([key]) => authorized.has(key));
        if (entries.length !== Object.keys(data.answer).length) record.omissions.push('form-answer-fields-not-authorized');
        interaction.response = sanitizeJson(Object.fromEntries(entries), secrets, record.redactions);
      }
    }
    record.interaction = interaction;
    record.status = 'captured';
    record.omissions = record.omissions.filter(reason => reason !== 'event-payload-not-captured');
    record.omissions.push('interaction-metadata-not-captured', 'interaction-actor-not-exposed');
    if (cancelled) record.omissions.push('form-cancellation-message-not-exposed');
    if (!permission && !requested) formFields.delete(formKey);
  } catch {
    record.interaction = null; record.status = 'unrecognized'; record.omissions = ['unrecognized-interaction-format'];
  }
}

function sanitizeJson(value: unknown, secrets: string[], reasons: string[], depth = 0): Json {
  if (depth > 32) throw new Error('Unsupported content depth');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') {
    const result = redact(value, secrets); reasons.push(...result.reasons); return result.text;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeJson(item, secrets, reasons, depth + 1));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Unsupported JSON');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const safeKey = sanitizeJson(key, secrets, reasons, depth + 1) as string;
    if (/(?:^|[-_])(?:authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|private[_-]?key|passphrase|password|secret)$/i.test(key)) {
      reasons.push('credential-pattern'); return [safeKey, '[REDACTED]'];
    }
    return [safeKey, sanitizeJson(item, secrets, reasons, depth + 1)];
  }));
}

function redact(input: string, secrets: string[]) {
  let text = input;
  const reasons: string[] = [];
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (text.includes(secret)) { text = text.split(secret).join('[REDACTED]'); reasons.push('configured-literal'); }
  }
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    // Cookie values span semicolons, spaces and commas; include folded header continuations.
    /(?:\b|[_-])(?:set-cookie|cookie)["']?[ \t]*[=:][^\r\n]*(?:(?:\r\n|[\r\n])[ \t]+[^\r\n]*)*/gi,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/gi,
    /(?:\b|[_-])(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|private[_-]?key|passphrase|password|secret)["']?\s*[=:]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s,;]+)/gi,
  ];
  for (const pattern of patterns) {
    text = text.replace(pattern, () => { reasons.push('credential-pattern'); return '[REDACTED]'; });
  }
  return { text, reasons: [...new Set(reasons)] };
}
