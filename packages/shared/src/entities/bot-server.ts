import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotServerId, WorkspaceId } from '../ids.ts';

// An enrolled server (PLAN Phase 26, P26-12/13, docs/plans/agents-anywhere.md §5): a machine outside the cluster where the installer put the agent bridge. Every enum
// matches a CHECK of the bot-runners migration 0008_bot_servers.sql; the kernel's schema-enums test compares the two.

/** A server's name: short, lower case, never changes. Each agent found on it becomes a runner called `<name>-claude`, `<name>-codex` or `<name>-hermes`, so the name leaves room for that. */
export const BotServerName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'lowercase letters, digits and "-", at most 31 characters');
export type BotServerName = z.infer<typeof BotServerName>;

/** `waiting`: made, never connected. `connected`: its connection is open now. `offline`: it connected before and is not connected now. */
export const BotServerStatus = z.enum(['waiting', 'connected', 'offline']);
export type BotServerStatus = z.infer<typeof BotServerStatus>;

/** The agents the bridge can find on a machine, in the words the bridge's config uses. */
export const BotServerAgentName = z.enum(['claude-code', 'codex', 'hermes-acp']);
export type BotServerAgentName = z.infer<typeof BotServerAgentName>;

export const BotServerAgent = z.object({ agent: BotServerAgentName, version: z.string().max(80).nullable() });
export type BotServerAgent = z.infer<typeof BotServerAgent>;

/** What the installer and the bridge say about the machine. Free text, bounded; shown to admins only. */
export const BotServerHost = z.object({
  hostname: z.string().max(120),
  system: z.string().max(120),
  arch: z.string().max(40),
});
export type BotServerHost = z.infer<typeof BotServerHost>;

/** A server as a workspace admin sees it. No key, no code and no hash is here: `enrolled` says a key exists, `codeExpiresAt` that a code is waiting to be used. */
export const BotServer = z.object({
  id: BotServerId,
  workspaceId: WorkspaceId,
  name: BotServerName,
  label: z.string(),
  status: BotServerStatus,
  host: BotServerHost.nullable(),
  bridgeVersion: z.string().max(40).nullable(),
  agents: z.array(BotServerAgent),
  /** The machine allows full access for Claude Code or Codex (the installer's default from P35-01, unless `--no-full-access`; never on a server without team users): the machine's half of the rule (the site's half is the runner's switch). */
  allowFullAccess: z.boolean(),
  enrolled: z.boolean(),
  /** A one-time code is waiting to be used, until this time. Null: none. */
  codeExpiresAt: IsoDateTime.nullable(),
  lastSeenAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotServer = z.infer<typeof BotServer>;
