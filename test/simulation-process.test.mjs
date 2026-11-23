import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startSimulation } from './support/simulation.mjs';

const temporary = process.env.OPENCODE_TEST_TMP ?? (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : process.env.TMPDIR ?? '/tmp');

test('una salida terminal conserva diagnóstico y no espera el timeout de listening', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(temporary, 'recorder-process-'));
  const home = join(root, 'home');
  const env = {};
  const started = Date.now();
  await assert.rejects(startSimulation(t, { root, home, env, command: process.execPath,
    args: ['--input-type=module', '-e', `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      mkdirSync(join(process.env.HOME, '.postman/logs'), { recursive: true });
      writeFileSync(join(process.env.HOME, '.postman/logs/postman-cli.log'),
        '[dataset-engine] operation failed errno=EPERM debug=' + process.env.POSTMAN_CLI_DEBUG);
      process.stderr.write('Permission denied while accessing local dataset files\\n');
      process.exitCode = 1;
    `], timeout: 10000 }), /exited before listening.*code=1/s);
  assert.ok(Date.now() - started < 5000, 'terminal exit was swallowed by startup polling');
  assert.equal(env.POSTMAN_CLI_DEBUG, undefined, 'caller environment was mutated');
  assert.match(await readFile(join(root, 'sim.err'), 'utf8'), /Permission denied/);
  assert.match(await readFile(join(root, 'sim.cli.log'), 'utf8'), /errno=EPERM debug=1/);
  const diagnostic = JSON.parse(await readFile(join(root, 'sim.process.json'), 'utf8'));
  assert.ok(diagnostic.pid > 0);
  assert.equal(diagnostic.version, process.version);
  assert.equal(diagnostic.home, home);
  assert.equal(diagnostic.phase, 'before-listening');
  assert.equal(diagnostic.exitCode, 1);
});

test('ENOENT de spawn se distingue de un proceso que no emite listening', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(temporary, 'recorder-process-'));
  await assert.rejects(startSimulation(t, { root, home: join(root, 'home'), env: {},
    command: join(root, 'missing-postman'), timeout: 10000 }), /could not spawn simulation.*ENOENT/s);
  const diagnostic = JSON.parse(await readFile(join(root, 'sim.process.json'), 'utf8'));
  assert.equal(diagnostic.pid, null);
  assert.equal(diagnostic.spawnError.code, 'ENOENT');
  assert.equal(diagnostic.cliLog, null);
  assert.equal(diagnostic.version, null);
  assert.match(diagnostic.versionError, /ENOENT/);
});

test('un proceso vivo sin listening agota su plazo y queda terminado con evidencia', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(temporary, 'recorder-process-'));
  await assert.rejects(startSimulation(t, { root, home: join(root, 'home'), env: {},
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeout: 150 }),
  /startup timed out before listening/);
  const diagnostic = JSON.parse(await readFile(join(root, 'sim.process.json'), 'utf8'));
  assert.equal(diagnostic.phase, 'before-listening');
  assert.match(diagnostic.startupError, /startup timed out/);
  assert.ok(diagnostic.exitCode !== null || diagnostic.signal !== null);
  assert.throws(() => process.kill(diagnostic.pid, 0), { code: 'ESRCH' });
});

test('listening dividido entre escrituras arranca una sola vez sin mutar el entorno', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(temporary, 'recorder-process-'));
  const env = { POSTMAN_CLI_DEBUG: 'caller-value' };
  const simulation = await startSimulation(t, { root, home: join(root, 'home'), env,
    command: process.execPath, args: ['-e', `
      process.stderr.write('debug=' + process.env.POSTMAN_CLI_DEBUG);
      process.stdout.write('{"event":"listen');
      setTimeout(() => process.stdout.write('ing","port":43210}\\n'), 100);
      setInterval(() => {}, 1000);
    `] });
  assert.equal(simulation.port, 43210);
  assert.match(simulation.log(), /"event":"listening"/);
  assert.equal(env.POSTMAN_CLI_DEBUG, 'caller-value');
  await simulation.stop();
  assert.equal(await readFile(join(root, 'sim.err'), 'utf8'), 'debug=1');
  const diagnostic = JSON.parse(await readFile(join(root, 'sim.process.json'), 'utf8'));
  assert.equal(diagnostic.phase, 'listening');
});

test('terminación por el OS antes de listening también es terminal', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(temporary, 'recorder-process-'));
  const started = Date.now();
  await assert.rejects(startSimulation(t, { root, home: join(root, 'home'), env: {},
    command: process.execPath, args: ['-e', "process.kill(process.pid, 'SIGTERM')"], timeout: 10000 }),
  /exited before listening/);
  assert.ok(Date.now() - started < 5000);
  const diagnostic = JSON.parse(await readFile(join(root, 'sim.process.json'), 'utf8'));
  assert.equal(diagnostic.phase, 'before-listening');
  assert.ok(diagnostic.exitCode !== null || diagnostic.signal !== null);
});

test('un log de CLI inaccesible no oculta el fallo de arranque ni pierde PID y versión', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(temporary, 'recorder-process-'));
  await assert.rejects(startSimulation(t, { root, home: join(root, 'home'), env: {},
    command: process.execPath, args: ['--input-type=module', '-e', `
      import { mkdirSync } from 'node:fs';
      import { join } from 'node:path';
      mkdirSync(join(process.env.HOME, '.postman/logs/postman-cli.log'), { recursive: true });
      process.stderr.write('Synthetic startup failure');
      process.exitCode = 1;
    `] }), /exited before listening.*Synthetic startup failure/s);
  const diagnostic = JSON.parse(await readFile(join(root, 'sim.process.json'), 'utf8'));
  assert.ok(diagnostic.pid > 0);
  assert.equal(diagnostic.version, process.version);
  assert.equal(diagnostic.cliLog, null);
  assert.ok(diagnostic.cliLogError.code);
});
