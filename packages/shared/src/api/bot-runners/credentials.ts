import { z } from 'zod';
import { BotRunner } from '../../entities/bot-runner.ts';
import { BotRunnerId, TeamId } from '../../ids.ts';

// The Claude Code runner's sign-in file (PLAN Phase 19, P19-06). The admin uploads `.credentials.json` as it is; the server stores the bytes exactly and keeps only
// metadata. This module is the one reader of the file's SHAPE, used by the browser (to show a summary before upload) and by the server (to refuse a bad file).
// It reads; it never rebuilds or re-serialises the text, and no function here returns a token.

/** The largest sign-in file the route reads. A real one is about 5 KB; the rest is room for the other sign-ins a file can hold. */
export const MAX_CREDENTIALS_BYTES = 256 * 1024;

/** What the check on a saved file can say. Fixed words: they come from the pod, and the page words each in its own sentence. */
export const ClaudeSigninCheck = z.enum(['ok', 'rejected', 'expired', 'no_scope', 'limit', 'unreachable']);
export type ClaudeSigninCheck = z.infer<typeof ClaudeSigninCheck>;

export interface ClaudeCredentialsSummary {
  /** For example "Max plan · 20x"; "Claude plan" when the file does not say. */
  planLabel: string;
  /** Milliseconds since the epoch, when the access token runs out (the CLI renews it itself). */
  expiresAt: number;
  /** How many other sign-ins (`mcpOAuth` entries) the file holds. */
  otherSignins: number;
  /** The first few service names of those, for the page's sentence. Names only, never a value. */
  otherNames: string[];
}

export type ClaudeCredentialsInspection = { ok: true; summary: ClaudeCredentialsSummary; refreshToken: string } | { ok: false; message: string };

const NOT_A_FILE = 'That is not a Claude sign-in file. Choose the .credentials.json from a Claude login.';

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The plan as the page words it, from the file's `subscriptionType` and `rateLimitTier` ("max", "default_claude_max_20x"). */
function planOf(oauth: Record<string, unknown>): string {
  const type = typeof oauth['subscriptionType'] === 'string' ? oauth['subscriptionType'] : '';
  const tier = typeof oauth['rateLimitTier'] === 'string' ? oauth['rateLimitTier'] : '';
  const name = type === 'max' ? 'Max' : type === 'pro' ? 'Pro' : type === 'team' ? 'Team' : type === 'enterprise' ? 'Enterprise' : '';
  const mult = /(\d+)x/.exec(tier)?.[1];
  if (name === '') return 'Claude plan';
  return mult ? `${name} plan · ${mult}x` : `${name} plan`;
}

/**
 * Reads a sign-in file's text and says what it is, or why it is refused. A `__proto__` key anywhere refuses the file (it is data, not a sign-in file). The input is read once and
 * not kept. `refreshToken` is returned for the server's keyed hash and must never be logged, echoed or stored; the browser ignores it.
 */
export function inspectClaudeCredentials(text: string, now: number = Date.now()): ClaudeCredentialsInspection {
  if (text.length > MAX_CREDENTIALS_BYTES) return { ok: false, message: 'That file is too large to be a Claude sign-in file.' };
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
  if (danger || !isObject(parsed) || !hasOwn(parsed, 'claudeAiOauth')) return { ok: false, message: NOT_A_FILE };
  const oauth = parsed['claudeAiOauth'];
  if (!isObject(oauth)) return { ok: false, message: NOT_A_FILE };
  const access = oauth['accessToken'];
  const refresh = oauth['refreshToken'];
  const expiresAt = oauth['expiresAt'];
  if (typeof access !== 'string' || access === '' || typeof refresh !== 'string' || refresh === '' || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { ok: false, message: NOT_A_FILE };
  }
  const scopes = oauth['scopes'];
  if (!Array.isArray(scopes) || !scopes.includes('user:inference')) {
    return { ok: false, message: 'This sign-in cannot run Claude Code (it lacks the "user:inference" permission). Log in again with the full Claude Code login and upload that file.' };
  }
  const mcp = hasOwn(parsed, 'mcpOAuth') && isObject(parsed['mcpOAuth']) ? parsed['mcpOAuth'] : {};
  const keys = Object.keys(mcp);
  // `expiresAt` is the access token's. A file whose access token ran out is fine (the CLI renews it with the refresh token); `now` is accepted so a caller may word it.
  void now;
  return {
    ok: true,
    refreshToken: refresh,
    summary: { planLabel: planOf(oauth), expiresAt, otherSignins: keys.length, otherNames: keys.slice(0, 5).map((k) => k.split(/[|:]/)[0] ?? k).filter((k) => k !== '') },
  };
}

// Routes ---------------------------------------------------------------------------------------------------------------------------------------------
export const PutClaudeCredentialsResponse = z.object({ runner: BotRunner, replaced: z.boolean() });
export type PutClaudeCredentialsResponse = z.infer<typeof PutClaudeCredentialsResponse>;
/** The body is the file's bytes (`application/json`); `x-terms-ack: 1` and `x-signins-ack: 1` say the admin ticked both boxes. */
export const putClaudeCredentialsRoute = { method: 'PUT', path: '/api/admin/bot-runners/:id/credentials' } as const;
export const CREDENTIALS_TERMS_HEADER = 'x-terms-ack';
export const CREDENTIALS_SIGNINS_HEADER = 'x-signins-ack';

export const RemoveClaudeCredentialsResponse = z.object({ runner: BotRunner });
export type RemoveClaudeCredentialsResponse = z.infer<typeof RemoveClaudeCredentialsResponse>;
export const removeClaudeCredentialsRoute = { method: 'DELETE', path: '/api/admin/bot-runners/:id/credentials' } as const;

export const CheckClaudeSigninResponse = z.object({ result: ClaudeSigninCheck, message: z.string(), runner: BotRunner });
export type CheckClaudeSigninResponse = z.infer<typeof CheckClaudeSigninResponse>;
export const checkClaudeSigninRoute = { method: 'POST', path: '/api/admin/bot-runners/:id/check' } as const;

export const ClaudeRunnerUsageRow = z.object({
  runnerId: BotRunnerId,
  teamId: TeamId,
  teamName: z.string(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runs: z.number().int().nonnegative(),
  seconds: z.number().int().nonnegative(),
  /** The Claude CLI's own cost figure, summed. Its number, not a price. */
  cliCost: z.number().nonnegative(),
});
export type ClaudeRunnerUsageRow = z.infer<typeof ClaudeRunnerUsageRow>;
export const ClaudeRunnerUsageResponse = z.object({ items: z.array(ClaudeRunnerUsageRow) });
export type ClaudeRunnerUsageResponse = z.infer<typeof ClaudeRunnerUsageResponse>;
export const claudeRunnerUsageRoute = { method: 'GET', path: '/api/admin/bot-runners/usage' } as const;
