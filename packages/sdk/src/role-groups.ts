import type { RoleGroup } from '@manythreads/shared';
import type { PluginTx, ProviderImpl } from './types.ts';

// The one definition of a team's role groups (P14-03), as other plugins see it: `ctx.providers.get<RoleGroupProvider>('role.groups')`, registered by the
// teams plugin (`provider.role.groups`). A role tag a team defines in `TEAM.md` (`role:on-call`) is a group: the people of the team who hold it, answering to
// the handle `@on-call`. The channels plugin reads it to notify a mention and to fill the `@` picker, and the tasks plugin reads it to decide whether a bot
// may hand a card to a person named by `handover.toPerson: [role:on-call]`. Nobody keeps a second table of groups; the tags and who holds them stay in
// the tables the teams plugin already owns. Look it up when a request arrives, not in `register` (teams may load after you).

export interface RoleGroupProvider extends ProviderImpl {
  id: 'role.groups';
  /**
   * The groups of a team the caller may read, in handle order, each with the ids of the people on the team who hold the tag. A tag whose `@` form a person
   * or a bot of the team already answers to is still listed but not `mentionable` (see `roleGroups` in `@manythreads/shared`): mention code must skip it,
   * a check by tag name (`handover.toPerson`) may use it. A caller who may not read the team gets `[]`,
   * the same as a team with no tags, so the answer never says that a team exists. Runs as the transaction's actor.
   */
  list(tx: PluginTx, teamId: string, options?: RoleGroupListOptions): Promise<RoleGroup[]>;
}

export interface RoleGroupListOptions {
  /**
   * The handles the caller is about to look up (a message that names `@pager`). Only a hint to skip work: when the team defines no role tag at all, or every
   * handle is a bot's slug, the answer is `[]` without reading the roster. The result may still hold other groups; filter by handle yourself.
   */
  handles?: readonly string[];
}
