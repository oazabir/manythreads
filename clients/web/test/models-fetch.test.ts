import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelFile, ModelSource } from '../scripts/fetch-models.mjs';
import { PENDING, ensureFile, fetchModels, fileUrl, parseArgs, parseLock, pendingFiles, servedPath } from '../scripts/fetch-models.mjs';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const REPO_LOCK = new URL('../models.lock.json', import.meta.url);
const NGINX = readFileSync(new URL('../../../deploy/docker/nginx.conf', import.meta.url), 'utf8');
const SW_SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'models-fetch-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A download that serves the given text for every address and counts the calls. */
const fakeOpen = (body: string) => {
  const calls: string[] = [];
  const open = async (url: string) => {
    calls.push(url);
    return (async function* () {
      // two chunks, so the hash is built across chunks
      yield Buffer.from(body.slice(0, 3));
      yield Buffer.from(body.slice(3));
    })();
  };
  return { open, calls };
};

const lockWith = (files: Array<{ path: string; sha256: string; bytes: number | string; serve?: string }>) => ({
  version: 1,
  sources: [{ name: 'tiny', kind: 'huggingface', repo: 'org/tiny', revision: 'a'.repeat(40), files }],
});

describe('the lock file in the repo', () => {
  const lock = parseLock(JSON.parse(readFileSync(REPO_LOCK, 'utf8')));

  it('is complete: every hash and size is recorded, nothing is PENDING', () => {
    expect(pendingFiles(lock)).toEqual([]);
  });

  it('pins a commit or an exact version, never a branch', () => {
    for (const s of lock.sources) {
      if (s.kind === 'huggingface') expect(s.revision).toMatch(/^[0-9a-f]{40}$/);
      else expect(s.revision).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('lists the files the speech engine needs', () => {
    const names = lock.sources.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['whisper-tiny', 'whisper-base', 'silero-vad', 'ort']));
    const tiny = lock.sources.find((s) => s.name === 'whisper-tiny');
    const served = tiny?.files.map((f) => f.serve ?? f.path) ?? [];
    expect(served).toEqual(expect.arrayContaining(['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx', 'config.json', 'tokenizer.json']));
  });
});

describe('parseLock', () => {
  it('refuses a path that climbs out of the folder, an absolute path and a bad hash', () => {
    const ok = { path: 'a.bin', sha256: sha('x'), bytes: 1 };
    expect(() => parseLock(lockWith([ok]))).not.toThrow();
    expect(() => parseLock(lockWith([{ ...ok, path: '../a.bin' }]))).toThrow(/unsafe path/);
    expect(() => parseLock(lockWith([{ ...ok, path: '/etc/passwd' }]))).toThrow(/unsafe path/);
    expect(() => parseLock(lockWith([{ ...ok, serve: 'a/../../b' }]))).toThrow(/unsafe serve path/);
    expect(() => parseLock(lockWith([{ ...ok, sha256: 'abc' }]))).toThrow(/bad sha256/);
    expect(() => parseLock(lockWith([{ ...ok, bytes: -1 }]))).toThrow(/bad size/);
  });
});

describe('addresses', () => {
  const lock = parseLock({
    version: 1,
    sources: [
      { name: 'tiny', kind: 'huggingface', repo: 'org/tiny', revision: 'abc123', files: [{ path: 'onnx/m.onnx', sha256: PENDING, bytes: PENDING }] },
      { name: 'ort', kind: 'npm', package: 'onnxruntime-web', revision: '1.2.3', files: [{ path: 'dist/r.wasm', serve: 'r.wasm', sha256: PENDING, bytes: PENDING }] },
    ],
  });
  const [hf, npm] = lock.sources as [ModelSource, ModelSource];
  const first = (s: ModelSource) => s.files[0] as ModelFile;

  it('builds the download address and the served address', () => {
    expect(fileUrl(hf, first(hf))).toBe('https://huggingface.co/org/tiny/resolve/abc123/onnx/m.onnx');
    expect(fileUrl(npm, first(npm))).toBe('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.2.3/dist/r.wasm');
    expect(servedPath(hf, first(hf))).toBe('tiny/abc123/onnx/m.onnx');
    expect(servedPath(npm, first(npm))).toBe('ort/1.2.3/r.wasm');
  });

  it('takes a mirror from the environment', () => {
    expect(fileUrl(hf, first(hf), { MANYTHREADS_MODELS_HF_BASE: 'http://mirror.local/hf/' })).toBe('http://mirror.local/hf/org/tiny/resolve/abc123/onnx/m.onnx');
  });

  it('reads the command line', () => {
    expect(parseArgs(['--pin', '--out', dir]).outDir).toBe(dir);
    expect(parseArgs([]).outDir.endsWith('clients/web/public/models')).toBe(true);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });
});

describe('ensureFile', () => {
  it('stores a file whose hash and size match', async () => {
    const dest = join(dir, 'a', 'b.bin');
    const { open, calls } = fakeOpen('hello world');
    const r = await ensureFile({ url: 'http://x/b', dest, sha256: sha('hello world'), bytes: 11, open });
    expect(r.status).toBe('fetched');
    expect(readFileSync(dest, 'utf8')).toBe('hello world');
    expect(calls).toEqual(['http://x/b']);
    expect(readdirSync(join(dir, 'a'))).toEqual(['b.bin']);
  });

  it('refuses a file whose hash does not match, and leaves nothing behind', async () => {
    const dest = join(dir, 'b.bin');
    const { open } = fakeOpen('tampered!!!');
    await expect(ensureFile({ url: 'http://x/b', dest, sha256: sha('hello world'), bytes: 11, open })).rejects.toThrow(/refusing .*expected sha256/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('refuses a file of the wrong size even when the hash is the one asked for', async () => {
    const dest = join(dir, 'b.bin');
    const { open } = fakeOpen('hello world');
    await expect(ensureFile({ url: 'http://x/b', dest, sha256: sha('hello world'), bytes: 99, open })).rejects.toThrow(/refusing/);
    expect(existsSync(dest)).toBe(false);
  });

  it('skips a file that is already there with the right hash', async () => {
    const dest = join(dir, 'b.bin');
    writeFileSync(dest, 'hello world');
    const { open, calls } = fakeOpen('something else');
    const r = await ensureFile({ url: 'http://x/b', dest, sha256: sha('hello world'), bytes: 11, open });
    expect(r.status).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('downloads again when the file on disk is damaged', async () => {
    const dest = join(dir, 'b.bin');
    writeFileSync(dest, 'hellX world');
    const { open, calls } = fakeOpen('hello world');
    const r = await ensureFile({ url: 'http://x/b', dest, sha256: sha('hello world'), bytes: 11, open });
    expect(r.status).toBe('fetched');
    expect(readFileSync(dest, 'utf8')).toBe('hello world');
    expect(calls).toHaveLength(1);
  });

  it('keeps a damaged file out of place when the new download is wrong too', async () => {
    const dest = join(dir, 'b.bin');
    writeFileSync(dest, 'old bytes!!');
    const { open } = fakeOpen('also wrong!');
    await expect(ensureFile({ url: 'http://x/b', dest, sha256: sha('hello world'), bytes: 11, open })).rejects.toThrow(/refusing/);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});

describe('fetchModels', () => {
  it('fetches every file once, then a second run downloads nothing', async () => {
    const lockPath = join(dir, 'lock.json');
    writeFileSync(lockPath, JSON.stringify(lockWith([{ path: 'a.txt', sha256: sha('hello world'), bytes: 11 }, { path: 'sub/b.txt', serve: 'b.txt', sha256: sha('hello world'), bytes: 11 }])));
    const out = join(dir, 'out');
    const first = fakeOpen('hello world');
    expect(await fetchModels({ lockPath, outDir: out, open: first.open })).toEqual({ fetched: 2, skipped: 0, pinned: 0 });
    expect(existsSync(join(out, 'tiny', 'a'.repeat(40), 'a.txt'))).toBe(true);
    expect(existsSync(join(out, 'tiny', 'a'.repeat(40), 'b.txt'))).toBe(true);
    const second = fakeOpen('hello world');
    expect(await fetchModels({ lockPath, outDir: out, open: second.open })).toEqual({ fetched: 0, skipped: 2, pinned: 0 });
    expect(second.calls).toEqual([]);
  });

  it('stops on the first mismatch', async () => {
    const lockPath = join(dir, 'lock.json');
    writeFileSync(lockPath, JSON.stringify(lockWith([{ path: 'a.txt', sha256: sha('something else'), bytes: 14 }])));
    await expect(fetchModels({ lockPath, outDir: join(dir, 'out'), open: fakeOpen('hello world').open })).rejects.toThrow(/refusing/);
  });

  it('refuses PENDING hashes without --pin and downloads nothing', async () => {
    const lockPath = join(dir, 'lock.json');
    writeFileSync(lockPath, JSON.stringify(lockWith([{ path: 'a.txt', sha256: PENDING, bytes: PENDING }])));
    const fake = fakeOpen('hello world');
    await expect(fetchModels({ lockPath, outDir: join(dir, 'out'), open: fake.open })).rejects.toThrow(/PENDING/);
    expect(fake.calls).toEqual([]);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).sources[0].files[0].sha256).toBe(PENDING);
  });

  it('with --pin records the seen hash and size in the lock, and the next plain run accepts them', async () => {
    const lockPath = join(dir, 'lock.json');
    writeFileSync(lockPath, JSON.stringify(lockWith([{ path: 'a.txt', sha256: PENDING, bytes: PENDING }])));
    const out = join(dir, 'out');
    expect(await fetchModels({ lockPath, outDir: out, pin: true, open: fakeOpen('hello world').open })).toEqual({ fetched: 1, skipped: 0, pinned: 1 });
    const written = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(written.sources[0].files[0]).toEqual({ path: 'a.txt', sha256: sha('hello world'), bytes: 11 });
    const again = fakeOpen('hello world');
    expect(await fetchModels({ lockPath, outDir: out, open: again.open })).toEqual({ fetched: 0, skipped: 1, pinned: 0 });
  });

  it('with --pin still checks the files that are already pinned', async () => {
    const lockPath = join(dir, 'lock.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify(lockWith([{ path: 'a.txt', sha256: sha('expected'), bytes: 8 }, { path: 'b.txt', sha256: PENDING, bytes: PENDING }])));
    await expect(fetchModels({ lockPath, outDir: join(dir, 'out'), pin: true, open: fakeOpen('hello world').open })).rejects.toThrow(/refusing/);
  });
});

describe('the web server and the service worker', () => {
  it('serves /models/ for a year, immutable, as a 404 when missing, with the right types', () => {
    const block = NGINX.slice(NGINX.indexOf('location /models/ {'), NGINX.indexOf('location = /mermaid-sandbox.html'));
    expect(block).toContain('expires 1y;');
    expect(block).toContain('add_header Cache-Control "public, immutable";');
    expect(block).toContain('application/wasm wasm;');
    expect(block).toContain('application/octet-stream onnx;');
    expect(block).toContain('try_files $uri =404;');
    // a 404 must not be cached for a year
    expect(block).not.toMatch(/Cache-Control[^\n]*always/);
  });

  it('lets the browser compile WebAssembly but still forbids eval, and keeps the microphone for this site', () => {
    const csp = NGINX.match(/add_header Content-Security-Policy "(default-src 'self'; script-src[^"]*)"/)?.[1] ?? '';
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' ");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(NGINX).toContain('add_header Permissions-Policy "microphone=(self), camera=(self)" always;');
  });

  it('the image fetches the models in a stage of its own and serves them at /models', () => {
    const dockerfile = readFileSync(new URL('../../../deploy/docker/web.Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('node clients/web/scripts/fetch-models.mjs --out /models');
    expect(dockerfile).toContain('COPY --from=models /models /usr/share/nginx/html/models');
    const ignore = readFileSync(new URL('../../../deploy/docker/web.Dockerfile.dockerignore', import.meta.url), 'utf8');
    expect(ignore).toContain('clients/web/public/models');
    expect(ignore.split('\n')).not.toContain('clients');
    expect(readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8')).toContain('clients/web/public/models/');
  });
});

describe('the service worker model cache', () => {
  type Listener = (event: unknown) => void;

  /** Runs sw.js against fake browser parts; returns what a fetch event does. */
  const run = (networkStatus = 200) => {
    const store = new Map<string, string>();
    const listeners: Record<string, Listener> = {};
    const netCalls: string[] = [];
    const cache = {
      match: async (r: { url: string }) => (store.has(r.url) ? { from: 'cache', url: r.url } : undefined),
      put: async (r: { url: string }) => void store.set(r.url, 'x'),
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (r: { url: string }) => store.delete(r.url),
    };
    const self = { location: { origin: 'https://site.test' }, addEventListener: (t: string, l: Listener) => (listeners[t] = l), skipWaiting() {}, clients: { claim() {} } };
    const fakeFetch = async (r: { url: string }) => {
      netCalls.push(r.url);
      return { status: networkStatus, from: 'network', clone: () => ({ status: networkStatus }) };
    };
    new Function('self', 'caches', 'fetch', 'URL', SW_SOURCE)(self, { open: async () => cache }, fakeFetch, URL);
    const dispatch = async (url: string, init: { method?: string; range?: boolean } = {}) => {
      let answer: Promise<unknown> | undefined;
      const waits: Promise<unknown>[] = [];
      listeners.fetch?.({
        request: { url, method: init.method ?? 'GET', headers: { has: (h: string) => h === 'range' && !!init.range } },
        respondWith: (p: Promise<unknown>) => (answer = p),
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      });
      const result = answer ? await answer : undefined;
      await Promise.all(waits);
      return result as { from?: string } | undefined;
    };
    return { store, netCalls, dispatch };
  };

  const A = 'https://site.test/models/whisper-tiny/rev1/onnx/enc.onnx';

  it('fetches a model file once, then answers from the cache', async () => {
    const sw = run();
    expect((await sw.dispatch(A))?.from).toBe('network');
    expect((await sw.dispatch(A))?.from).toBe('cache');
    expect(sw.netCalls).toEqual([A]);
  });

  it('does not keep a failed answer, a partial request, or a file that is not a model', async () => {
    const failing = run(404);
    await failing.dispatch(A);
    expect(failing.store.size).toBe(0);
    const sw = run();
    await sw.dispatch(A, { range: true });
    await sw.dispatch(A, { method: 'POST' });
    expect(await sw.dispatch('https://site.test/assets/app.js')).toBeUndefined();
    expect(await sw.dispatch('https://elsewhere.test/models/a/b/c.onnx')).toBeUndefined();
    expect(sw.store.size).toBe(0);
  });

  it('drops the older revisions of the same model when a new one is stored, and leaves other models alone', async () => {
    const sw = run();
    const other = 'https://site.test/models/whisper-base/rev1/onnx/enc.onnx';
    await sw.dispatch(A);
    await sw.dispatch(other);
    await sw.dispatch('https://site.test/models/whisper-tiny/rev2/onnx/enc.onnx');
    expect([...sw.store.keys()].sort()).toEqual([other, 'https://site.test/models/whisper-tiny/rev2/onnx/enc.onnx'].sort());
  });
});
