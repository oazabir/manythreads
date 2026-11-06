import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The Claude sign-in as the bridge sees it (PLAN P19-06): what the sign-in file says about itself, the one gate that lets a single run renew it, and the words that tell a
// refused sign-in or a plan limit from any other failure. Nothing here logs or returns a token; the file is read for `expiresAt` and `scopes` only.

/**
 * The words the CLI uses when it fails for a reason that is about the account, not the run. THE ONE TABLE: when the real texts are measured (P19-01 g), change these lines and
 * nothing else. Each row is tried in order; `pattern` is matched against the CLI's error text, case-insensitively. The first two rows are the stand-in's own words
 * (deploy/images/claude-pod-fake); the others are the CLI's documented wording, unverified.
 */
export const FAILURE_PATTERNS: ReadonlyArray<{ kind: 'needs_sign_in' | 'plan_limit'; pattern: RegExp }> = [
  { kind: 'needs_sign_in', pattern: /FAKE401/ },
  { kind: 'plan_limit', pattern: /FAKELIMIT/ },
  { kind: 'needs_sign_in', pattern: /(?:api error|status(?: code)?|http|error)\W{0,3}401\b|authentication_error|invalid (api key|authentication|credentials)|oauth token (has )?(expired|revoked)|please run \/login|not logged in/ },
  { kind: 'plan_limit', pattern: /usage limit reached|rate limit reached|5-hour limit|weekly limit|limit will reset/ },
];

export type AccountFailure = 'needs_sign_in' | 'plan_limit';

/** Which account-level failure `text` is, or null. */
export function classifyFailure(text: string): AccountFailure | null {
  for (const row of FAILURE_PATTERNS) if (row.pattern.test(text)) return row.kind;
  return null;
}

/** "...|1762445000" or "resets at 1762445000" (seconds) in a limit text: when the plan comes back, in ms; null when the text has none. */
export function limitResetsAt(text: string): number | null {
  const m = /\b(1[5-9]\d{8})\b/.exec(text);
  return m ? Number(m[1]) * 1000 : null;
}

export interface FileFacts {
  exists: boolean;
  /** The file parses and has the sign-in's keys. */
  valid: boolean;
  scopeOk: boolean;
  expiresAt: number | null;
  /** Modification time, so a replaced file can be told from the one a failure was seen on. */
  mtimeMs: number | null;
}

/** What `<configDir>/.credentials.json` says, without keeping or returning any token. */
export function readFileFacts(configDir: string): FileFacts {
  const path = join(configDir, '.credentials.json');
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { claudeAiOauth?: { expiresAt?: unknown; scopes?: unknown; accessToken?: unknown } };
    const oauth = doc.claudeAiOauth;
    const valid = typeof oauth === 'object' && oauth !== null && typeof oauth.accessToken === 'string';
    const expiresAt = valid && typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;
    return { exists: true, valid, scopeOk: valid && Array.isArray(oauth.scopes) && oauth.scopes.includes('user:inference'), expiresAt, mtimeMs };
  } catch {
    return { exists: false, valid: false, scopeOk: false, expiresAt: null, mtimeMs: null };
  }
}

/** How long a plan limit stands when the CLI's text gave no reset time; then one run is let through to find out. */
export const DEFAULT_LIMIT_WAIT_MS = 30 * 60_000;

export type CheckResult = 'ok' | 'rejected' | 'expired' | 'no_scope' | 'limit';

/** How long before the access token's expiry new runs queue behind one probe run that renews it. */
export const REFRESH_WINDOW_MS = 20 * 60_000;

/**
 * Keeps one process renewing the sign-in. The CLI renews an expiring access token itself and writes the new pair back; if several runs find it expiring at once, each renews with the
 * same refresh token and the second use of a rotated token signs the account out. So within the window before expiry, only one run goes at a time (the probe); the others wait for it
 * and then look at the file again. Far from expiry, runs go in parallel as usual.
 */
export class SigninGate {
  private probing = false;
  private waiters: Array<() => void> = [];
  private failure: { kind: AccountFailure; since: number; mtimeMs: number | null; until: number | null } | null = null;

  constructor(
    private readonly configDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private near(): boolean {
    const f = readFileFacts(this.configDir);
    return f.exists && f.expiresAt !== null && f.expiresAt - this.now() < REFRESH_WINDOW_MS;
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
    this.failure = { kind, since: this.now(), mtimeMs: readFileFacts(this.configDir).mtimeMs, until: kind === 'plan_limit' ? limitResetsAt(text) ?? this.now() + DEFAULT_LIMIT_WAIT_MS : null };
  }

  /** The failure still standing, or null (a replaced file or a passed reset clears it). */
  standing(): { kind: AccountFailure; until: number | null } | null {
    const f = this.failure;
    if (f === null) return null;
    if (f.kind === 'needs_sign_in' && readFileFacts(this.configDir).mtimeMs !== f.mtimeMs) this.failure = null;
    else if (f.kind === 'plan_limit' && f.until !== null && f.until <= this.now()) this.failure = null;
    return this.failure === null ? null : { kind: this.failure.kind, until: this.failure.until };
  }

  /** Answer for `POST /v1/signin/check`: the file's shape and the failures seen. It makes no call to Claude (the real probe waits for the real CLI, P19-01). */
  check(): CheckResult {
    const f = readFileFacts(this.configDir);
    if (!f.exists || !f.valid) return 'rejected';
    if (!f.scopeOk) return 'no_scope';
    const standing = this.standing();
    if (standing?.kind === 'needs_sign_in') return 'rejected';
    if (standing?.kind === 'plan_limit') return 'limit';
    return 'ok';
  }
}
