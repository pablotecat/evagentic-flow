import { mkdir, readFile, rename, writeFile, unlink as removeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const TERMINAL = new Set(['succeeded', 'failed', 'interrupted']);

export const isTerminal = execution => typeof execution?.status === 'string' && TERMINAL.has(execution.status);

export const commandMetadata = command => typeof command?.name === 'string' ? { name: command.name } : null;

export function createStore(dataDirectory) {
  const file = join(dataDirectory, 'executions.json');
  const review = join(dataDirectory, 'index-review-required');
  let failed = false;
  const executions = [];
  const byId = new Map();
  const byKey = new Map();
  let queue = Promise.resolve();
  const link = execution => {
    executions.push(execution);
    byId.set(execution.id, execution);
    byKey.set(execution.requestKey, execution);
  };
  const unlink = execution => {
    executions.splice(executions.indexOf(execution), 1);
    byId.delete(execution.id);
    byKey.delete(execution.requestKey);
  };
  const persist = (execution, changes) => {
    const pending = queue.then(async () => {
      if (failed) throw new Error('app index requires review');
      try {
        await access(review);
        const snapshot = executions.map(item => {
          const candidate = item === execution ? { ...item, ...changes } : item;
          return { ...candidate, requestedCommand: commandMetadata(candidate.requestedCommand) };
        });
        const temporary = `${file}.writing`;
        await writeFile(temporary, `${JSON.stringify({ version: 1, executions: snapshot }, null, 2)}\n`);
        await rename(temporary, file);
        if (execution) Object.assign(execution, changes);
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    queue = pending.catch(() => {});
    return pending;
  };
  return {
    async load() {
      try { await access(review); failed = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let text;
      try { text = await readFile(file, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (text !== undefined) {
        const parsed = JSON.parse(text);
        if (parsed?.version !== 1 || !Array.isArray(parsed.executions)
          || parsed.executions.some(execution => typeof execution?.id !== 'string'
            || typeof execution.requestKey !== 'string' || typeof execution.status !== 'string')) {
          throw new Error('invalid app store');
        }
        for (const execution of parsed.executions) link({ ...execution,
          requestedCommand: commandMetadata(execution.requestedCommand) });
      }
      if (!failed) {
        await mkdir(dataDirectory, { recursive: true });
        await writeFile(review, 'App index in use; review required after an unclean shutdown or persistence failure.\n', { flag: 'wx' });
      }
    },
    add: link,
    remove: unlink,
    save: () => persist(),
    update: (execution, changes) => persist(execution, changes),
    failed: () => failed,
    async close() {
      await queue;
      if (!failed) await removeFile(review);
    },
    byId: id => byId.get(id),
    byKey: key => byKey.get(key),
    list: () => executions.slice(),
  };
}
