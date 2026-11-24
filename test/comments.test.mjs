import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBaseline, findComments, inventory } from '../scripts/lint-comments.mjs';

test('no-comments distingue comentarios de literales, regex, plantillas, JSX y JSONC', () => {
  const text = '#!/usr/bin/env node\n/** docs */\nconst url = "https://example.invalid"; // tail\n'
    + 'const regex = /[/*]/; const template = `// text ${1 /* expression */} /* text */`;\n'
    + 'function f(/* parameter */) { /* body */ }\n/* multi\nline */\n// eof';
  const comments = findComments('example.mjs', text);
  assert.deepEqual(comments.map(comment => comment.text),
    ['/** docs */', '// tail', '/* expression */', '/* parameter */', '/* body */', '/* multi\nline */', '// eof']);
  assert.equal(comments.reduce((sum, comment) => sum + comment.removableLines, 0), 4);
  assert.deepEqual(findComments('example.tsx',
    'const view = <div>// text {/* real */} /* text */</div>;').map(comment => comment.text), ['/* real */']);
  assert.deepEqual(findComments('example.jsonc', '{ "url": "https://example.invalid", /* real */ "x": 1 }')
    .map(comment => comment.text), ['/* real */']);
  assert.equal(findComments('example.ts', '\ufeff// head\r\nconst value = 1; // tail\r\n')[1].line, 2);
  assert.equal(findComments('example.ts', '/* multi\r\nline */')[0].hash,
    findComments('example.ts', '/* multi\nline */')[0].hash);
  assert.equal(findComments('example.ts', 'export interface Value { /* member */ x: number }').length, 1);
  assert.equal(findComments('example.js', '// only').length, 1);
  assert.throws(() => findComments('broken.ts', 'const = ;'), /invalid syntax/);
});

test('el presupuesto identifica texto y archivo, cuenta duplicados y exige retirar permisos obsoletos', () => {
  const [comment] = findComments('old.ts', '// old\n');
  const baseline = [{ file: comment.file, hash: comment.hash, count: 1 }];
  assert.equal(checkBaseline([comment], baseline).added.length, 0);
  assert.equal(checkBaseline(findComments('old.ts', '\n// old\n'), baseline).added.length, 0);
  assert.equal(checkBaseline(findComments('old.ts', '// new\n'), baseline).added.length, 1);
  assert.equal(checkBaseline(findComments('new.ts', '// old\n'), baseline).added.length, 1);
  assert.equal(checkBaseline([comment, comment], baseline).added.length, 1);
  assert.equal(checkBaseline([], baseline).stale.length, 1);
  assert.deepEqual(checkBaseline([], baseline).remaining, []);
  assert.throws(() => checkBaseline([], {}), /Invalid/);
  assert.throws(() => checkBaseline([], [...baseline, ...baseline]), /Duplicate/);
});

test('la CLI incluye archivos nuevos y ocultos, respeta Git y solo reduce el ratchet', async t => {
  const temporary = process.env.OPENCODE_TEST_TMP ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir());
  const root = await mkdtemp(join(temporary, 'comment-lint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  const text = '// old\nexport const value = 1;\n';
  await writeFile(join(root, 'old.ts'), text);
  await writeFile(join(root, '.gitignore'), 'ignored.js\n');
  await writeFile(join(root, 'ignored.js'), '// ignored\n');
  execFileSync('git', ['-C', root, 'add', 'old.ts']);
  const baseline = checkBaseline(findComments('old.ts', text), []).remaining;
  await writeFile(join(root, '.comment-baseline.json'), JSON.stringify(baseline));
  execFileSync('git', ['-C', root, 'add', '.comment-baseline.json']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
    'commit', '--quiet', '-m', 'Comment baseline']);
  const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const script = fileURLToPath(new URL('../scripts/lint-comments.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args, root], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.equal(run('--base', base).status, 0);
  await writeFile(join(root, '.new.mjs'), '// new\n');
  const rejected = run('--ratchet');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /\.new\.mjs:1:1: no-comments/);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.comment-baseline.json'), 'utf8')), baseline);
  const increased = checkBaseline((await inventory(root)).comments, []).remaining;
  await writeFile(join(root, '.comment-baseline.json'), JSON.stringify(increased));
  assert.equal(run().status, 0);
  assert.equal(run('--base', base).status, 1);
  assert.match(run('--base', base).stderr, /cannot increase/);
  await writeFile(join(root, '.comment-baseline.json'), JSON.stringify(baseline));
  await rm(join(root, '.new.mjs'));
  await writeFile(join(root, 'old.ts'), 'export const value = 1;\n');
  assert.equal(run().status, 1);
  assert.equal(run('--ratchet').status, 0);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.comment-baseline.json'), 'utf8')), []);
  assert.equal(run().status, 0);
  assert.equal(run('--base', base).status, 0);
  assert.equal(run('--base', 'missing-ref').status, 1);
  await rm(join(root, 'old.ts'));
  assert.deepEqual((await inventory(root)).comments, []);
  assert.equal(run('--unknown').status, 1);
});
