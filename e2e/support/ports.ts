import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Browser e2e topology (playwright.config.ts). Each web origin is `vite preview` of the built web client proxying
 * `/api` to its own test server, so session cookies are same-origin like in production.
 *
 *   WEB        -> API        seeded workspace "Kahf Software" and the seven personas (default for browser specs)
 *   WEB_EMPTY  -> API_EMPTY  empty database: prints the one-time first-admin link (written to BOOTSTRAP_TOKEN_FILE)
 *   WEB_IDLE   -> API_IDLE   seeded, sessions go idle after IDLE_SECONDS (for the expiry spec)
 *
 * Ports are free ports picked when the config first loads, so two Playwright runs (CI jobs, two worktrees, a run next to a dev
 * server) never collide on a fixed number. The choice is stored in MANYTHREADS_E2E_PORTS, which the workers inherit, so every
 * process agrees. To pin them: MANYTHREADS_API_PORT=3100 (the empty server takes +1 and the idle one +2) and
 * MANYTHREADS_WEB_PORT=4173 (+1, +2). The per-spec stacks (fixtures/stack.ts) always listen on port 0.
 */
interface Ports {
  web: number;
  webEmpty: number;
  webIdle: number;
  api: number;
  apiEmpty: number;
  apiIdle: number;
}

/** `count` distinct free loopback ports, held together so they differ, then released. Synchronous: a config file cannot await. */
function freePorts(count: number): number[] {
  const script = `const net = require('node:net'); const servers = []; const ports = [];
    for (let i = 0; i < ${count}; i += 1) { const s = net.createServer(); servers.push(s);
      s.listen(0, '127.0.0.1', () => { ports.push(s.address().port); if (ports.length === ${count}) { console.log(JSON.stringify(ports)); servers.forEach((x) => x.close()); } }); }`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })) as number[];
}

function resolvePorts(): Ports {
  const stored = process.env['MANYTHREADS_E2E_PORTS'];
  if (stored) return JSON.parse(stored) as Ports;
  const pinnedApi = Number(process.env['MANYTHREADS_API_PORT'] ?? 0);
  const pinnedWeb = Number(process.env['MANYTHREADS_WEB_PORT'] ?? 0);
  const free = pinnedApi && pinnedWeb ? [] : freePorts(6);
  const ports: Ports = {
    api: pinnedApi || free[0]!,
    apiEmpty: pinnedApi ? pinnedApi + 1 : free[1]!,
    apiIdle: pinnedApi ? pinnedApi + 2 : free[2]!,
    web: pinnedWeb || free[3]!,
    webEmpty: pinnedWeb ? pinnedWeb + 1 : free[4]!,
    webIdle: pinnedWeb ? pinnedWeb + 2 : free[5]!,
  };
  process.env['MANYTHREADS_E2E_PORTS'] = JSON.stringify(ports);
  return ports;
}

const ports = resolvePorts();
export const WEB_PORT = ports.web;
export const WEB_EMPTY_PORT = ports.webEmpty;
export const WEB_IDLE_PORT = ports.webIdle;
export const API_PORT = ports.api;
export const API_EMPTY_PORT = ports.apiEmpty;
export const API_IDLE_PORT = ports.apiIdle;

export const WEB = process.env['MANYTHREADS_URL'] ?? `http://localhost:${WEB_PORT}`;
export const WEB_EMPTY = `http://localhost:${WEB_EMPTY_PORT}`;
export const WEB_IDLE = `http://localhost:${WEB_IDLE_PORT}`;

/** Idle lifetime of the WEB_IDLE server's sessions. */
export const IDLE_SECONDS = 6;

// Signed-in states of the personas; MANYTHREADS_E2E_AUTH_DIR keeps two runs from overwriting each other's files.
const authDir = process.env['MANYTHREADS_E2E_AUTH_DIR'] ? `${process.env['MANYTHREADS_E2E_AUTH_DIR'].replace(/\/$/, '')}/` : fileURLToPath(new URL('../.auth/', import.meta.url));
export const AUTH_DIR = authDir;
export const BOOTSTRAP_TOKEN_FILE = `${authDir}bootstrap-token.txt`;
