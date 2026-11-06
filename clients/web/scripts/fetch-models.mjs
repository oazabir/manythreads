/**
 * Fetches the speech model files the web image serves under `/models/` (PLAN P14-16).
 *
 * The files and their hashes are written down in `clients/web/models.lock.json`: for each source (a Hugging Face model repository at one commit,
 * or an npm package at one version) the list of files, each with its SHA-256 and size. This script downloads what is missing, checks every file
 * against the lock and refuses on a mismatch, so a changed or swapped file upstream never reaches an image. It runs at image build time and by
 * hand on a developer's machine (`pnpm models:fetch`); the browser never fetches model files from anywhere but this site.
 *
 * Files land at `<out>/<source name>/<revision>/<served path>`, so a new revision is a new address (the service worker and the browser keep
 * the old ones forever, `immutable`). A file that is already there with the right size and hash is left alone, so a second run downloads nothing.
 *
 * Plain Node, no dependencies: the web image's build stage runs it before any `pnpm install`. It lives under `clients/web/` and not `tools/`
 * because both Docker contexts for the web image (the Dockerfile's ignore file and the preview build job) leave `tools/` out.
 *
 * Usage:  node clients/web/scripts/fetch-models.mjs [--out <dir>] [--lock <file>] [--pin]
 *   --pin   for a new or changed revision: files whose `sha256` or `bytes` is "PENDING" are downloaded and the lock is rewritten with the
 *           values seen (trust on first use; review the diff against the upstream page before committing). Without it, PENDING is an error.
 * Air-gapped builds: MANYTHREADS_MODELS_HF_BASE and MANYTHREADS_MODELS_NPM_BASE replace the two download hosts with a mirror.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const PENDING = 'PENDING';
const HF_BASE = 'https://huggingface.co';
const NPM_BASE = 'https://cdn.jsdelivr.net/npm';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** A relative path of safe segments: no empty part, no `.` or `..`, no absolute or backslash form. */
const safePath = (/** @type {unknown} */ p) =>
  typeof p === 'string' && p.length > 0 && !p.includes('\\') && p.split('/').every((s) => SEGMENT.test(s) && s !== '..');

/**
 * Checks the lock file's shape and returns it. Throws a plain sentence naming the first thing wrong.
 * @param {unknown} raw
 * @returns {import('./fetch-models.mjs').ModelsLock}
 */
export function parseLock(raw) {
  const lock = /** @type {any} */ (raw);
  if (!lock || lock.version !== 1 || !Array.isArray(lock.sources)) throw new Error('models.lock.json: expected {"version": 1, "sources": [...]}');
  const names = new Set();
  for (const s of lock.sources) {
    if (!s || (s.kind !== 'huggingface' && s.kind !== 'npm')) throw new Error(`models.lock.json: source "${s?.name}" has no known kind`);
    if (!SEGMENT.test(s.name ?? '')) throw new Error(`models.lock.json: bad source name "${s.name}"`);
    if (names.has(s.name)) throw new Error(`models.lock.json: source "${s.name}" is listed twice`);
    names.add(s.name);
    if (!SEGMENT.test(s.revision ?? '')) throw new Error(`models.lock.json: ${s.name} has no usable revision`);
    if (s.kind === 'huggingface' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s.repo ?? '')) throw new Error(`models.lock.json: ${s.name} has a bad repo`);
    if (s.kind === 'npm' && !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(s.package ?? '')) throw new Error(`models.lock.json: ${s.name} has a bad package`);
    if (!Array.isArray(s.files) || s.files.length === 0) throw new Error(`models.lock.json: ${s.name} lists no files`);
    for (const f of s.files) {
      if (!safePath(f?.path)) throw new Error(`models.lock.json: ${s.name} has an unsafe path "${f?.path}"`);
      if (f.serve !== undefined && !safePath(f.serve)) throw new Error(`models.lock.json: ${s.name} has an unsafe serve path "${f.serve}"`);
      if (f.sha256 !== PENDING && !SHA256.test(f.sha256 ?? '')) throw new Error(`models.lock.json: ${s.name}/${f.path} has a bad sha256`);
      if (f.bytes !== PENDING && !(Number.isInteger(f.bytes) && f.bytes >= 0)) throw new Error(`models.lock.json: ${s.name}/${f.path} has a bad size`);
    }
  }
  return lock;
}

/**
 * Where a file comes from.
 * @param {import('./fetch-models.mjs').ModelSource} source
 * @param {import('./fetch-models.mjs').ModelFile} file
 * @param {Record<string, string | undefined>} [env]
 */
export function fileUrl(source, file, env = {}) {
  if (source.kind === 'huggingface') {
    const base = (env.MANYTHREADS_MODELS_HF_BASE || HF_BASE).replace(/\/+$/, '');
    return `${base}/${source.repo}/resolve/${source.revision}/${file.path}`;
  }
  const base = (env.MANYTHREADS_MODELS_NPM_BASE || NPM_BASE).replace(/\/+$/, '');
  return `${base}/${source.package}@${source.revision}/${file.path}`;
}

/** The path under the output folder, which is also the path under `/models/` on the web server. */
export const servedPath = (
  /** @type {import('./fetch-models.mjs').ModelSource} */ source,
  /** @type {import('./fetch-models.mjs').ModelFile} */ file,
) => `${source.name}/${source.revision}/${file.serve ?? file.path}`;

/** Every file of the lock still marked PENDING, as "name/path". */
export function pendingFiles(/** @type {import('./fetch-models.mjs').ModelsLock} */ lock) {
  return lock.sources.flatMap((s) => s.files.filter((f) => f.sha256 === PENDING || f.bytes === PENDING).map((f) => `${s.name}/${f.path}`));
}

/** SHA-256 and size of a file on disk. */
export async function hashFile(/** @type {string} */ path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(/** @type {Buffer} */ (chunk));
    bytes += /** @type {Buffer} */ (chunk).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** The real download: one HTTP GET, redirects followed, anything but 200 is an error. */
export async function openUrl(/** @type {string} */ url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  return Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (res.body));
}

/**
 * Makes one file exist at `dest` with the expected hash. Downloads into `dest.part`, hashes while writing, and moves it into place only when
 * it matches; on a mismatch the partial file is deleted and the call throws. With `expected` pending (pin mode) the seen values are returned.
 * @param {{ url: string, dest: string, sha256: string, bytes: number | string, open: (url: string) => Promise<AsyncIterable<Uint8Array>> }} job
 * @returns {Promise<{ status: 'skipped' | 'fetched', sha256: string, bytes: number }>}
 */
export async function ensureFile({ url, dest, sha256, bytes, open }) {
  const pinned = sha256 !== PENDING && bytes !== PENDING;
  if (pinned && existsSync(dest) && statSync(dest).size === bytes) {
    const seen = await hashFile(dest);
    if (seen.sha256 === sha256) return { status: 'skipped', ...seen };
  }
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const hash = createHash('sha256');
  let seenBytes = 0;
  try {
    const source = await open(url);
    await pipeline(
      Readable.from(source),
      async function* (/** @type {AsyncIterable<Uint8Array>} */ chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          seenBytes += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(part),
    );
    const seenHash = hash.digest('hex');
    if (pinned && (seenHash !== sha256 || seenBytes !== bytes)) {
      throw new Error(`refusing ${url}: expected sha256 ${sha256} (${bytes} bytes), got ${seenHash} (${seenBytes} bytes)`);
    }
    renameSync(part, dest);
    return { status: 'fetched', sha256: seenHash, bytes: seenBytes };
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}

/**
 * Fetches every file of the lock into `outDir`.
 * @param {{ lockPath: string, outDir: string, pin?: boolean, open?: (url: string) => Promise<AsyncIterable<Uint8Array>>, log?: (line: string) => void, env?: Record<string, string | undefined> }} options
 * @returns {Promise<{ fetched: number, skipped: number, pinned: number }>}
 */
export async function fetchModels({ lockPath, outDir, pin = false, open = openUrl, log = () => {}, env = {} }) {
  const lock = parseLock(JSON.parse(readFileSync(lockPath, 'utf8')));
  const pending = pendingFiles(lock);
  if (pending.length > 0 && !pin) {
    throw new Error(
      `models.lock.json still has PENDING hashes (${pending.slice(0, 3).join(', ')}${pending.length > 3 ? ', ...' : ''}). ` +
        'Run with --pin once to record them, review the diff, and commit the lock file.',
    );
  }
  let fetched = 0;
  let skipped = 0;
  let pinned = 0;
  for (const source of lock.sources) {
    for (const file of source.files) {
      const wasPending = file.sha256 === PENDING || file.bytes === PENDING;
      const dest = join(outDir, servedPath(source, file));
      const result = await ensureFile({ url: fileUrl(source, file, env), dest, sha256: file.sha256, bytes: file.bytes, open });
      if (wasPending) {
        file.sha256 = result.sha256;
        file.bytes = result.bytes;
        pinned += 1;
      }
      if (result.status === 'fetched') fetched += 1;
      else skipped += 1;
      log(`${result.status === 'fetched' ? 'fetched' : 'kept   '} ${servedPath(source, file)} (${result.bytes} bytes)`);
    }
  }
  if (pinned > 0) writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return { fetched, skipped, pinned };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = { lockPath: resolve(here, '../models.lock.json'), outDir: resolve(here, '../public/models'), pin: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') continue;
    else if (a === '--pin') args.pin = true;
    else if (a === '--out' || a === '--lock') {
      const value = argv[(i += 1)];
      if (!value) throw new Error(`${a} needs a value`);
      if (a === '--out') args.outDir = resolve(value);
      else args.lockPath = resolve(value);
    } else throw new Error(`unknown argument "${a}"`);
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await fetchModels({ ...args, log: (l) => console.log(l), env: process.env });
    console.log(`models: ${result.fetched} fetched, ${result.skipped} already in place${result.pinned ? `, ${result.pinned} pinned in the lock` : ''}`);
  } catch (err) {
    console.error(`models: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
