import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BridgeConfig } from './config.ts';
import { profileFor } from './config.ts';
import { parseRunRequest } from './request.ts';
import { IdempotencyConflict, RunManager, TooManyRuns, UnknownProfile, type Run } from './runs.ts';
import { SessionStore } from './sessions.ts';

// The HTTP face: the subset of the Hermes gateway run API that the manythreads server uses.
//
//   GET  /health
//   POST /p/<profile>/v1/runs               { input, session_id?, instructions?, manythreads? }  -> 202 { run_id, status }
//   GET  /p/<profile>/v1/runs/<id>          -> { run_id, status, output, usage, error }
//   GET  /p/<profile>/v1/runs/<id>/events   server-sent events, resumable with ?last_seq= or Last-Event-ID
//   POST /p/<profile>/v1/runs/<id>/stop
//
// Every request carries `Authorization: Bearer <key>`.

export interface BridgeOptions {
  config: BridgeConfig;
  apiKey: string;
  stateDir: string;
  /** Default 127.0.0.1:8650; port 0 picks a free one. */
  host?: string;
  port?: number;
  log?: (line: string) => void;
  tmpRoot?: string;
  /** Seconds-level knobs, mostly for tests. Defaults: 10 s for the request headers, 30 s for a request body, 30 failed sign-ins a minute per address. */
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
  authFailLimit?: number;
}

export interface Bridge {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const KEEPALIVE_MS = 15_000;

class BodyTooLarge extends Error {}
class BodyTimeout extends Error {}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export function keyMatches(presented: string | undefined, key: string): boolean {
  const m = /^Bearer (.+)$/.exec(presented ?? '');
  // Both sides are hashed first so the comparison takes the same time whatever the lengths.
  const ok = timingSafeEqual(digest(m?.[1] ?? ''), digest(key));
  return ok && m !== null;
}

async function readBody(req: IncomingMessage, timeoutMs: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyTimeout()), timeoutMs);
  });
  const read = (async (): Promise<void> => {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_BODY_BYTES) throw new BodyTooLarge();
      chunks.push(buf);
    }
  })();
  read.catch(() => undefined); // when the timeout wins, the late outcome of the read is ignored
  try {
    await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

const fail = (res: ServerResponse, status: number, message: string, code: string, headers: Record<string, string> = {}): void =>
  send(res, status, { error: { message, code } }, headers);

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  if (options.apiKey.length < 16) throw new Error('the API key must be at least 16 characters');
  const log = options.log ?? ((line: string) => console.log(line));
  const sessions = new SessionStore(options.stateDir);
  const manager = new RunManager({ config: options.config, sessions, log, ...(options.tmpRoot !== undefined ? { tmpRoot: options.tmpRoot } : {}) });

  const bodyTimeoutMs = options.bodyTimeoutMs ?? 30_000;
  const authFailLimit = options.authFailLimit ?? 30;
  // Failed sign-ins per remote address in the last minute (in memory; a restart forgets them).
  const failures = new Map<string, number[]>();
  const recentFailures = (addr: string): number[] => {
    const cutoff = Date.now() - 60_000;
    const list = (failures.get(addr) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) failures.delete(addr);
    else failures.set(addr, list);
    return list;
  };
  const sweepFailures = setInterval(() => {
    for (const addr of [...failures.keys()]) recentFailures(addr);
  }, 60_000);
  sweepFailures.unref();

  const status = (run: Run): Record<string, unknown> => ({ run_id: run.id, status: run.status, output: run.output, usage: run.usage, error: run.error });

  async function stream(req: IncomingMessage, res: ServerResponse, run: Run, url: URL): Promise<void> {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': open\n\n');
    const raw = (req.headers['last-event-id'] as string | undefined) ?? url.searchParams.get('last_seq');
    let last: number | null = raw !== undefined && raw !== null && raw !== '' && Number.isInteger(Number(raw)) ? Number(raw) : null;
    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    let wake: (() => void) | null = null;
    const poke = (): void => wake?.();
    run.subscribers.add(poke);
    try {
      while (!closed) {
        for (const f of run.framesAfter(last)) {
          res.write(`id: ${f.seq}\ndata: ${JSON.stringify(f.data)}\n\n`);
          last = f.seq;
        }
        if (run.status !== 'running' && last !== null && last >= run.nextSeq - 1) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, KEEPALIVE_MS);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (!closed && run.framesAfter(last).length === 0 && run.status === 'running') res.write(': keepalive\n\n');
      }
      res.write(': stream closed\n\n');
      res.end();
    } finally {
      run.subscribers.delete(poke);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const addr = req.socket.remoteAddress ?? 'unknown';
    if (recentFailures(addr).length >= authFailLimit) return fail(res, 429, 'too many failed sign-ins from this address', 'too_many_failures', { 'retry-after': '60', connection: 'close' });
    if (!keyMatches(req.headers['authorization'], options.apiKey)) {
      failures.set(addr, [...recentFailures(addr), Date.now()]);
      return fail(res, 401, 'missing or wrong API key', 'unauthorized', { 'www-authenticate': 'Bearer' });
    }
    const url = new URL(req.url ?? '/', 'http://bridge');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/health' && method === 'GET') return send(res, 200, { status: 'ok', profiles: Object.keys(options.config.profiles) });

    const m = /^\/p\/([^/]+)\/v1\/runs(?:\/([^/]+)(\/events|\/stop)?)?$/.exec(path);
    if (!m) return fail(res, 404, 'not found', 'not_found');
    let profile: string;
    try {
      profile = decodeURIComponent(m[1]!);
    } catch {
      return fail(res, 400, 'bad profile name', 'bad_request');
    }
    if (!profileFor(options.config, profile)) return fail(res, 404, `no profile "${profile.slice(0, 64)}" and no default`, 'profile_not_found');
    const id = m[2];
    const tail = m[3];

    if (id === undefined) {
      if (method !== 'POST') return fail(res, 405, 'method not allowed', 'method_not_allowed');
      let raw: string;
      try {
        raw = await readBody(req, bodyTimeoutMs);
      } catch (err) {
        if (err instanceof BodyTooLarge) return fail(res, 413, 'the request body is over 1 MB', 'too_large', { connection: 'close' });
        if (err instanceof BodyTimeout) return fail(res, 408, 'the request body took too long', 'request_timeout', { connection: 'close' });
        throw err;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return fail(res, 400, 'the body is not JSON', 'bad_request');
      }
      const parsed = parseRunRequest(json);
      if (!parsed.ok) return fail(res, 400, parsed.error, 'bad_request');
      const keyHeader = req.headers['idempotency-key'];
      const key = typeof keyHeader === 'string' && keyHeader !== '' ? keyHeader.slice(0, 200) : null;
      try {
        const { run } = manager.create(profile, parsed.value, raw, key);
        return send(res, 202, { run_id: run.id, status: run.status });
      } catch (err) {
        if (err instanceof IdempotencyConflict) return fail(res, 409, 'that idempotency key was used with a different body', 'idempotency_conflict');
        if (err instanceof TooManyRuns) return fail(res, 429, 'the bridge is at its limit of runs at once', 'too_many_runs', { 'retry-after': '5' });
        if (err instanceof UnknownProfile) return fail(res, 404, 'no such profile', 'profile_not_found');
        throw err;
      }
    }

    const run = manager.get(profile, id);
    if (!run) return fail(res, 404, 'run not found', 'run_not_found');
    if (tail === '/events' && method === 'GET') return stream(req, res, run, url);
    if (tail === '/stop' && method === 'POST') {
      manager.stop(run);
      return send(res, 200, { run_id: run.id, status: run.status === 'running' ? 'stopping' : run.status });
    }
    if (tail === undefined && method === 'GET') return send(res, 200, status(run));
    return fail(res, 405, 'method not allowed', 'method_not_allowed');
  }

  const headersTimeoutMs = options.headersTimeoutMs ?? 10_000;
  const server: Server = createServer({ connectionsCheckingInterval: Math.max(100, Math.min(headersTimeoutMs, 5_000)) }, (req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`request failed: ${err instanceof Error ? err.name : 'error'}`);
      if (!res.headersSent) fail(res, 500, 'internal error', 'internal');
      else res.end();
    });
  });
  server.requestTimeout = 0; // event streams stay open; ordinary request bodies are bounded by bodyTimeoutMs instead
  server.headersTimeout = headersTimeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8650, options.host ?? '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 0);
  const host = options.host ?? '127.0.0.1';
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    port,
    close: async () => {
      clearInterval(sweepFailures);
      manager.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
