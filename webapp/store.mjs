import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const TERMINAL = new Set(['succeeded', 'failed', 'interrupted']);

export const isTerminal = execution => typeof execution?.status === 'string' && TERMINAL.has(execution.status);

export function createStore(dataDirectory) {
  const file = join(dataDirectory, 'executions.json');
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
  const persist = () => queue = queue.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.writing`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, executions }, null, 2)}\n`);
    await rename(temporary, file);
  });
  return {
    async load() {
      let text;
      try { text = await readFile(file, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const parsed = JSON.parse(text);
      if (parsed?.version !== 1 || !Array.isArray(parsed.executions)
        || parsed.executions.some(execution => typeof execution?.id !== 'string'
          || typeof execution.requestKey !== 'string' || typeof execution.status !== 'string')) {
        throw new Error('invalid app store');
      }
      for (const execution of parsed.executions) link(execution);
    },
    add: link,
    remove: unlink,
    save: () => persist(),
    drain: () => queue,
    byId: id => byId.get(id),
    byKey: key => byKey.get(key),
    list: () => executions.slice(),
  };
}
