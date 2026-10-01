// One origin for browser specs: the built web client (clients/web/dist) and, behind /api, a real manythreads server on a
// fresh database seeded with seed v2. Started by fixtures/stack.ts (`tsx e2e/fixtures/stack-server.ts`), one per spec file,
// so a spec may change providers and workspace settings without disturbing the others. It prints one line,
// `MANYTHREADS_STACK {"origin":...,"ownerUrl":...}`, when it is ready, and drops its database on SIGTERM.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '@manythreads/server';
import { createTestDatabase, dropTestDatabase, withClusterLock } from '@manythreads/test-utils';
import { seedWorld } from './seed.ts';

const dist = resolve(fileURLToPath(new URL('../../clients/web/dist', import.meta.url)));
if (!existsSync(join(dist, 'index.html'))) {
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
const isApi = (url: string): boolean => /^\/(api|healthz|readyz)(\/|\?|$)/.test(url);

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
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}

const front = createServer((req, res) => (isApi(req.url ?? '/') ? proxy(req, res) : serveStatic(req, res)));
await new Promise<void>((ok) => front.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;

const db = await createTestDatabase();
await seedWorld(db);
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
});
apiPort = server.port;
console.log(`MANYTHREADS_STACK ${JSON.stringify({ origin, ownerUrl: db.ownerUrl, database: db.name, testAuthToken: token })}`);

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
    process.exit(0);
  }
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
