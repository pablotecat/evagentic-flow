import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../webapp/server.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'webapp', 'dist');

async function startStaticApp(t) {
  const temporary = process.env.OPENCODE_TEST_TMP ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir());
  const root = await mkdtemp(join(temporary, 'webapp-static-'));
  const project = join(root, 'project');
  const capture = join(root, 'capture');
  const data = join(root, 'data');
  await Promise.all([project, capture, data].map(directory => mkdir(directory, { recursive: true })));
  const configPath = join(root, 'app.local.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    opencodeURL: 'http://127.0.0.1:1',
    opencodePassword: 'synthetic-password',
    projectDirectory: project,
    captureDirectory: capture,
    dataDirectory: data,
  }));
  const app = await startApp({ configPath });
  t.after(() => app.close());
  return app;
}

const request = (port, method, path, headers = {}) => new Promise((resolve, reject) => {
  const done = response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
      body: Buffer.concat(chunks).toString('utf8') }));
  };
  const client = http.request({ host: '127.0.0.1', port, method, path, headers }, done);
  client.once('error', reject);
  client.end();
});

const assertBuilt = async () => {
  try { await access(join(dist, 'index.html')); }
  catch { assert.fail('webapp/dist/index.html does not exist: run npm run build before this test'); }
};

test('la app sirve la interfaz compilada en / con MIME exacto y nosniff', async t => {
  await assertBuilt();
  const app = await startStaticApp(t);
  const index = await request(app.port, 'GET', '/');
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.match(index.body, /<div id="root">/);
  const byName = await request(app.port, 'GET', '/index.html');
  assert.equal(byName.status, 200);
  assert.equal(byName.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(byName.headers['x-content-type-options'], 'nosniff');
  assert.equal(byName.body, index.body);
  const fixtures = [
    ['app.js', 'text/javascript; charset=utf-8'],
    ['module.mjs', 'text/javascript; charset=utf-8'],
    ['styles.css', 'text/css; charset=utf-8'],
    ['logo.svg', 'image/svg+xml'],
    ['data.json', 'application/json; charset=utf-8'],
    ['image.png', 'image/png'],
    ['favicon.ico', 'image/x-icon'],
    ['font.woff', 'font/woff'],
    ['font.woff2', 'font/woff2'],
    ['bundle.js.map', 'application/json; charset=utf-8'],
  ];
  for (const [name] of fixtures) await writeFile(join(dist, name), 'synthetic-static-fixture');
  t.after(async () => {
    for (const [name] of fixtures) await rm(join(dist, name), { force: true });
  });
  for (const [name, type] of fixtures) {
    const response = await request(app.port, 'GET', `/${name}`);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers['content-type'], type, name);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', name);
    assert.equal(response.body, 'synthetic-static-fixture', name);
  }
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'assets', 'compiled.js'), 'synthetic-asset-fixture');
  t.after(async () => { await rm(join(dist, 'assets', 'compiled.js'), { force: true }); });
  const asset = await request(app.port, 'GET', '/assets/compiled.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(asset.headers['x-content-type-options'], 'nosniff');
  assert.equal(asset.body, 'synthetic-asset-fixture');
  const assets = await request(app.port, 'GET', '/assets/');
  assert.equal(assets.status, 404);
});

test('la app rechaza recorridos fuera del directorio compilado y rutas o métodos desconocidos', async t => {
  await assertBuilt();
  const app = await startStaticApp(t);
  const traversals = ['/../server.mjs', '/../../package.json',
    '/%2e%2e/server.mjs', '/..%2fserver.mjs', '/%2e%2e%2f%2e%2e%2fpackage.json',
    '/%2e%2e%5cserver.mjs', '/..%5cserver.mjs', '/assets%5c..%5cindex.html',
    '/index.html%5c..', '/%00server.mjs', '/%ff%fe', '//server.mjs', '/%2f%2fserver.mjs'];
  for (const path of traversals) {
    const response = await request(app.port, 'GET', path);
    assert.equal(response.status, 404, path);
    assert.ok(!response.body.includes('import'), path);
    assert.ok(!response.body.includes('dependencies'), path);
  }
  const unknown = await request(app.port, 'GET', '/does-not-exist.js');
  assert.equal(unknown.status, 404);
  const noExtension = await request(app.port, 'GET', '/unknown');
  assert.equal(noExtension.status, 404);
  const retired = [
    ['/app.js', 'the legacy client script is still served'],
    ['/styles.css', 'the legacy client stylesheet is still served'],
    ['/next', 'the retired parallel route still answers'],
    ['/next/', 'the retired parallel route still answers'],
    ['/next/index.html', 'the retired parallel route still answers'],
  ];
  for (const [path, message] of retired) {
    const response = await request(app.port, 'GET', path);
    assert.equal(response.status, 404, message);
  }
  const legacyGone = await request(app.port, 'GET', '/index.html');
  assert.ok(legacyGone.body.includes('<div id="root">'), 'the compiled React app root disappeared from /index.html');
  assert.ok(!legacyGone.body.includes('/styles.css'), 'the legacy stylesheet reference appeared in /index.html');
  const post = await request(app.port, 'POST', '/', { 'content-type': 'application/json' });
  assert.equal(post.status, 405);
  const put = await request(app.port, 'PUT', '/app.js');
  assert.equal(put.status, 405);
  const apiUntouched = await request(app.port, 'GET', '/api/health');
  assert.equal(apiUntouched.status, 200);
});

test('el guard de Host y Origin también protege la interfaz compilada', async t => {
  await assertBuilt();
  const app = await startStaticApp(t);
  const foreignOrigin = await request(app.port, 'GET', '/', { origin: 'http://evil.example' });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(JSON.parse(foreignOrigin.body).error, 'origin-not-allowed');
  const foreignHost = await request(app.port, 'GET', '/', { host: 'evil.example:8080' });
  assert.equal(foreignHost.status, 403);
  const foreignAsset = await request(app.port, 'GET', '/assets/missing.js', { origin: 'http://evil.example' });
  assert.equal(foreignAsset.status, 403);
});

test('el servido estático rechaza enlaces simbólicos que escapen de webapp/dist', async t => {
  await assertBuilt();
  const app = await startStaticApp(t);
  const temporary = process.env.OPENCODE_TEST_TMP ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir());
  const outside = await mkdtemp(join(temporary, 'webapp-static-escape-'));
  await writeFile(join(outside, 'secret.js'), 'synthetic-escaped-secret');
  const linkDir = join(dist, '__test-escape-link');
  await symlink(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(async () => {
    await rm(linkDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const escaped = await request(app.port, 'GET', '/__test-escape-link/secret.js');
  assert.equal(escaped.status, 404);
  assert.ok(!escaped.body.includes('synthetic-escaped-secret'));
});
