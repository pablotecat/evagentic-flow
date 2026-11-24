import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startApp } from '../../webapp/server.mjs';

export async function launchWebapp(t, instance, options = {}) {
  const configPath = join(instance.root, 'webapp.local.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    opencodeURL: instance.url(),
    opencodePassword: 'synthetic-instance-password',
    projectDirectory: instance.projects[options.projectIndex ?? 0],
    captureDirectory: instance.captureDirectory,
    dataDirectory: join(instance.root, 'webapp-data'),
    ...options.appConfig,
  }, null, 2));
  return { app: await startApp({ configPath, port: options.appPort }), configPath };
}

export async function appFetch(app, path, options = {}) {
  const response = await fetch(`${app.url}${path}`, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

export const createExecution = (app, requestKey, text) => appFetch(app, '/api/executions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ requestKey, text }),
});

export const executionDetail = (app, id) => appFetch(app, `/api/executions/${id}`);
