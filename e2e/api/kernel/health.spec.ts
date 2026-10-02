import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { HealthResponse, ReadyResponse } from '@manythreads/shared';

const repo = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const sqlFiles = (dir: string): number => readdirSync(dir).filter((f) => f.endsWith('.sql')).length;

test('GET /healthz is ok and the migration count equals the migration files', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  const health = HealthResponse.parse(await res.json());
  expect(health.status).toBe('ok');
  expect(health.plugins).toContain('test-kernel');
  const files =
    sqlFiles(repo('packages/kernel/migrations')) +
    health.plugins.reduce((n, name) => {
      try {
        return n + sqlFiles(repo(`packages/plugins/${name}/migrations`));
      } catch {
        return n; // plugin without migrations, or its folder name differs from its plugin name
      }
    }, 0);
  expect(health.migrations).toBe(files);
});

test('GET /readyz is ready with the same migration count', async ({ request }) => {
  const res = await request.get('/readyz');
  expect(res.status()).toBe(200);
  const ready = ReadyResponse.parse(await res.json());
  const health = HealthResponse.parse(await (await request.get('/healthz')).json());
  expect(ready.migrations).toBe(health.migrations);
});

test('GET /openapi.json is generated from the Zod schemas', async ({ request }) => {
  const doc = (await (await request.get('/openapi.json')).json()) as { paths: Record<string, unknown> };
  expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/healthz', '/readyz']));
});
