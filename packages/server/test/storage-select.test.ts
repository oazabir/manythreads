import { startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { POOL_MIN, STORAGE_PLUGIN_DIRS, poolMaxOf, storageFromEnv } from '../src/index.ts';

// P4-13: MANYTHREADS_STORAGE picks the one storage plugin that loads.

describe('storageFromEnv', () => {
  it('local by default, s3 on request, and anything else stops the start', () => {
    expect(storageFromEnv(undefined)).toBe('local');
    expect(storageFromEnv('')).toBe('local');
    expect(storageFromEnv(' LOCAL ')).toBe('local');
    expect(storageFromEnv('s3')).toBe('s3');
    expect(storageFromEnv('S3')).toBe('s3');
    for (const bad of ['minio', 'disk', 's3,local', 'true']) expect(() => storageFromEnv(bad), bad).toThrow(/must be "local" or "s3"/);
    expect(STORAGE_PLUGIN_DIRS).toEqual({ local: 'storage-local', s3: 'storage-s3' });
  });
});

describe('poolMaxOf', () => {
  it('uses the option, then the variable, then the default; ignores what is not a positive integer', () => {
    expect(poolMaxOf(7, '9', 10)).toEqual({ max: 7 });
    expect(poolMaxOf(undefined, '9', 10)).toEqual({ max: 9 });
    expect(poolMaxOf(undefined, 'abc', 10)).toEqual({ max: 10 });
    expect(poolMaxOf(undefined, '0', 10)).toEqual({ max: 10 });
  });
  it('raises a value below the minimum to it and says so', () => {
    const r = poolMaxOf(undefined, '1', 10, POOL_MIN.system, 'MANYTHREADS_SYSTEM_POOL_MAX');
    expect(r.max).toBe(3);
    expect(r.warning).toMatch(/MANYTHREADS_SYSTEM_POOL_MAX.*minimum 3/);
    expect(poolMaxOf(1, undefined, 10, POOL_MIN.app).max).toBe(2);
    expect(poolMaxOf(2, undefined, 10, POOL_MIN.app).warning).toBeUndefined();
  });
});

describe('plugin selection', () => {
  let s: TestServer | undefined;
  const saved = { ...process.env };
  afterEach(async () => {
    await s?.close();
    s = undefined;
    for (const k of Object.keys(process.env)) if (k.startsWith('MANYTHREADS_S3_') && !(k in saved)) delete process.env[k];
  });
  const loaded = (server: TestServer): string[] => server.host.plugins.map((p) => p.manifest.name).filter((n) => n.startsWith('storage-'));
  const providers = (server: TestServer): string[] => server.host.registries.providers['storage'].list().map((e) => `${e.plugin}:${e.value.id}`);

  it('loads storage-local and not storage-s3 by default (the environment cannot change a test server)', async () => {
    process.env['MANYTHREADS_STORAGE'] = 's3';
    try {
      s = await startTestServer();
    } finally {
      delete process.env['MANYTHREADS_STORAGE'];
    }
    expect(loaded(s)).toEqual(['storage-local']);
    expect(providers(s)).toEqual(['storage-local:local']);
  }, 120_000);

  it('loads storage-s3 and not storage-local with storage: "s3": exactly one storage provider', async () => {
    process.env['MANYTHREADS_S3_BUCKET'] = 'a-bucket';
    process.env['MANYTHREADS_S3_ENDPOINT'] = 'http://127.0.0.1:1';
    process.env['MANYTHREADS_S3_ACCESS_KEY'] = 'k';
    process.env['MANYTHREADS_S3_SECRET_KEY'] = 's';
    s = await startTestServer({ storage: 's3' });
    expect(loaded(s)).toEqual(['storage-s3']);
    expect(providers(s)).toEqual(['storage-s3:s3']);
  }, 120_000);

  it('does not start with storage "s3" and no bucket', async () => {
    delete process.env['MANYTHREADS_S3_BUCKET'];
    await expect(startTestServer({ storage: 's3' })).rejects.toThrow(/MANYTHREADS_S3_BUCKET/);
  }, 120_000);
});
