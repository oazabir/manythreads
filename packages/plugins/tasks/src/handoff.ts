import type { PluginTx, RoleGroupProvider } from '@manythreads/sdk';

/**
 * Whether a bot may hand a card to `toActorId`. The bot's `tasks.handoff` grant carries two lists the bots loader compiles from `BOT.md`: `mayTag`
 * (`handover.mayTag`, the bots it may hand to, by slug) and `toPerson` (`handover.toPerson`, the people: `person:<person id>` or `role:<tag>`). A person is
 * allowed when named by id, or when they hold a listed role tag on the bot's team. The tag is resolved by the teams plugin's role groups
 * (`ctx.providers.get('role.groups')`, P14-03), the same set `@on-call` notifies, so there is one definition of who holds a tag; without that provider a
 * role names nobody. The route and the `tasks.handoff` tool both ask this, so a bot cannot reach by tool what the board refuses by HTTP.
 */
export async function mayHandoffToActor(
  tx: PluginTx,
  mayTag: readonly string[],
  toActorId: string,
  options: { toPerson?: readonly string[]; groups?: RoleGroupProvider | undefined } = {},
): Promise<boolean> {
  const toPerson = options.toPerson ?? [];
  if (mayTag.length === 0 && toPerson.length === 0) return false;
  const target = (await tx.query<{ kind: string; ref_id: string | null }>('SELECT o_kind AS kind, o_ref_id AS ref_id FROM app.tasks_actor_of($1::uuid)', [toActorId])).rows[0];
  if (!target?.ref_id) return false;
  if (target.kind === 'bot') {
    const slug = (await tx.query<{ slug: string }>('SELECT slug FROM app.bots WHERE id = $1::uuid', [target.ref_id])).rows[0]?.slug;
    return slug !== undefined && mayTag.includes(slug);
  }
  if (target.kind !== 'person') return false;
  const principals = [...mayTag, ...toPerson];
  if (principals.includes(`person:${target.ref_id}`)) return true;
  const tags = new Set(principals.filter((p) => p.startsWith('role:')));
  if (tags.size === 0 || !options.groups) return false;
  const team = (await tx.query<{ team_id: string }>(`SELECT b.team_id FROM app.actors a JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot' WHERE a.id = $1::uuid`, [tx.actor.id])).rows[0];
  if (!team) return false;
  return (await options.groups.list(tx, team.team_id)).some((g) => tags.has(g.tag) && g.personIds.includes(target.ref_id as string));
}

/** The targets a bot's own grant names, or `null` for a person or the system (who are bounded by their team role instead). */
export async function handoverAllowlist(tx: PluginTx, actorId: string): Promise<readonly string[] | null> {
  return (await handoverGrant(tx, actorId))?.mayTag ?? null;
}

/** The people a bot's own grant names (`handover.toPerson`: `person:<id>`, `role:<tag>`); empty for a person, the system or a bot that names none. */
export async function handoverPeople(tx: PluginTx, actorId: string): Promise<readonly string[]> {
  return (await handoverGrant(tx, actorId))?.toPerson ?? [];
}

async function handoverGrant(tx: PluginTx, actorId: string): Promise<{ mayTag: string[]; toPerson: string[] } | null> {
  const caller = (await tx.query<{ kind: string }>('SELECT kind FROM app.actors WHERE id = $1::uuid', [actorId])).rows[0];
  if (caller?.kind !== 'bot') return null;
  const grant = (
    await tx.query<{ constraints: { mayTag?: unknown; toPerson?: unknown } | null }>(`SELECT constraints FROM app.capability_grants WHERE actor_id = $1::uuid AND capability = 'tasks.handoff'`, [actorId])
  ).rows[0];
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []);
  return { mayTag: strings(grant?.constraints?.mayTag), toPerson: strings(grant?.constraints?.toPerson) };
}

/**
 * A bot may always hand a card back to the actor that created it, even when its `handover.mayTag` does not name them (live bug: a Deployer was
 * told to hand its card back to Orchestrator, whose slug was not in its list, so the handover was refused and the card stayed put). Only the
 * creator is exempt; every other target still has to be in the list, and the database door still decides whether this caller may move the card.
 */
export async function isCardCreator(tx: PluginTx, taskId: string, actorId: string): Promise<boolean> {
  const row = (await tx.query<{ created_by: string }>('SELECT created_by FROM app.tasks WHERE id = $1::uuid', [taskId])).rows[0];
  return row?.created_by === actorId;
}
