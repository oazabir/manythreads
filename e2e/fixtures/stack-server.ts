// One origin for browser specs: the built web client (clients/web/dist) and, behind /api, a real manythreads server on a
// fresh database. Started by fixtures/stack.ts (`tsx e2e/fixtures/stack-server.ts`), one per spec file, so a spec may change
// providers, workspace settings and conversations without disturbing the others. It prints one line,
// `MANYTHREADS_STACK {"origin":...,"ownerUrl":...}`, when it is ready, and drops its database (and its blob directory) on SIGTERM.
//
// Environment (all optional; fixtures/stack.ts `startStack(env)` passes them):
//   MANYTHREADS_STACK_SEED       what the database holds: `world` (default: seed v2, workspace, teams, seven personas), `content`
//                                (seed v3 on top: channels, messages, a thread, a DM, a 5,000-message channel, Lena's grant), `personas`
//                                (only the people, like the shared api server) or `none` (empty: the first-admin link is printed)
//   MANYTHREADS_STACK_API_ONLY   1: no web client needed (clients/web/dist may be missing); every non-API path is the client index or 404
//   MANYTHREADS_STACK_DEV_AUTH   1: the header actor of the api specs (`x-manythreads-dev-actor`, NODE_ENV=test only)
//   MANYTHREADS_STACK_TEST_PLUGINS 1: the test-kernel plugin (bulk messages, channel grants, stub resources)
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '@manythreads/server';
import { createPersonas, createTestDatabase, dropTestDatabase, parseBootstrapToken, withClusterLock } from '@manythreads/test-utils';
import { seedWorld } from './seed.ts';

const dist = resolve(fileURLToPath(new URL('../../clients/web/dist', import.meta.url)));
const apiOnly = process.env['MANYTHREADS_STACK_API_ONLY'] === '1';
if (!apiOnly && !existsSync(join(dist, 'index.html'))) {
  console.error(`clients/web/dist is not built (${dist}); run \`pnpm --filter @manythreads/web build\` first`);
  process.exit(1);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let apiPort = 0;
const isApi = (url: string): boolean => /^\/(api|healthz|readyz|ws)(\/|\?|$)/.test(url);

function proxy(req: IncomingMessage, res: ServerResponse): void {
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: apiPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '127.0.0.1' },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502).end();
  });
  req.pipe(upstream);
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
  let file = join(dist, path);
  // stay inside dist; unknown paths are client routes
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) file = join(dist, 'index.html');
  if (!existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}

/** The live socket (`/ws`): the upgrade is passed to the API as it came, then bytes flow both ways. */
function proxyUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
  const upstream = connect(apiPort, '127.0.0.1', () => {
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}

const front = createServer((req, res) => (isApi(req.url ?? '/') ? proxy(req, res) : serveStatic(req, res)));
front.on('upgrade', (req, socket, head) => (isApi(req.url ?? '/') ? proxyUpgrade(req, socket as Socket, head) : socket.destroy()));
await new Promise<void>((ok) => front.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;

const seedMode = process.env['MANYTHREADS_STACK_SEED'] ?? 'world';
if (!['none', 'world', 'content', 'personas'].includes(seedMode)) throw new Error(`MANYTHREADS_STACK_SEED: unknown mode "${seedMode}"`);
// Attachments (storage-local) go to a directory of this stack, removed on exit, never into the working tree.
const storageDir = process.env['MANYTHREADS_STORAGE_DIR'] ?? mkdtempSync(join(tmpdir(), 'manythreads-stack-blobs-'));
process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
// Team repositories (repo-git) likewise.
const repoDir = process.env['MANYTHREADS_REPO_DIR'] ?? mkdtempSync(join(tmpdir(), 'manythreads-stack-repos-'));
process.env['MANYTHREADS_REPO_DIR'] = repoDir;
const db = await createTestDatabase();
if (seedMode === 'personas') await createPersonas(db);
else if (seedMode !== 'none') await seedWorld(db);
const logs: string[] = [];
const token = process.env['MANYTHREADS_TEST_AUTH_TOKEN'] ?? 'e2e-test-auth-token';
const server = await startServer({
  port: 0,
  ownerUrl: db.ownerUrl,
  appUrl: db.appUrl,
  systemUrl: db.systemUrl,
  migrationLock: withClusterLock,
  publicUrl: origin,
  testAuthToken: token,
  trustProxy: 1,
  ...(process.env['MANYTHREADS_STACK_DEV_AUTH'] === '1' ? { devAuth: true } : {}),
  ...(process.env['MANYTHREADS_STACK_TEST_PLUGINS'] === '1' ? { testPlugins: true } : {}),
  logger: { level: 'info', stream: { write: (line: string) => void (logs.length < 2000 && logs.push(line)) } },
});
// The server's plugin migrations have run: now the conversations (seed v3 needs the channel tables).
if (seedMode === 'content') await seedWorld(db, { content: true });
apiPort = server.port;
console.log(`MANYTHREADS_STACK ${JSON.stringify({ origin, ownerUrl: db.ownerUrl, database: db.name, testAuthToken: token, bootstrapToken: parseBootstrapToken(logs) ?? null })}`);

let closing = false;
const stop = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  try {
    front.closeAllConnections();
    front.close();
    await server.close();
  } finally {
    await dropTestDatabase(db).catch(() => undefined);
    rmSync(storageDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    process.exit(0);
  }
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
