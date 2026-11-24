import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { serverSigninScope, setServerSigninScope, setServerSigninUnreadable, type BridgeConfig, type SigninAgentKey, type SigninScope } from './config.ts';
import { isSlug } from './team-user.ts';

// Who signs an enrolled server's Claude and Codex in (P35-10b, docs/plans/per-team-sign-in.md section 7): the bridge keeps the choice itself, in its state folder, so a run never
// carries it and a restart keeps it. The site sets it with `POST /v1/signin/scope` after the old sign-ins were signed out for real, and reads it back in the tunnel's hello.
//
// The file also lists the teams that have (or may have) a sign-in folder of their own per agent: every team a per-team sign-in call named. A switch back to one sign-in removes each of
// them, and the hello names those still listed while the agent has one sign-in (a folder left behind).
//
// The order is the rule: the file is written (a new file, then a rename) BEFORE the choice in memory changes, so a write that fails changes nothing. A missing file is "one sign-in"
// (every server before P35-10b); a file that is there and cannot be read is an error the hello reports, and the bridge refuses Claude and Codex runs until a switch writes it again.

export const SIGNIN_SCOPE_FILE = 'signin-scope.json';

const AGENTS: readonly SigninAgentKey[] = ['claude', 'codex'];
const isScope = (v: unknown): v is SigninScope => v === 'shared' || v === 'per_team';

const ownTeams = new WeakMap<BridgeConfig, Record<SigninAgentKey, string[]>>();

/** The teams that may have a sign-in folder of their own for an agent (see above). */
export function ownSigninTeams(config: BridgeConfig, agent: SigninAgentKey): string[] {
  return [...(ownTeams.get(config)?.[agent] ?? [])];
}

/** Reads the kept choice into the config. `missing`: one sign-in for both. `unreadable`: logged by the caller; the config is marked so (runs refused, the hello says so). */
export function loadSigninScope(config: BridgeConfig, file: string): 'ok' | 'missing' | 'unreadable' {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    setServerSigninUnreadable(config, true);
    return 'unreadable';
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const rec = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (rec === null || AGENTS.some((a) => rec[a] !== undefined && !isScope(rec[a]))) {
    setServerSigninUnreadable(config, true);
    return 'unreadable';
  }
  for (const agent of AGENTS) {
    const v = rec[agent];
    if (isScope(v)) setServerSigninScope(config, agent, v);
  }
  const own = typeof rec['own'] === 'object' && rec['own'] !== null ? (rec['own'] as Record<string, unknown>) : {};
  ownTeams.set(config, {
    claude: Array.isArray(own['claude']) ? own['claude'].filter(isSlug).slice(0, 2000) : [],
    codex: Array.isArray(own['codex']) ? own['codex'].filter(isSlug).slice(0, 2000) : [],
  });
  return 'ok';
}

export interface ScopeChange {
  agent: SigninAgentKey;
  scope?: SigninScope;
  addOwn?: readonly string[];
  removeOwn?: readonly string[];
}

/**
 * Writes the choice with one change applied, then applies it in memory. A write that fails throws and leaves memory as it was. Without a file (tests) only memory changes.
 */
export function saveSigninScope(config: BridgeConfig, file: string | undefined, change: ScopeChange): void {
  const scopes: Record<SigninAgentKey, SigninScope> = { claude: serverSigninScope(config, 'claude'), codex: serverSigninScope(config, 'codex') };
  const own: Record<SigninAgentKey, string[]> = { claude: ownSigninTeams(config, 'claude'), codex: ownSigninTeams(config, 'codex') };
  if (change.scope !== undefined) scopes[change.agent] = change.scope;
  const set = new Set([...own[change.agent], ...(change.addOwn ?? [])]);
  for (const t of change.removeOwn ?? []) set.delete(t);
  own[change.agent] = [...set].sort();
  if (file !== undefined) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.new`;
    writeFileSync(tmp, `${JSON.stringify({ ...scopes, own })}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
  for (const agent of AGENTS) setServerSigninScope(config, agent, scopes[agent]);
  ownTeams.set(config, own);
  setServerSigninUnreadable(config, false);
}
