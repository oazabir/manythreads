import { fileURLToPath } from 'node:url';

/**
 * Browser e2e topology (playwright.config.ts). Each web origin is `vite preview` of the built web client proxying
 * `/api` to its own test server, so session cookies are same-origin like in production.
 *
 *   WEB        4173 -> API 3100  seeded workspace "Kahf Software" and the seven personas (default for browser specs)
 *   WEB_EMPTY  4174 -> API 3101  empty database: prints the one-time first-admin link (written to BOOTSTRAP_TOKEN_FILE)
 *   WEB_IDLE   4175 -> API 3102  seeded, sessions go idle after IDLE_SECONDS (for the expiry spec)
 */
export const WEB_PORT = 4173;
export const WEB_EMPTY_PORT = 4174;
export const WEB_IDLE_PORT = 4175;
export const API_PORT = Number(process.env['MANYTHREADS_API_PORT'] ?? 3100);
export const API_EMPTY_PORT = API_PORT + 1;
export const API_IDLE_PORT = API_PORT + 2;

export const WEB = process.env['MANYTHREADS_URL'] ?? `http://localhost:${WEB_PORT}`;
export const WEB_EMPTY = `http://localhost:${WEB_EMPTY_PORT}`;
export const WEB_IDLE = `http://localhost:${WEB_IDLE_PORT}`;

/** Idle lifetime of the WEB_IDLE server's sessions. */
export const IDLE_SECONDS = 6;

const authDir = fileURLToPath(new URL('../.auth/', import.meta.url));
export const AUTH_DIR = authDir;
export const BOOTSTRAP_TOKEN_FILE = `${authDir}bootstrap-token.txt`;
