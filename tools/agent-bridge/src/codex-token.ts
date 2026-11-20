import { createHash } from 'node:crypto';

// The Codex sign-in file (`auth.json`) as the root helper of an enrolled server judges it (PLAN P31-01, docs/plans/codex-teams-and-oom.md section 2). On a server every team's Codex runs
// with a Codex home of its own (`<root>/work/<team>/.codex`); the helper copies the machine's one sign-in (the "main copy", `<root>/auth/codex/auth.json`, the bridge user's, 0700) into
// it for the run, and copies a renewed sign-in back. This file decides, with no side effect, whether a file is a sign-in at all and whether a renewed one may replace the main copy.
// It never returns or logs a token: what it keeps of a file is its hash, the account and the dates (and the hash of the refresh token, to see that it changed).

/** The largest `auth.json` the helper reads (a real one is about 4 KiB). */
export const CODEX_AUTH_MAX_BYTES = 64 * 1024;

/** The `auth_mode` words that mean a ChatGPT login. Kept in step with CODEX_CHATGPT_AUTH_MODES in packages/shared (the bridge imports nothing from the workspace). */
export const CODEX_CHATGPT_MODES: readonly string[] = ['chatgpt'];

export interface CodexTokenFacts {
  /** sha256 of the file's bytes (hex). */
  sha256: string;
  /** A ChatGPT login with all three tokens and no API key (an API key would go around the workspace's model gateway). */
  chatgpt: boolean;
  /** `tokens.account_id`. */
  accountId: string | null;
  /** The id token's `https://api.openai.com/auth` `chatgpt_account_id`. */
  idTokenAccountId: string | null;
  /** `last_refresh` in ms. */
  lastRefresh: number | null;
  /** sha256 of the refresh token (hex): enough to see that it changed, nothing to use. */
  refreshTokenSha: string | null;
  /** The access token's JWT `exp` in ms, when it is a readable JWT. */
  accessExpiresAt: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v !== '';
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** The payload of a JWT, or null. Read here and not kept. */
export function jwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (part === undefined || part === '' || part.length > 16 * 1024) return null;
  try {
    const doc: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** Whether a parsed `auth.json` is a ChatGPT login with no API key and all three tokens (the shape `readCodexFileFacts` in signin.ts calls `valid`). */
export function isChatgptLogin(doc: unknown): boolean {
  if (!isRecord(doc)) return false;
  const t = isRecord(doc['tokens']) ? doc['tokens'] : {};
  const mode = doc['auth_mode'];
  return (
    typeof mode === 'string' &&
    CODEX_CHATGPT_MODES.includes(mode.toLowerCase()) &&
    (doc['OPENAI_API_KEY'] === null || doc['OPENAI_API_KEY'] === undefined) &&
    text(t['id_token']) &&
    text(t['access_token']) &&
    text(t['refresh_token'])
  );
}

/** What a file's bytes say, or null when they are not a JSON object of at most CODEX_AUTH_MAX_BYTES. */
export function codexTokenFacts(bytes: Buffer | string): CodexTokenFacts | null {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  if (buf.length === 0 || buf.length > CODEX_AUTH_MAX_BYTES) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  const t = isRecord(doc['tokens']) ? doc['tokens'] : {};
  const idClaims = text(t['id_token']) ? jwtPayload(t['id_token']) : null;
  const authClaims = idClaims !== null && isRecord(idClaims['https://api.openai.com/auth']) ? idClaims['https://api.openai.com/auth'] : null;
  const accessClaims = text(t['access_token']) ? jwtPayload(t['access_token']) : null;
  const exp = accessClaims?.['exp'];
  const refreshed = typeof doc['last_refresh'] === 'string' ? Date.parse(doc['last_refresh']) : Number.NaN;
  return {
    sha256: sha(buf),
    chatgpt: isChatgptLogin(doc),
    accountId: text(t['account_id']) ? t['account_id'] : null,
    idTokenAccountId: authClaims !== null && text(authClaims['chatgpt_account_id']) ? authClaims['chatgpt_account_id'] : null,
    lastRefresh: Number.isFinite(refreshed) ? refreshed : null,
    refreshTokenSha: text(t['refresh_token']) ? sha(t['refresh_token']) : null,
    accessExpiresAt: typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null,
  };
}

/** The account a sign-in is for, when both places that name it agree; null otherwise. */
export function accountOf(f: CodexTokenFacts | null): string | null {
  if (f === null || !f.chatgpt || f.accountId === null || f.idTokenAccountId === null || f.accountId !== f.idTokenAccountId) return null;
  return f.accountId;
}

/** How far in the future a `last_refresh` may lie (clocks differ a little); a later date is a forged or broken file. */
export const FUTURE_SLACK_MS = 5 * 60_000;

const inFuture = (ms: number | null, now: number): boolean => ms !== null && ms > now + FUTURE_SLACK_MS;

export type RenewalVerdict =
  | { ok: true }
  | { ok: false; reason: 'unchanged' | 'not_a_login' | 'no_main_copy' | 'other_account' | 'future_date' | 'not_newer' | 'same_refresh_token' | 'main_changed' };

/**
 * May `candidate` (a team's copy after its run renewed it) replace `main` (the machine's main copy)? `copiedIn` is what the run was given. All must hold: the candidate is a ChatGPT login
 * with all three tokens and no API key; it is the same account (in `tokens.account_id` and in the id token) as the main copy and as what was copied in; its `last_refresh` is not more than
 * five minutes in the future (a date of 9999 would win every later comparison and spread to every team), is later than what was copied in (a copied-in date in the future counts as
 * no date, so a real renewal repairs such a main copy), and its refresh token is another; and the main copy is still the one the run was given (else another run renewed first:
 * `main_changed`, and the main copy is kept).
 */
export function acceptRenewed(main: CodexTokenFacts | null, copiedIn: CodexTokenFacts, candidate: CodexTokenFacts | null, now: number = Date.now()): RenewalVerdict {
  if (candidate === null || !candidate.chatgpt) return { ok: false, reason: 'not_a_login' };
  if (candidate.sha256 === copiedIn.sha256) return { ok: false, reason: 'unchanged' };
  const mainAccount = accountOf(main);
  if (main === null || mainAccount === null) return { ok: false, reason: 'no_main_copy' };
  const account = accountOf(candidate);
  if (account === null || account !== mainAccount || account !== accountOf(copiedIn)) return { ok: false, reason: 'other_account' };
  if (inFuture(candidate.lastRefresh, now)) return { ok: false, reason: 'future_date' };
  const before = inFuture(copiedIn.lastRefresh, now) ? Number.NEGATIVE_INFINITY : copiedIn.lastRefresh;
  if (candidate.lastRefresh === null || before === null || candidate.lastRefresh <= before) return { ok: false, reason: 'not_newer' };
  if (candidate.refreshTokenSha === null || candidate.refreshTokenSha === copiedIn.refreshTokenSha) return { ok: false, reason: 'same_refresh_token' };
  if (main.sha256 !== copiedIn.sha256) return { ok: false, reason: 'main_changed' };
  return { ok: true };
}

/**
 * Should a running team's copy be replaced by the main copy (another team's run renewed the sign-in while this run went on)? Codex 0.166 reads `auth.json` again before it refreshes
 * (measured 2026-11-20, see docs/agent-bridge.md), so a fresher copy put in place is what its next renewal or retry uses instead of a refresh token that was already spent.
 * Yes when the main copy is a sign-in of the same account as the team's copy and was renewed later, and its date is not in the future (such a main copy needs repair, it is not newer).
 */
export function mainIsNewer(main: CodexTokenFacts | null, team: CodexTokenFacts | null, now: number = Date.now()): boolean {
  if (main === null || team === null || main.sha256 === team.sha256) return false;
  const a = accountOf(main);
  if (a === null || a !== accountOf(team)) return false;
  if (main.lastRefresh === null || inFuture(main.lastRefresh, now)) return false;
  return team.lastRefresh === null || inFuture(team.lastRefresh, now) || main.lastRefresh > team.lastRefresh;
}

/**
 * The file that is written to the main copy after an accepted renewal: rebuilt from known fields only, never the team's bytes (a team with full access writes that file, and any other
 * key it adds would reach every team). From the candidate: the four tokens and `last_refresh`. From the main copy (the bridge's own sign-in wrote them): `tokens.login_owner_id` and
 * `tokens.oauth_provenance` (`issuer`, `client_id`), so a team cannot point the next renewal at another sign-in server. `auth_mode` is "chatgpt" and `OPENAI_API_KEY` null.
 * The field set is Codex 0.166's `AuthDotJson`/`TokenData` as a real sign-in file has them (key names read on the devbox, 2026-11-20; no value read). Null when either file is not a sign-in.
 */
export function rebuildRenewed(candidateText: string, mainText: string): string | null {
  let cand: unknown;
  let main: unknown;
  try {
    cand = JSON.parse(candidateText);
    main = JSON.parse(mainText);
  } catch {
    return null;
  }
  if (!isRecord(cand) || !isRecord(main) || !isChatgptLogin(cand) || !isRecord(cand['tokens']) || typeof cand['last_refresh'] !== 'string') return null;
  const ct = cand['tokens'];
  const mt = isRecord(main['tokens']) ? main['tokens'] : {};
  const tokens: Record<string, unknown> = { id_token: ct['id_token'], access_token: ct['access_token'], refresh_token: ct['refresh_token'], account_id: ct['account_id'] };
  if (typeof mt['login_owner_id'] === 'string' && mt['login_owner_id'].length <= 512) tokens['login_owner_id'] = mt['login_owner_id'];
  const prov = mt['oauth_provenance'];
  if (isRecord(prov)) {
    const keep: Record<string, string> = {};
    for (const k of ['issuer', 'client_id']) if (typeof prov[k] === 'string' && (prov[k] as string).length <= 512) keep[k] = prov[k] as string;
    tokens['oauth_provenance'] = keep;
  }
  return `${JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens, last_refresh: cand['last_refresh'] }, null, 2)}\n`;
}

/** One log line for a refused write-back: the reason only, never a token. */
export function refusalLine(reason: Exclude<RenewalVerdict, { ok: true }>['reason']): string {
  switch (reason) {
    case 'main_changed':
      return 'two runs renewed the Codex sign-in at once; the main copy keeps the one written first';
    case 'other_account':
      return 'a team\'s Codex copy names another account; it was not copied back';
    case 'not_a_login':
      return 'a team\'s Codex copy is not a ChatGPT sign-in; it was not copied back';
    case 'no_main_copy':
      return 'the machine has no Codex sign-in any more; the team\'s copy was not copied back';
    case 'future_date':
      return 'a team\'s Codex copy is dated in the future; it was not copied back';
    case 'not_newer':
    case 'same_refresh_token':
      return 'a team\'s Codex copy changed but was not renewed; it was not copied back';
    case 'unchanged':
      return 'nothing to copy back';
  }
}
