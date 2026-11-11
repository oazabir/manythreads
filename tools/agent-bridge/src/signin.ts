import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The sign-in as the bridge sees it (PLAN P19-06 for Claude, P19-13 for Codex): what the sign-in file says about itself, the one gate that lets a single run renew it, and the
// words that tell a refused sign-in or a plan limit from any other failure. Nothing here logs or returns a token; the file is read for its shape and its dates only.

/** The two CLIs the bridge starts; the same names as a profile's `agent`. */
export type SigninAgent = 'claude-code' | 'codex';

/**
 * The words a CLI uses when it fails for a reason that is about the account, not the run. THE ONE TABLE: when the texts change, change these lines and nothing else. Each row is tried
 * in order for the run's agent; `pattern` is matched against the CLI's error text, case-insensitively (the tools capitalise: "Not logged in", "Invalid API key", "API Error: 401").
 * The FAKE rows are the stand-ins' own words (deploy/images/claude-pod-fake).
 *
 * MEASURED 2026-11-10 on the host's real tools (docs/spikes/host-claude-codex-measured.md): Claude Code 2.1.319 printed "Not logged in · Please run /login", "Invalid API key · Fix external
 * API key" and "Failed to authenticate. API Error: 401 OAuth access token is invalid."; Codex 0.166.0 printed "unexpected status 401 Unauthorized: Missing bearer or basic authentication in
 * header". The limit and expiry words below come from the programs' own message strings (read with `strings`, not provoked): Claude "You've hit your 5-hour limit" / "weekly limit" / "Opus
 * limit" / "Sonnet limit", "OAuth session expired and could not be refreshed", "OAuth token revoked", "this login reached its time limit"; Codex "Your access token could not be refreshed
 * because your refresh token was already used / has expired / was revoked. Please log out and sign in again." and "You've hit your usage limit".
 */
export const FAILURE_PATTERNS: ReadonlyArray<{ agents: readonly SigninAgent[]; kind: 'needs_sign_in' | 'plan_limit'; pattern: RegExp }> = [
  { agents: ['claude-code', 'codex'], kind: 'needs_sign_in', pattern: /FAKE401/ },
  { agents: ['claude-code', 'codex'], kind: 'plan_limit', pattern: /FAKELIMIT/ },
  { agents: ['claude-code'], kind: 'needs_sign_in', pattern: /(?:api error|status(?: code)?|http|error)\W{0,3}401\b|authentication_(?:error|failed)|invalid (?:api key|authentication|credentials)|oauth (?:access )?(?:token|session) (?:has |is |was )?(?:been )?(?:expired|revoked|invalid)|login (?:has )?expired|login reached its time limit|please run \/login|not logged in/i },
  { agents: ['claude-code'], kind: 'plan_limit', pattern: /usage limit reached|rate limit reached|you(?:'|\u2019)ve hit your [\w -]{0,40}limit|reached your (?:[\w -]{0,40} )?usage limit|(?:5-hour|weekly|opus|sonnet|fable|usage credit) limit|limit will reset/i },
  // Codex. A reused or expired refresh token is an account failure: it is never retried, because every retry presents the same dead token.
  { agents: ['codex'], kind: 'needs_sign_in', pattern: /refresh_token_reused|refresh token (?:was |has )?(?:already )?(?:been )?(?:used|expired|revoked|invalidated)|could not be refreshed|failed to refresh (?:the )?token|invalid_grant|token_(?:expired|invalidated|revoked)|(?:log|sign) (?:out|in) and (?:log|sign) in again|(?:log|sign) in again|codex login|not logged in/i },
  { agents: ['codex'], kind: 'plan_limit', pattern: /hit your usage limit|usage[_ ]limit(?:[_ ]reached)?|rate limit reached|try again in \d+\s*(?:days?|hours?|hrs?|minutes?|mins?)/i },
  { agents: ['codex'], kind: 'needs_sign_in', pattern: /(?:unexpected )?status(?: code)?\W{0,3}401\b|\b401 unauthorized|missing bearer or basic authentication|authentication_error|invalid (?:api key|authentication|credentials)/i },
];

export type AccountFailure = 'needs_sign_in' | 'plan_limit';

/** Which account-level failure `text` is for `agent`, or null. */
export function classifyFailure(text: string, agent: SigninAgent = 'claude-code'): AccountFailure | null {
  for (const row of FAILURE_PATTERNS) if (row.agents.includes(agent) && row.pattern.test(text)) return row.kind;
  return null;
}

/**
 * When the plan comes back, in ms, from a limit text; null when the text has none. Two shapes: "...|1762445000" or "resets at 1762445000" (seconds since the epoch), and the
 * Codex wording "try again in 2 days 3 hours 4 minutes" (any of the three parts) counted from `now`.
 */
export function limitResetsAt(text: string, now: number = Date.now()): number | null {
  const m = /\b(1[5-9]\d{8})\b/.exec(text);
  if (m) return Number(m[1]) * 1000;
  const rel = /try again in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b(?:\s*,)?(?:\s+and)?\s*)+)/i.exec(text);
  if (!rel) return null;
  let ms = 0;
  for (const part of rel[1]!.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)) {
    const n = Number(part[1]);
    const unit = part[2]!.toLowerCase()[0]!;
    ms += n * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000);
  }
  return ms > 0 && ms < 400 * 86_400_000 ? now + ms : null;
}

export interface FileFacts {
  exists: boolean;
  /** The file parses and has the sign-in's keys. */
  valid: boolean;
  scopeOk: boolean;
  /** When the access token runs out, in ms; null when the file does not say (or, for Codex, the token is not a readable JWT). */
  expiresAt: number | null;
  /** Codex only: the file's `last_refresh`, in ms, or null. */
  refreshedAt: number | null;
  /** Modification time, so a replaced file can be told from the one a failure was seen on. */
  mtimeMs: number | null;
}

const NO_FILE: FileFacts = { exists: false, valid: false, scopeOk: false, expiresAt: null, refreshedAt: null, mtimeMs: null };

/** What `<configDir>/.credentials.json` says, without keeping or returning any token. */
export function readFileFacts(configDir: string): FileFacts {
  const path = join(configDir, '.credentials.json');
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { claudeAiOauth?: { expiresAt?: unknown; scopes?: unknown; accessToken?: unknown } };
    const oauth = doc.claudeAiOauth;
    const valid = typeof oauth === 'object' && oauth !== null && typeof oauth.accessToken === 'string';
    const expiresAt = valid && typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;
    return { exists: true, valid, scopeOk: valid && Array.isArray(oauth.scopes) && oauth.scopes.includes('user:inference'), expiresAt, refreshedAt: null, mtimeMs };
  } catch {
    return NO_FILE;
  }
}

/** The `auth_mode` words that mean a ChatGPT login. Kept in step with CODEX_CHATGPT_AUTH_MODES in packages/shared (the bridge imports nothing from the workspace). */
const CODEX_CHATGPT_MODES = ['chatgpt'];

/** The `exp` claim of a JWT in ms, or null. The token is read here and not kept. */
function jwtExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (part === undefined || part === '' || part.length > 16 * 1024) return null;
  try {
    const exp = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * What `<codexHome>/auth.json` says, without keeping or returning any token. The file is `valid` only when it is a ChatGPT login with no API key (an API key would go around the
 * workspace's model gateway), and the three tokens are there. The access token's expiry comes from its JWT `exp` when it is one.
 */
export function readCodexFileFacts(codexHome: string): FileFacts {
  const path = join(codexHome, 'auth.json');
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { ...NO_FILE, exists: true, mtimeMs };
    const tokens = doc['tokens'];
    const t = typeof tokens === 'object' && tokens !== null && !Array.isArray(tokens) ? (tokens as Record<string, unknown>) : {};
    const text = (v: unknown): v is string => typeof v === 'string' && v !== '';
    const mode = doc['auth_mode'];
    const valid =
      typeof mode === 'string' &&
      CODEX_CHATGPT_MODES.includes(mode.toLowerCase()) &&
      (doc['OPENAI_API_KEY'] === null || doc['OPENAI_API_KEY'] === undefined) &&
      text(t['id_token']) &&
      text(t['access_token']) &&
      text(t['refresh_token']);
    const refreshed = typeof doc['last_refresh'] === 'string' ? Date.parse(doc['last_refresh']) : Number.NaN;
    return { exists: true, valid, scopeOk: valid, expiresAt: valid && text(t['access_token']) ? jwtExpiry(t['access_token']) : null, refreshedAt: Number.isFinite(refreshed) ? refreshed : null, mtimeMs };
  } catch {
    return NO_FILE;
  }
}

/** How long a plan limit stands when the CLI's text gave no reset time; then one run is let through to find out. */
export const DEFAULT_LIMIT_WAIT_MS = 30 * 60_000;

export type CheckResult = 'ok' | 'rejected' | 'expired' | 'no_scope' | 'limit';

/** How long before the access token's expiry new runs queue behind one probe run that renews it. */
export const REFRESH_WINDOW_MS = 20 * 60_000;

/**
 * Codex renews its tokens on its own when `last_refresh` is older than this (about eight days, from the CLI's documentation). MEASURED 2026-11-10 on Codex 0.166.0: the access token lives 10 days
 * (`exp` - `iat`) and `last_refresh` equals `iat`; a run at 8.9 days did NOT renew (auth.json unchanged). So this hold is conservative: it serialises runs earlier than the tool renews.
 */
export const CODEX_RENEW_AFTER_MS = 8 * 86_400_000;

/**
 * Keeps one process renewing the sign-in. The CLI renews an expiring access token itself and writes the new pair back; if several runs find it expiring at once, each renews with the
 * same refresh token and the second use of a rotated token signs the account out (for Codex that is `refresh_token_reused`, and it kills the login for good). So within the window
 * before a renewal is due, only one run goes at a time (the probe); the others wait for it and then look at the file again. Far from a renewal, runs go in parallel as usual.
 *
 * "Due" is the access token's expiry for Claude. For Codex it is the access token's expiry when that is a readable JWT, or `last_refresh` older than eight days (less the window).
 */
export class SigninGate {
  private probing = false;
  private waiters: Array<() => void> = [];
  private failure: { kind: AccountFailure; since: number; mtimeMs: number | null; until: number | null } | null = null;

  constructor(
    private readonly configDir: string,
    private readonly now: () => number = Date.now,
    readonly agent: SigninAgent = 'claude-code',
  ) {}

  private facts(): FileFacts {
    return this.agent === 'codex' ? readCodexFileFacts(this.configDir) : readFileFacts(this.configDir);
  }

  private near(): boolean {
    const f = this.facts();
    if (!f.exists) return false;
    const now = this.now();
    if (f.expiresAt !== null && f.expiresAt - now < REFRESH_WINDOW_MS) return true;
    return this.agent === 'codex' && f.refreshedAt !== null && now - f.refreshedAt > CODEX_RENEW_AFTER_MS - REFRESH_WINDOW_MS;
  }

  /** Run `fn` (one run); within the refresh window, alone. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      if (!this.near()) return fn();
      if (!this.probing) {
        this.probing = true;
        try {
          return await fn();
        } finally {
          this.probing = false;
          const w = this.waiters;
          this.waiters = [];
          for (const wake of w) wake();
        }
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** A run failed for an account reason: remember it until the sign-in file changes (or, for a limit, until the plan resets). */
  noteFailure(kind: AccountFailure, text: string): void {
    this.failure = { kind, since: this.now(), mtimeMs: this.facts().mtimeMs, until: kind === 'plan_limit' ? limitResetsAt(text, this.now()) ?? this.now() + DEFAULT_LIMIT_WAIT_MS : null };
  }

  /** The failure still standing, or null (a replaced file or a passed reset clears it). */
  standing(): { kind: AccountFailure; until: number | null } | null {
    const f = this.failure;
    if (f === null) return null;
    if (f.kind === 'needs_sign_in' && this.facts().mtimeMs !== f.mtimeMs) this.failure = null;
    else if (f.kind === 'plan_limit' && f.until !== null && f.until <= this.now()) this.failure = null;
    return this.failure === null ? null : { kind: this.failure.kind, until: this.failure.until };
  }

  /** Answer for `POST /v1/signin/check`: the file's shape and the failures seen. It makes no call to the CLI (the real probe waits for the real CLI, P19-01 and P19-13). */
  check(): CheckResult {
    const f = this.facts();
    if (!f.exists || !f.valid) return 'rejected';
    if (!f.scopeOk) return 'no_scope';
    const standing = this.standing();
    if (standing?.kind === 'needs_sign_in') return 'rejected';
    if (standing?.kind === 'plan_limit') return 'limit';
    return 'ok';
  }
}
