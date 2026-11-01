import type { PluginTx, RoleGroupListOptions, RoleGroupProvider } from '@manythreads/sdk';
import { roleGroups, type RoleGroup } from '@manythreads/shared';
import { rosterRows } from './routes-roster.ts';

/**
 * A team's role groups (P14-03): the `role.groups` provider other plugins ask. Tags and holders both come from the roster's own `tags` column (the team's
 * defined tags that each member holds), read through `app.teams_roster`, which answers nothing to a caller who may not read the team and does answer a bot
 * of the team (the `roles` table itself is hidden from bots, so it is not read here). A tag nobody holds is therefore no group, which changes nothing: it
 * reaches nobody. The names a tag must not take over are the roster's people and the team's bots. The rule itself is `roleGroups` in `@manythreads/shared`.
 */
export function createRoleGroupProvider(): RoleGroupProvider {
  return {
    id: 'role.groups',
    async list(tx: PluginTx, teamId: string, options: RoleGroupListOptions = {}): Promise<RoleGroup[]> {
      // The cheap checks first: a team with no role tag has no groups, and a word that is a bot's slug is that bot's, so neither needs the roster.
      const anyTag = (await tx.query<{ ok: boolean }>('SELECT EXISTS (SELECT 1 FROM app.team_role_tags WHERE team_id = $1) AS ok', [teamId])).rows[0]?.ok === true;
      if (!anyTag) return [];
      const bots = await teamBotSlugs(tx, teamId);
      const wanted = options.handles ?? [];
      if (wanted.length > 0 && wanted.every((h) => bots.includes(h.toLowerCase()))) return [];
      const roster = await rosterRows(tx, teamId);
      if (roster.length === 0) return [];
      const held = [...new Set(roster.flatMap((m) => m.tags))];
      return roleGroups({
        tags: held.map((tag) => ({ tag, personIds: roster.filter((m) => m.tags.includes(tag)).map((m) => m.person_id) })),
        people: roster.map((m) => ({ displayName: m.display_name, email: m.email })),
        botSlugs: bots,
      });
    },
  };
}

/** The slugs of the team's bots. The bots plugin may not be installed, and then no bot can be mentioned. */
export async function teamBotSlugs(tx: PluginTx, teamId: string): Promise<string[]> {
  const exists = (await tx.query<{ ok: boolean }>("SELECT to_regclass('app.bots') IS NOT NULL AS ok")).rows[0]?.ok === true;
  if (!exists) return [];
  return (await tx.query<{ slug: string }>('SELECT slug FROM app.bots WHERE team_id = $1', [teamId])).rows.map((r) => r.slug);
}
