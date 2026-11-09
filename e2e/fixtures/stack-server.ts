// One origin for browser specs: the built web client (clients/web/dist) and, behind /api, a real manythreads server on a
// fresh database. Started by fixtures/stack.ts (`tsx e2e/fixtures/stack-server.ts`), one per spec file, so a spec may change
// providers, workspace settings and conversations without disturbing the others. It prints one line,
// `MANYTHREADS_STACK {"origin":...,"ownerUrl":...}`, when it is ready, and drops its database (and its blob directory) on SIGTERM.
//
// Environment (all optional; fixtures/stack.ts `startStack(env)` passes them):
//   MANYTHREADS_STACK_SEED       what the database holds: `world` (default: seed v2, workspace, teams, seven personas), `content`
//                                (seed v3 on top: channels, messages, a thread, a DM, a 5,000-message channel, Lena's grant), `repo` (seed v4
//                                on top of that: each team repo's pages, CSV, diagram, app, memory and bot placeholder, and a PDF, PNG, MP4
//                                and Office file in #dev), `guard` (seed v5 on top of that: the `standard` preset and the `local` alias bound to a model
//                                on this machine, so the gate's classifier has an alias to ask), `work` (seed v4 plus seed v6: the Engineering board and
//                                Bot Board, a heartbeat and a routine that are switched off, the routine's output page, the protected `production`
//                                environment), `polish` (seed v3 and v4 plus seed v21, opt-in: `#polish` for the look checks of Phase 21 - a run of twelve
//                                messages, a 40-line one, an Answer with three citations, a thread of seven), `meetings` (seed v3 and v4 plus seed v15, opt-in: three
//                                finished calls - a public stand-up with notes and memory, a private call, a note-taker call - see packages/test-utils/src/seed-meetings.ts),
//                                `connectors` (seed v3 and v4 plus seed v16, opt-in: tools/fake-saas is started in this process and its fake bases and app ids are put in the environment before
//                                the server starts; then `#design` with a planned room, sealed Google sign-ins of Nadia and Rafi and a Microsoft one of Lena, a Zendesk work-app address in #support,
//                                Telegram on with Nadia linked, and a Drive folder read into the Engineering `handbook` base - see packages/test-utils/src/seed-connectors.ts), `personas`
//                                (only the people, like the shared api server) or `none` (empty: the first-admin link is printed)
//                                `runners` (seed v3 and v4 plus seed v19, opt-in: a populated Runners page - host, team pod, two Claude runners, an LLM gateway runner and a Codex runner
//                                waiting for sign-in, all with made-up sign-ins - see packages/test-utils/src/seed-runners.ts)
//   MANYTHREADS_STACK_SNAPSHOT   `day-1` or `week-2` (P12-02): restore the saved database and folders (tools/seed/src/restore.ts) instead of running a seed; the seed modes then do nothing.
//   MANYTHREADS_STACK_API_ONLY   1: no web client needed (clients/web/dist may be missing); every non-API path is the client index or 404
//   MANYTHREADS_STACK_DEV_AUTH   1: the header actor of the api specs (`x-manythreads-dev-actor`, NODE_ENV=test only)
//   MANYTHREADS_STACK_TEST_PLUGINS 1: the test-kernel plugin (bulk messages, channel grants, stub resources)
//   MANYTHREADS_STACK_MEETINGS   1 (or the `meetings` seed): the voice-room stand-ins of the meeting specs - the fake media provider, the fake server ASR, a Hermes command that answers
//                                the meeting prompts (e2e/fixtures/meeting-hermes.mjs), the test plugins and the dev actor header. Anything the caller sets stays as it is.
//   MANYTHREADS_STACK_FAKE_SAAS  1 (or the `connectors` seed): start tools/fake-saas (Google, Microsoft, Notion, trackers, support, Telegram, Slack, Teams, WhatsApp, Confluence, Dropbox, Box and
//                                the signed-webhook sender) in this process, with the sign-ins of the `connectors` seed, and give the server its app ids and fake bases. The ready line then carries
//                                `fakeSaas` (the control address, the seed key, the variables) for a spec to drive the stand-ins.
//   MANYTHREADS_LINK_PREVIEW     `off` (the default here: NODE_ENV is `test`, and fixtures/stack.ts sends `off`) or `on`: whether the server reads the pages of
//                                the links in posted messages (P14-08). A spec that posts links and does not test previews must leave it off.
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '@manythreads/server';
import { createPersonas, createTestDatabase, dropTestDatabase, parseBootstrapToken, seedConnectors, seedFinishedSetup, seedMeetings, seedPolish, seedRunners, SEED_CONNECTORS, withClusterLock, type SeedConnectorsResult } from '@manythreads/test-utils';
import type { FakeSaas } from '../../tools/fake-saas/src/index.ts';
import { restoreSnapshot } from '../../tools/seed/src/restore.ts';
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
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let apiPort = 0;
// `/mcp` is the one address every bot calls; like deploy/docker/nginx.conf (`location = /mcp`), only that exact path goes to the server.
const isApi = (url: string): boolean => /^\/(api|healthz|readyz|ws|hooks)(\/|\?|$)/.test(url) || /^\/mcp(\?|$)/.test(url);

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
if (!['none', 'world', 'content', 'repo', 'guard', 'work', 'polish', 'meetings', 'connectors', 'runners', 'personas'].includes(seedMode)) throw new Error(`MANYTHREADS_STACK_SEED: unknown mode "${seedMode}"`);
// The meeting stand-ins (see the header): set before the server starts, because the plugins read them when they register.
const meetingsStack = seedMode === 'meetings' || process.env['MANYTHREADS_STACK_MEETINGS'] === '1';
const fallbackEnv = (key: string, value: string): void => {
  if (process.env[key] === undefined) process.env[key] = value;
};
if (meetingsStack) {
  fallbackEnv('MANYTHREADS_MEDIA_PROVIDER', 'fake');
  fallbackEnv('MANYTHREADS_FAKE_ASR', '1');
  fallbackEnv('MANYTHREADS_STACK_TEST_PLUGINS', '1');
  fallbackEnv('MANYTHREADS_STACK_DEV_AUTH', '1');
  fallbackEnv('MANYTHREADS_HERMES_BIN', process.execPath);
  fallbackEnv('MANYTHREADS_HERMES_PREFIX', fileURLToPath(new URL('./meeting-hermes.mjs', import.meta.url)));
  fallbackEnv('MANYTHREADS_RUNTIME_DIR', mkdtempSync(join(tmpdir(), 'manythreads-stack-runtime-')));
  fallbackEnv('MANYTHREADS_LITELLM_URL', 'http://litellm.invalid:4000');
}
// The `connectors` seed (P16-12): the server needs the Hermes stand-in command (a webhook run answers), the dev actor header (the seed calls the routes), and the stand-ins' app ids and fake
// bases in its environment, which is why tools/fake-saas starts first. The ports are the OS's; a spec reads them from the ready line.
const connectorsStack = seedMode === 'connectors';
const wantsFakeSaas = connectorsStack || process.env['MANYTHREADS_STACK_FAKE_SAAS'] === '1';
if (connectorsStack) {
  fallbackEnv('MANYTHREADS_STACK_DEV_AUTH', '1');
  fallbackEnv('MANYTHREADS_STACK_TEST_PLUGINS', '1');
  fallbackEnv('MANYTHREADS_HERMES_BIN', process.execPath);
  fallbackEnv('MANYTHREADS_HERMES_PREFIX', fileURLToPath(new URL('./meeting-hermes.mjs', import.meta.url)));
  fallbackEnv('MANYTHREADS_RUNTIME_DIR', mkdtempSync(join(tmpdir(), 'manythreads-stack-runtime-')));
  fallbackEnv('MANYTHREADS_LITELLM_URL', 'http://litellm.invalid:4000');
}
// The `runners` seed (P19-11) makes its runners through the real routes, so it needs the dev actor header.
if (seedMode === 'runners') fallbackEnv('MANYTHREADS_STACK_DEV_AUTH', '1');
let saas: FakeSaas | null = null;
if (wantsFakeSaas) {
  const { startFakeSaas } = await import('../../tools/fake-saas/src/index.ts');
  const seedKey = process.env['MANYTHREADS_STACK_FAKE_SAAS_SEED'] ?? 'manythreads-stack-seed';
  saas = await startFakeSaas({
    seedKey,
    seedGrants: [
      ...SEED_CONNECTORS.grants.map((g) => ({ provider: g.provider, email: g.who.email })),
    ],
  });
  for (const [key, value] of Object.entries(saas.env())) fallbackEnv(key, value);
}
// Attachments (storage-local) go to a directory of this stack, removed on exit, never into the working tree.
const storageDir = process.env['MANYTHREADS_STORAGE_DIR'] ?? mkdtempSync(join(tmpdir(), 'manythreads-stack-blobs-'));
process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
// Team repositories (repo-git) likewise.
const repoDir = process.env['MANYTHREADS_REPO_DIR'] ?? mkdtempSync(join(tmpdir(), 'manythreads-stack-repos-'));
process.env['MANYTHREADS_REPO_DIR'] = repoDir;
const db = await createTestDatabase();
// `MANYTHREADS_STACK_SNAPSHOT` (P12-02) restores a saved database and its folders; the seed modes below then do not run.
const snapshot = process.env['MANYTHREADS_STACK_SNAPSHOT'] ?? '';
if (snapshot !== '') await restoreSnapshot({ name: snapshot, database: { name: db.name, ownerUrl: db.ownerUrl }, repoDir, storageDir });
else if (seedMode === 'personas') await createPersonas(db);
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
  // A failing spec's log is the first thing anyone wants and the last thing this process prints: `MANYTHREADS_STACK_LOG=1` echoes each line
  // to stderr as it is written, so a run can be watched without reading a stack trace back into a guess.
  logger: {
    level: 'info',
    stream: {
      write: (line: string) => {
        if (logs.length < 2000) logs.push(line);
        if (process.env['MANYTHREADS_STACK_LOG'] === '1') process.stderr.write(`${line}\n`);
      },
    },
  },
});
apiPort = server.port; // the seeds below call back through the front (a chat app's webhook posts to the public address, which is this front)
// The server's plugin migrations have run: now the conversations (seed v3 needs the channel tables).
// `repo` is seed v3 plus seed v4: the team repositories (pages with history, a CSV, a diagram, an app, memory, bots) and the attachments of #dev.
if (snapshot !== '') {
  // restored above: nothing to seed
} else if (seedMode === 'content') await seedWorld(db, { content: true });
else if (seedMode === 'repo') await seedWorld(db, { content: true, repo: true });
else if (seedMode === 'guard') await seedWorld(db, { content: true, repo: true, guard: true });
// `polish` is seed v21 (P21-24): seed v3 and v4, then `#polish` for the look checks (a run, a long message, an Answer, a thread). Opt-in: no other mode has it.
else if (seedMode === 'polish') {
  await seedWorld(db, { content: true, repo: true });
  await seedPolish(db);
}
// `work` is seed v6 on top of v4: the Engineering board, scheduled jobs (off), routine page and the protected `production` environment.
else if (seedMode === 'work') await seedWorld(db, { content: true, repo: true, work: true });
// `meetings` is seed v15 (P15-17): seed v3 and v4, then three finished calls made through the real routes of this server. Opt-in: no other mode has them.
else if (seedMode === 'meetings') {
  await seedWorld(db, { content: true, repo: true });
  await seedMeetings({ url: `http://127.0.0.1:${server.port}`, db, log: (line) => process.stderr.write(`seed meetings: ${line}\n`) });
}
// `connectors` is seed v16 (P16-12): seed v3 and v4, then the planned room, the sealed sign-ins, the work-app address, Telegram and the handbook folder, made through the real routes of this
// server against the stand-ins of tools/fake-saas. Opt-in: no other mode has them.
// `runners` is seed v19 (P19-11): seed v3 and v4, then the Runners page's runners, made through the real routes of this server. Opt-in: no other mode has them.
if (snapshot === '' && seedMode === 'runners') {
  await seedWorld(db, { content: true, repo: true });
  await seedRunners({ url: `http://127.0.0.1:${server.port}`, db, log: (line) => process.stderr.write(`seed runners: ${line}\n`) });
}
let seeded: SeedConnectorsResult | null = null;
if (snapshot === '' && connectorsStack) {
  await seedWorld(db, { content: true, repo: true });
  seeded = await seedConnectors({ url: `http://127.0.0.1:${server.port}`, db, saas: saas!, log: (line) => process.stderr.write(`seed connectors: ${line}\n`) });
}
// The plugins have migrated: a seeded workspace starts with its setup checklist already put away (an empty stack, `none`, is a fresh install and keeps it).
if (seedMode !== 'none') await seedFinishedSetup(db);
console.log(
  `MANYTHREADS_STACK ${JSON.stringify({
    origin,
    ownerUrl: db.ownerUrl,
    database: db.name,
    testAuthToken: token,
    bootstrapToken: parseBootstrapToken(logs) ?? null,
    fakeSaas: saas ? { control: saas.control.url, seedKey: saas.seedKey, env: saas.env(), telegramBotToken: saas.telegram.bots[0]?.token ?? null } : null,
    seeded,
  })}`,
);

let closing = false;
const stop = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  try {
    front.closeAllConnections();
    front.close();
    await server.close();
    await saas?.stop().catch(() => undefined);
  } finally {
    await dropTestDatabase(db).catch(() => undefined);
    rmSync(storageDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    process.exit(0);
  }
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
