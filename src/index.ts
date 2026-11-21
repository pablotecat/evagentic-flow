import { Plugin } from '@opencode/plugin';
import { randomUUID } from 'node:crypto';
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
  executionID: null;
  messageID: string | null;
  ordinal: number | null;
  content: { role: 'user' | 'assistant'; text: string } | null;
  status: 'captured' | 'omitted' | 'unrecognized';
  omissions: string[];
  redactions: string[];
};

export default Plugin.define({
  id: 'evagentic.recorder',
  async setup(ctx) {
    if (ctx.app.version !== '2.1.2' || typeof ctx.event?.subscribe !== 'function'
      || typeof ctx.session?.get !== 'function') {
      throw new Error('Recorder: unsupported runtime; requires OpenCode V2 2.1.2.');
    }
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
    const project = await realpath(config.projectDirectory);
    if (!(await stat(project)).isDirectory()) throw new Error('Recorder: project is not a directory.');
    if (await realpath(ctx.location.directory) !== project) return;
    await mkdir(config.captureDirectory, { recursive: true, mode: 0o700 });
    const destination = await realpath(config.captureDirectory);
    const inside = relative(project, destination);
    if (!inside || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) {
      throw new Error('Recorder: capture destination must be outside the authorized project.');
    }
    const captureID = randomUUID();
    const pending = join(destination, `${captureID}.pending`);
    const journal = join(destination, `${captureID}.jsonl`);
    const file = await open(pending, 'wx', 0o600);
    let arrival = 0;
    let writes = Promise.resolve();
    const append = (record: Record<string, unknown>) => writes = writes.then(async () => {
      await file.appendFile(`${JSON.stringify({ schemaVersion: 1, captureID,
        arrival: ++arrival, observedAt: Date.now(), ...record })}\n`, 'utf8');
      // ponytail: fsync per event favors evidence over throughput; batching needs an explicit loss window.
      await file.sync();
    });
    const controller = new AbortController();
    let failed = false;
    const task = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
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
        if (session.projectID !== ctx.location.project.id
          || await realpath(session.location.directory) !== project) continue;
        const durable = 'durable' in event ? event.durable : undefined;
        const record: CapturedEvent = {
          type: event.type, source: 'opencode.event', eventID: event.id,
          sourceTime: event.created, sourceSequence: durable?.seq ?? null,
          sourceVersion: durable?.version ?? null, sourceAggregateID: durable?.aggregateID ?? null,
          projectID: session.projectID, sessionID: session.id, executionID: null,
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
        for (const key of ['eventID', 'sourceAggregateID', 'projectID', 'sessionID', 'messageID'] as const) {
          const value = record[key];
          if (value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)
            || config.secrets.some((secret: string) => value.includes(secret)))) {
            record[key] = null;
            record.omissions.push('unsafe-identifier');
          }
        }
        record.omissions = [...new Set(record.omissions)];
        await append(record);
      }
      if (!controller.signal.aborted) throw new Error('Event stream ended.');
    })().catch(async () => {
      if (controller.signal.aborted) return;
      failed = true;
      console.error('Recorder: capture failed; evidence is incomplete. Do not continue observed work.');
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
      promoted = true;
      if (failed) throw new Error('Subscription failed during preparation.');
    } catch {
      controller.abort();
      await task;
      await writes.catch(() => {});
      await file.close();
      if (promoted) await rename(journal, pending).catch(() => {});
      throw new Error('Recorder: capture destination failed the durable write check.');
    }
    return async () => {
      controller.abort();
      await task;
      await writes.catch(() => {});
      await file.close();
    };
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
