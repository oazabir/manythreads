import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { SetupInventory, type SetupAskerRole } from '@manythreads/shared';
import { readTeamDefaults, type TeamDefaults } from './team-defaults.ts';

// `describe_self`: what the setup helper is shown about the team (PLAN P7-02). It is built in the transaction of the person who asked, so every list is what that person may read, and
// by hand from names only: no address, key, token, message text or anything of another team is in it. The runner list comes from `app.bot_runners_for_team`, which returns names,
// labels, kinds and states and nothing else. The model aliases are read with the workspace's own system transaction (the catalog is admin-only) and are names too.

export interface SetupTeam {
  id: string;
  slug: string;
  name: string;
  workspaceId: string;
}

/** The ways a bot can be started and whether one exists in this release. */
const TRIGGERS: SetupInventory['triggers'] = [
  { type: 'conversation', available: true },
  { type: 'mention', available: true },
  { type: 'channel_message', available: true },
  { type: 'task_assigned', available: true },
  { type: 'routine', available: true },
  { type: 'inbox', available: true, note: 'Starts when a mail arrives on a mailbox the team has connected. The mailbox and its email tools are given to a bot on its own page; the setup helper cannot give a bot a connection yet.' },
  { type: 'drop', available: true, note: 'Starts when something is dropped into the team memory inbox. Each team has one Archivist for this, so a bot made here would only compete with it and the setup helper does not make one.' },
  { type: 'webhook', available: true, note: 'Starts when a work app (GitHub, Zendesk, Jira and others) sends an event to an address a lead makes for the channel. The bot’s trigger names that address by its short name. The setup helper cannot make the address, so a lead adds it at the channel’s Integrations screen, under Work apps.' },
];

/** The model aliases a bot of a team may be pointed at. */
const BOT_ALIASES = ['smart', 'fast', 'code', 'local'];

const CONNECTIONS_NOTE = 'A team can connect a mailbox and other apps, but the setup helper cannot give a bot a connection yet: an admin or lead adds it on the bot’s own page.';

export async function askerRole(tx: PluginTx, teamId: string): Promise<{ role: SetupAskerRole; onTeam: boolean; canGrantDestructive: boolean; canAddBot: boolean }> {
  const row = (
    await tx.query<{ ws: string | null; team: string | null; manage: boolean | null }>(
      "SELECT app.lookup_workspace_role() AS ws, app.lookup_team_role($1::uuid) AS team, app.can('team', $1::uuid, 'manage') AS manage",
      [teamId],
    )
  ).rows[0];
  const admin = row?.ws === 'owner' || row?.ws === 'admin';
  const lead = row?.manage === true || row?.team === 'lead';
  return { role: admin ? 'admin' : lead ? 'lead' : 'member', onTeam: admin || row?.team != null, canGrantDestructive: admin || lead, canAddBot: admin };
}

/** TEAM.md at the head of the team's repo, or null. */
async function teamMdOf(ctx: PluginContext, tx: PluginTx, teamId: string): Promise<string | null> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return null;
  try {
    return new TextDecoder().decode((await repo.blob(tx, teamId, 'TEAM.md', 'HEAD')).content);
  } catch {
    return null;
  }
}

export async function currentTeamMd(ctx: PluginContext, tx: PluginTx, teamId: string): Promise<string | null> {
  return teamMdOf(ctx, tx, teamId);
}

/** The folder names under `skills/` (a skill is `skills/<name>/...`). */
async function skillsOf(ctx: PluginContext, tx: PluginTx, teamId: string): Promise<Array<{ slug: string }>> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return [];
  try {
    return (await repo.list(tx, teamId, 'skills')).filter((e) => e.kind === 'folder').map((e) => ({ slug: e.name })).slice(0, 100);
  } catch {
    return [];
  }
}

export async function buildInventory(ctx: PluginContext, tx: PluginTx, team: SetupTeam): Promise<{ inventory: SetupInventory; defaults: TeamDefaults }> {
  const who = await askerRole(tx, team.id);
  const teamMd = await teamMdOf(ctx, tx, team.id);
  const defaults = readTeamDefaults(teamMd);

  const bots = (
    await tx.query<{ slug: string; name: string; role: string; kind: string; runtime: string; status: string }>(
      'SELECT slug, name, role, kind, runtime, status FROM app.bots WHERE team_id = $1::uuid ORDER BY name, slug LIMIT 100',
      [team.id],
    )
  ).rows;
  const knowledge = (await tx.query<{ slug: string; name: string }>('SELECT slug, name FROM app.knowledge_bases WHERE team_id = $1::uuid ORDER BY slug LIMIT 100', [team.id])).rows;
  const runners = (
    await tx.query<{ name: string; label: string; kind: string; status: string; is_default: boolean }>('SELECT name, label, kind, status, is_default FROM app.bot_runners_for_team($1::uuid) LIMIT 50', [team.id])
  ).rows;
  const channels = (
    await tx.query<{ name: string }>("SELECT name FROM app.channels WHERE team_id = $1::uuid AND kind = 'channel' AND NOT private AND archived_at IS NULL ORDER BY position, name LIMIT 100", [team.id])
  ).rows;
  const roleTags = (
    await tx.query<{ name: string }>('SELECT r.name FROM app.team_role_tags t JOIN app.roles r ON r.id = t.role_id WHERE t.team_id = $1::uuid ORDER BY r.name LIMIT 50', [team.id])
  ).rows;
  // which aliases the workspace has bound (an admin-only table): names only, read for this workspace
  const models = await ctx.db.system(
    async (sys) => (await sys.query<{ alias: string }>('SELECT alias FROM app.llm_aliases WHERE workspace_id = $1::uuid AND alias = ANY ($2::text[]) ORDER BY alias', [team.workspaceId, BOT_ALIASES])).rows,
    { workspaceId: team.workspaceId },
  );

  const inventory = SetupInventory.parse({
    team: { slug: team.slug, name: team.name },
    asker: { role: who.role, canGrantDestructive: who.canGrantDestructive, canAddBot: who.canAddBot },
    bots,
    knowledge,
    skills: await skillsOf(ctx, tx, team.id),
    runners: runners.map((r) => ({ name: r.name, label: r.label, kind: r.kind, status: r.status, isDefault: r.is_default })),
    models,
    channels,
    roleTags: roleTags.map((r) => r.name),
    capabilities: ctx.runs
      .catalog()
      .map((c) => ({ name: c.name, destructive: c.destructive }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 300),
    triggers: TRIGGERS,
    runtimeAllowed: defaults.runtimeAllowed,
    guardDefault: defaults.guardPreset,
    connections: [],
    connectionsNote: CONNECTIONS_NOTE,
  });
  return { inventory, defaults };
}

/** The inventory fields a decision rests on; they come first in what the helper reads and are never cut. */
const POLICY_FIELDS = ['asker', 'runtimeAllowed', 'guardDefault', 'triggers', 'connections', 'connectionsNote', 'team'] as const;
/** The lists, smallest need first; the longest is cut first when the answer is too long. */
const LIST_FIELDS = ['roleTags', 'models', 'runners', 'knowledge', 'skills', 'channels', 'bots', 'capabilities'] as const;

/**
 * What `describe_self` hands the helper: the inventory with the fields that decide what is allowed FIRST (who is asking and what they may grant, what the team allows, the default guard, the
 * ways to start a bot) and the long lists after them. An answer that is too long loses items from the longest list, never a policy field, and says how many it left out. The full inventory
 * stays with the session (the checks use it, not this view). `budget` is in characters of the JSON the helper reads.
 */
export function helperView(inv: SetupInventory, budget: number): { inventory: Record<string, unknown>; omitted: Record<string, number> } {
  const view: Record<string, unknown> = {};
  for (const key of POLICY_FIELDS) view[key] = inv[key];
  const lists: Record<string, unknown[]> = {};
  for (const key of LIST_FIELDS) lists[key] = [...inv[key]];
  const omitted: Record<string, number> = {};
  const build = (): { inventory: Record<string, unknown>; omitted: Record<string, number> } => ({ inventory: { ...view, ...lists }, omitted: { ...omitted } });
  const size = (): number => JSON.stringify({ ok: true, ...build(), note: '' }).length + 260;
  while (size() > budget) {
    let longest: string | null = null;
    let longestChars = 0;
    for (const key of LIST_FIELDS) {
      const items = lists[key] as unknown[];
      if (items.length === 0) continue;
      const chars = JSON.stringify(items).length;
      if (chars > longestChars) {
        longest = key;
        longestChars = chars;
      }
    }
    if (longest === null) break;
    const items = lists[longest] as unknown[];
    const keep = Math.floor(items.length / 2);
    omitted[longest] = (omitted[longest] ?? 0) + (items.length - keep);
    lists[longest] = items.slice(0, keep);
  }
  return build();
}
