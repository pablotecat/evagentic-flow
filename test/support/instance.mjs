import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.OPENCODE_TEST_BIN ?? (process.platform === 'win32'
  ? join(process.env.APPDATA, 'npm/node_modules/@opencode/cli/bin/opencode.exe') : 'opencode');
const temporary = process.env.OPENCODE_TEST_TMP ?? (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : process.env.TMPDIR ?? '/tmp');
let installed;

async function packagePlugin() {
  const root = await mkdtemp(join(temporary, 'recorder-package-'));
  const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const packed = JSON.parse(execFileSync(process.execPath,
    [npm, 'pack', '--json', '--pack-destination', root], { cwd: repository, encoding: 'utf8' }));
  execFileSync(process.execPath, [npm, 'install', '--offline', '--ignore-scripts', '--omit=dev',
    '--no-audit', '--no-fund', '--prefix', root, join(root, packed[0].filename)], { encoding: 'utf8' });
  return join(root, 'node_modules/@evagentic/recorder');
}

export async function eventually(check, message, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await delay(50);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}

export async function fixture(t, options = {}) {
  installed ??= packagePlugin();
  const plugin = await installed;
  const root = await mkdtemp(join(temporary, 'recorder-case-'));
  const projects = [join(root, 'project-a'), join(root, 'project-b')];
  for (const [index, directory] of projects.entries()) {
    await mkdir(directory);
    execFileSync('git', ['init', '--quiet', directory]);
    await writeFile(join(directory, 'README.md'), `Synthetic project ${index}\n`);
    execFileSync('git', ['-C', directory, 'add', 'README.md']);
    execFileSync('git', ['-C', directory, '-c', 'user.name=Synthetic', '-c',
      'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', `project ${index}`]);
  }
  if (options.projectAlias) {
    const target = projects[0];
    projects[0] = join(root, 'project-alias');
    await symlink(target, projects[0], process.platform === 'win32' ? 'junction' : 'dir');
  }
  const captureDirectory = join(root, 'capture');
  const configFile = join(root, 'recorder.local.json');
  const config = typeof options.config === 'function'
    ? await options.config({ root, projects, captureDirectory }) : options.config;
  await writeFile(configFile, JSON.stringify({ version: 1, projectDirectory: projects[options.projectIndex ?? 0],
    captureDirectory, secrets: [], ...config }));
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, {
    HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
    PROGRAMDATA: join(root, 'system'), TEMP: root, TMP: root, GIT_CONFIG_NOSYSTEM: '1',
    OPENCODE_DB: join(root, 'data/opencode/test.db'), EVAGENTIC_CONFIG: configFile,
    OPENCODE_PASSWORD: 'synthetic-instance-password',
  });
  await mkdir(join(root, 'config/opencode'), { recursive: true });
  await mkdir(join(root, 'config/opencode/plugins'));
  await writeFile(join(root, 'config/opencode/plugins/recorder.ts'),
    `export { default } from ${JSON.stringify(pathToFileURL(join(plugin, 'dist/index.js')).href)};\n`);
  if (options.syntheticTools) {
    await writeFile(join(root, 'config/opencode/plugins/zz-synthetic-tools.ts'), `
      import { Plugin } from '@opencode/plugin';
      export default Plugin.define({ id: 'synthetic.tools', async setup(ctx) {
        await ctx.tool.transform(editor => {
          editor.namespace({ name: 'synthetic.actions', description: 'Synthetic actions' });
          editor.add({ name: 'inspect', description: 'Synthetic inspection',
            options: { namespace: 'synthetic.actions', codemode: false },
            input: { type: 'object', properties: { mode: { type: 'string' }, payload: { type: 'object' } },
              required: ['mode', 'payload'], additionalProperties: false },
            execute: async (input, context) => {
              const cookieText = input.payload.cookieText ? '\\n' + input.payload.cookieText : '';
              if (input.mode === 'file') return { content: [{ type: 'file', uri: 'data:text/plain,synthetic-file-secret',
                mime: 'text/plain', name: 'synthetic-file-name' }] };
              if (input.mode === 'failure') throw new Error('Synthetic failure synthetic-secret-42 Bearer synthetic-error-token' + cookieText);
              if (input.mode === 'hold') await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
              if (input.mode === 'approval') await ctx.permission.assert({ sessionID: context.sessionID,
                source: { type: 'tool', messageID: context.messageID, id: context.id },
                action: 'synthetic.approval', resources: ['Synthetic resource synthetic-secret-42'],
                metadata: { ignored: 'synthetic-permission-metadata-secret' } });
              return { content: [{ type: 'text', text: 'Synthetic result synthetic-secret-42 Bearer synthetic-output-token' + cookieText }] };
            } });
          editor.add({ name: 'unused', description: 'Never invoked', options: { codemode: false },
            input: { type: 'object', properties: {} }, execute: async () => ({ content: 'Unused' }) });
        });
      } });
    `);
  }
  if (options.admissionGate) {
    // A second real plugin delays admission AFTER the recorder hook, without replacing it.
    await writeFile(join(root, 'config/opencode/plugins/zz-synthetic-admission.ts'), `
      import { Plugin } from '@opencode/plugin';
      import { readFile, writeFile } from 'node:fs/promises';
      import { setTimeout } from 'node:timers/promises';
      export default Plugin.define({ id: 'synthetic.admission', async setup(ctx) {
        await ctx.session.hook('prompt', async ({ prompt }) => {
          if (prompt.text !== 'SYNTHETIC_HELD_ADMISSION') return;
          await writeFile(${JSON.stringify(join(root, 'admission-entered'))}, 'entered');
          while (true) {
            try { await readFile(${JSON.stringify(join(root, 'admission-release'))}); return; }
            catch { await setTimeout(20); }
          }
        });
      } });
    `);
  }
  if (options.lateDescendant) {
    // A real plugin creates a descendant in reaction to the public failure notice.
    await writeFile(join(root, 'config/opencode/plugins/zz-synthetic-descendant.ts'), `
      import { Plugin } from '@opencode/plugin';
      export default Plugin.define({ id: 'synthetic.descendant', async setup(ctx) {
        const controller = new AbortController();
        let created = false;
        const task = (async () => {
          for await (const event of ctx.event.subscribe({ types: ['session.metadata.updated'], signal: controller.signal })) {
            if (created || !event.data.metadata?.evagenticRecorder) continue;
            const parent = await ctx.session.get({ sessionID: event.data.sessionID });
            if (parent.location.directory !== ctx.location.directory) continue;
            created = true;
            await ctx.session.create({ parentID: parent.id, location: { directory: ctx.location.directory },
              title: 'Synthetic late descendant', metadata: { syntheticLate: true } });
          }
        })().catch(() => {});
        return async () => { controller.abort(); await task; };
      } });
    `);
  }
  const serverConfig = { $schema: 'https://opencode.ai/config.json', update: 'disable',
    snapshots: false, ...options.serverConfig };
  let simulationLog = '';
  let simulationURL;
  if (options.simulation) {
    const simulation = spawn('postman', ['simulation', 'run',
      join(repository, 'postman/simulations/recorder/recorder.sim.yaml'),
      '--port', 'auto', '--output', 'ndjson', '--no-history'], { cwd: repository, env });
    let errors = '';
    simulation.stdout.on('data', chunk => { simulationLog += chunk; });
    simulation.stderr.on('data', chunk => { errors += chunk; });
    simulation.on('error', error => { errors += error.message; });
    t.after(async () => {
      if (simulation.exitCode === null && simulation.signalCode === null) {
        const exited = once(simulation, 'exit'); simulation.kill(); await exited;
      }
      await writeFile(join(root, 'sim.ndjson'), simulationLog);
      await writeFile(join(root, 'sim.err'), errors);
    });
    const listening = await eventually(() => {
      if (simulation.exitCode !== null) throw new Error(errors);
      return simulationLog.split('\n').filter(Boolean).map(line => JSON.parse(line))
        .find(event => event.event === 'listening' || event.type === 'listening');
    }, 'synthetic model simulation did not listen', 60000).catch(error => {
      throw new Error(`${error.message}: ${errors}`);
    });
    simulationURL = `http://127.0.0.1:${listening.port}/model`;
    const baseURL = `${simulationURL}/v1`;
    serverConfig.model = 'synthetic/synthetic';
    serverConfig.providers = { synthetic: { name: 'Synthetic',
      package: '@opencode/ai/providers/openai-compatible', settings: { baseURL, apiKey: 'synthetic-header-secret' },
      models: { synthetic: { name: 'Synthetic', limit: { context: 32000, output: 1000 } } } } };
    serverConfig.policies = [{ action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'synthetic', effect: 'allow' }];
  }
  await writeFile(join(root, 'config/opencode/opencode.json'), JSON.stringify(serverConfig));
  // Prove path isolation before opening a database or starting a server.
  for (const name of ['data', 'config', 'cache', 'state', 'db']) {
    const actual = execFileSync(binary, ['debug', 'paths', name], { env, cwd: root, encoding: 'utf8' }).trim();
    assert.ok(resolve(actual).startsWith(resolve(root)), `${name} escaped the isolated instance`);
  }
  let child;
  let output = '';
  let address;
  const start = async () => {
    output = '';
    child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { env, cwd: root });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => { output += error.message; });
    address = await eventually(() => {
      if (child.exitCode !== null) throw new Error(output);
      return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    }, 'isolated server did not listen');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  };
  t.after(stop);
  await start();
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${address}${path}`, { method,
      headers: { 'content-type': 'application/json',
        authorization: `Basic ${Buffer.from('opencode:synthetic-instance-password').toString('base64')}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    assert.ok(response.ok, `${response.status}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  }
  return { root, projects, captureDirectory, configFile, api, stop,
    restart: async () => { await stop(); await start(); }, output: () => output,
    simulationURL, simulationLog: () => simulationLog,
    plugins: async (directory = projects[0]) => (await api(`/api/plugin?location[directory]=${encodeURIComponent(directory)}`)).data };
}

// An independent consumer: only documented JSONL, never a recorder import or server database.
export async function records(directory) {
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const name of names.filter(name => name.endsWith('.jsonl')).sort()) {
    const text = await readFile(join(directory, name), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) result.push(JSON.parse(line));
  }
  return result;
}
