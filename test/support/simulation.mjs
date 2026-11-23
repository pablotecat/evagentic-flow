import { execFileSync, spawn } from 'node:child_process';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repository = fileURLToPath(new URL('../../', import.meta.url));

// Only the simulation process boundary: no recorder or OpenCode substitutes.
export async function startSimulation(t, { root, home, env, command = 'postman',
  args = ['simulation', 'run', join(repository, 'postman/simulations/recorder/recorder.sim.yaml'),
    '--port', 'auto', '--output', 'ndjson', '--no-history'], timeout = 60000 }) {
  const childEnv = { ...env, HOME: home, USERPROFILE: home, POSTMAN_CLI_DEBUG: '1' };
  const started = Date.now();
  const child = spawn(command, args, { cwd: repository, env: childEnv });
  let output = '', errors = '', spawnError, startupError, closed = false, listening, cleanup;
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  child.on('error', error => { spawnError = error; errors += error.message; });
  // close, unlike exit, guarantees that the trailing stderr has been drained.
  const drained = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  const stop = () => cleanup ??= (async () => {
    if (!closed) child.kill();
    await drained;
    await writeFile(join(root, 'sim.ndjson'), output);
    await writeFile(join(root, 'sim.err'), errors);
    let cliLog = 'sim.cli.log', cliLogError;
    try { await copyFile(join(home, '.postman/logs/postman-cli.log'), join(root, cliLog)); }
    catch (error) { cliLog = null; cliLogError = { code: error.code, message: error.message }; }
    let version = null, versionError;
    try { version = execFileSync(command, ['--version'], {
      cwd: repository, env: childEnv, encoding: 'utf8', timeout: 10000 }).trim(); }
    catch (error) { versionError = error.message; }
    await writeFile(join(root, 'sim.process.json'), JSON.stringify({
      command, args, pid: child.pid ?? null, home, version, versionError,
      nodeVersion: process.version, platform: process.platform, osRelease: release(), startupError,
      phase: listening ? 'listening' : 'before-listening',
      started: new Date(started).toISOString(), elapsedMs: Date.now() - started,
      exitCode: child.exitCode, signal: child.signalCode,
      spawnError: spawnError && { code: spawnError.code, message: spawnError.message }, cliLog, cliLogError,
    }, null, 2));
  })();
  t.after(stop);
  try {
    while (true) {
      if (spawnError) throw new Error(`could not spawn simulation: ${spawnError.message}`);
      if (closed) throw new Error(`simulation exited before listening (code=${child.exitCode}, signal=${child.signalCode})`);
      // Never parse a partial NDJSON line delivered in a separate pipe chunk.
      listening = output.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line))
        .find(event => event.event === 'listening' || event.type === 'listening');
      if (listening) return { port: listening.port, log: () => output, stop };
      if (Date.now() - started >= timeout) throw new Error('simulation startup timed out before listening');
      await delay(50);
    }
  } catch (error) {
    startupError = error.message;
    await stop();
    throw new Error(`${error.message}; evidence: ${root}\n${errors}`, { cause: error });
  }
}
