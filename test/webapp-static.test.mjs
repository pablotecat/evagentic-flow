import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('la app sirve la interfaz compilada bajo /next con redirección, MIME exacto y nosniff', async t => {
  await assertBuilt();
  const app = await startStaticApp(t);
  const redirect = await request(app.port, 'GET', '/next');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, '/next/');
  const index = await request(app.port, 'GET', '/next/');
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.match(index.body, /<div id="root">/);
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
    const response = await request(app.port, 'GET', `/next/${name}`);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers['content-type'], type, name);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', name);
    assert.equal(response.body, 'synthetic-static-fixture', name);
  }
  const assets = await request(app.port, 'GET', '/next/assets/');
  assert.equal(assets.status, 404);
});

test('la app rechaza recorridos fuera del directorio compilado y rutas o métodos desconocidos', async t => {
  await assertBuilt();
  const app = await startStaticApp(t);
  const traversals = ['/next/../server.mjs', '/next/../../package.json',
    '/next/%2e%2e/public/app.js', '/next/..%2fserver.mjs', '/next/%2e%2e%2f%2e%2e%2fpackage.json',
    '/next/%2e%2e%5cserver.mjs', '/next/..%5cserver.mjs', '/next/%00server.mjs', '/next/%ff%fe'];
  for (const path of traversals) {
    const response = await request(app.port, 'GET', path);
    assert.equal(response.status, 404, path);
    assert.ok(!response.body.includes('import'), path);
    assert.ok(!response.body.includes('dependencies'), path);
  }
  const unknown = await request(app.port, 'GET', '/next/does-not-exist.js');
  assert.equal(unknown.status, 404);
  const noExtension = await request(app.port, 'GET', '/next/unknown');
  assert.equal(noExtension.status, 404);
  const post = await request(app.port, 'POST', '/next/', { 'content-type': 'application/json' });
  assert.equal(post.status, 405);
  const put = await request(app.port, 'PUT', '/next/app.js');
  assert.equal(put.status, 405);
});

test('el guard de Host y Origin también protege /next y el cliente legado sigue intacto', async t => {
  await assertBuilt();
  const app = await startStaticApp(t);
  const foreignOrigin = await request(app.port, 'GET', '/next/', { origin: 'http://evil.example' });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(JSON.parse(foreignOrigin.body).error, 'origin-not-allowed');
  const foreignHost = await request(app.port, 'GET', '/next/', { host: 'evil.example:8080' });
  assert.equal(foreignHost.status, 403);
  const legacy = await request(app.port, 'GET', '/');
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(legacy.body, /Flujo en Proyecto/);
  const legacyScript = await request(app.port, 'GET', '/app.js');
  assert.equal(legacyScript.status, 200);
  assert.equal(legacyScript.headers['content-type'], 'text/javascript; charset=utf-8');
  const foreignLegacy = await request(app.port, 'GET', '/', { origin: 'http://evil.example' });
  assert.equal(foreignLegacy.status, 403);
});
