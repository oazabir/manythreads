// The Codex runner's sign-in file (PLAN Phase 19, P19-13). The admin uploads `auth.json` as it is; the server stores the bytes exactly and keeps only
// metadata, as for Claude (see credentials.ts). This module is the ONE reader of the file's shape for the browser and the server.
//
// What a ChatGPT login file looks like (key names from the Codex CLI; the values below are guesses until the owner's host test, PLAN P19-13 (k)-(s)):
//   { "auth_mode": "chatgpt", "OPENAI_API_KEY": null, "tokens": { "id_token", "access_token", "refresh_token", "account_id", ... }, "last_refresh": "<ISO time>" }
//
// The rules (decision E8): the whole file is refused when it is not JSON, when it is larger than MAX_CREDENTIALS_BYTES, when a `__proto__` key is anywhere in it, when
// `auth_mode` is not the ChatGPT sign-in, when `OPENAI_API_KEY` is anything but null (an API key would bypass the workspace's model gateway), or when the three tokens are
// missing. The plan name and the access token's expiry are read from the two JWTs in the BROWSER only (`readPlan`): the server looks at no token content, and sends nothing of
// it anywhere. No function here returns a token. `loginKey` is the raw material of the server's keyed same-login hash: never shown, never logged, never stored as it is.

import { MAX_CREDENTIALS_BYTES } from './credentials.ts';

/** The `auth_mode` values that mean "signed in with a ChatGPT account". THE ONE LINE to change if the real CLI writes another word (P19-13 owner test). */
export const CODEX_CHATGPT_AUTH_MODES: readonly string[] = ['chatgpt'];

/** The plan names a browser may name in the `x-plan-label` header. The server stores one of these or the default; it never reads the tokens to find out. */
export const CODEX_PLAN_LABELS: readonly string[] = [
  'ChatGPT plan',
  'ChatGPT Free plan',
  'ChatGPT Go plan',
  'ChatGPT Plus plan',
  'ChatGPT Pro plan',
  'ChatGPT Team plan',
  'ChatGPT Business plan',
  'ChatGPT Enterprise plan',
  'ChatGPT Edu plan',
];
export const CODEX_DEFAULT_PLAN_LABEL = 'ChatGPT plan';
export const CODEX_PLAN_LABEL_HEADER = 'x-plan-label';

/** The label the server stores for the header's value: one of the fixed list, else the default. */
export function codexPlanLabelFrom(header: unknown): string {
  return typeof header === 'string' && CODEX_PLAN_LABELS.includes(header) ? header : CODEX_DEFAULT_PLAN_LABEL;
}

export interface CodexCredentialsSummary {
  /** For example "ChatGPT Pro plan"; "ChatGPT plan" when the file does not say or when the plan was not read (the server never reads it). */
  planLabel: string;
  /** Milliseconds since the epoch when the access token runs out (read from the token in the browser only); null when not read or not given. */
  expiresAt: number | null;
  /** Milliseconds since the epoch of the file's `last_refresh`, or null. */
  lastRefresh: number | null;
  /** How many entries the file holds beyond the ones Codex writes, and the first few names (names only, never a value). */
  otherCount: number;
  otherNames: string[];
}

export type CodexCredentialsInspection = { ok: true; summary: CodexCredentialsSummary; loginKey: string } | { ok: false; message: string };

const NOT_A_FILE = 'That is not a Codex sign-in file. Choose the auth.json from a Codex login with a ChatGPT account.';
const API_KEY_FILE = "This file holds an API key. An API key would go around this workspace's model limits, so only a ChatGPT login is taken. Run the Codex login with a ChatGPT account and choose that auth.json.";
const NOT_CHATGPT = 'This sign-in is not a ChatGPT account login. Run the Codex login with a ChatGPT account and choose that auth.json.';

const KNOWN_KEYS = new Set(['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh']);
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The payload of a JWT as an object, or null. Read-only: the token is not kept. */
function jwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (part === undefined || part === '' || part.length > 16 * 1024) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The plan as the page words it, from the id token's `chatgpt_plan_type` claim ("pro", "plus", "team" ...). */
function planFromIdToken(idToken: string): string {
  const auth = jwtPayload(idToken)?.['https://api.openai.com/auth'];
  const type = isObject(auth) && typeof auth['chatgpt_plan_type'] === 'string' ? auth['chatgpt_plan_type'].toLowerCase() : '';
  const names: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
  const name = names[type];
  return name === undefined ? CODEX_DEFAULT_PLAN_LABEL : `ChatGPT ${name} plan`;
}

/**
 * Reads a sign-in file's text and says what it is, or why it is refused. The input is read once and not kept. `readPlan` (browser only) also reads the plan and the access
 * token's expiry from the two JWTs; without it the summary says "ChatGPT plan" and no expiry. `loginKey` must never be logged, echoed or stored as it is.
 */
export function inspectCodexCredentials(text: string, opts: { readPlan?: boolean } = {}): CodexCredentialsInspection {
  if (text.length > MAX_CREDENTIALS_BYTES) return { ok: false, message: 'That file is too large to be a Codex sign-in file.' };
  let danger = false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (key, value: unknown) => {
      if (key === '__proto__') danger = true;
      return value;
    });
  } catch {
    return { ok: false, message: NOT_A_FILE };
  }
  if (danger || !isObject(parsed) || !hasOwn(parsed, 'tokens')) return { ok: false, message: NOT_A_FILE };
  // The API-key check comes before every other: a file with a key is refused whatever else it holds, and the sentence never repeats the key.
  if (hasOwn(parsed, 'OPENAI_API_KEY') && parsed['OPENAI_API_KEY'] !== null && parsed['OPENAI_API_KEY'] !== undefined) return { ok: false, message: API_KEY_FILE };
  const mode = parsed['auth_mode'];
  if (typeof mode !== 'string' || !CODEX_CHATGPT_AUTH_MODES.includes(mode.toLowerCase())) return { ok: false, message: mode === undefined ? NOT_A_FILE : NOT_CHATGPT };
  const tokens = parsed['tokens'];
  if (!isObject(tokens)) return { ok: false, message: NOT_A_FILE };
  const idToken = tokens['id_token'];
  const access = tokens['access_token'];
  const refresh = tokens['refresh_token'];
  if (!nonEmpty(idToken) || !nonEmpty(access) || !nonEmpty(refresh)) return { ok: false, message: NOT_A_FILE };
  const account = nonEmpty(tokens['account_id']) ? tokens['account_id'] : null;
  const owner = nonEmpty(tokens['login_owner_id']) ? tokens['login_owner_id'] : null;
  const other = Object.keys(parsed).filter((k) => !KNOWN_KEYS.has(k));
  const refreshed = typeof parsed['last_refresh'] === 'string' ? Date.parse(parsed['last_refresh']) : Number.NaN;
  const exp = opts.readPlan === true ? jwtPayload(access)?.['exp'] : undefined;
  return {
    ok: true,
    // A file with no account id is told apart by its refresh token instead (conservative: one more refusal, never a missed duplicate).
    loginKey: account === null ? `rt|${refresh}` : `acct|${account}|${owner ?? ''}`,
    summary: {
      planLabel: opts.readPlan === true ? planFromIdToken(idToken) : CODEX_DEFAULT_PLAN_LABEL,
      expiresAt: typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null,
      lastRefresh: Number.isFinite(refreshed) ? refreshed : null,
      otherCount: other.length,
      otherNames: other.slice(0, 5).map((k) => k.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)).filter((k) => k !== ''),
    },
  };
}
