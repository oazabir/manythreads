import type { PluginTx } from '@manythreads/sdk';

/**
 * Whether a bot that may tag `mayTag` names — its `tasks.handoff` grant's `constraints.mayTag`, compiled by the bots loader from `BOT.md`
 * `handover.mayTag` (PLAN P6-03) — may hand a card to `toActorId`. A bot is named by its slug; a person by `person:<person id>` or by one of
 * their role names. The route and the `tasks.handoff` tool both ask this, so a bot cannot reach by tool what the board refuses by HTTP.
 */
export async function mayHandoffToActor(tx: PluginTx, mayTag: readonly string[], toActorId: string): Promise<boolean> {
  if (mayTag.length === 0) return false;
  const target = (await tx.query<{ kind: string; ref_id: string | null }>('SELECT o_kind AS kind, o_ref_id AS ref_id FROM app.tasks_actor_of($1::uuid)', [toActorId])).rows[0];
  if (!target?.ref_id) return false;
  if (target.kind === 'bot') {
    const slug = (await tx.query<{ slug: string }>('SELECT slug FROM app.bots WHERE id = $1::uuid', [target.ref_id])).rows[0]?.slug;
    return slug !== undefined && mayTag.includes(slug);
  }
  if (target.kind !== 'person') return false;
  if (mayTag.includes(`person:${target.ref_id}`)) return true;
  const roles = await tx.query<{ name: string }>('SELECT r.name FROM app.role_members rm JOIN app.roles r ON r.id = rm.role_id WHERE rm.person_id = $1::uuid', [
    target.ref_id,
  ]);
  return roles.rows.some((r) => mayTag.includes(r.name));
}

/** The targets a bot's own grant names, or `[]` for a person or the system (who are bounded by their team role instead). */
export async function handoverAllowlist(tx: PluginTx, actorId: string): Promise<readonly string[] | null> {
  const caller = (await tx.query<{ kind: string }>('SELECT kind FROM app.actors WHERE id = $1::uuid', [actorId])).rows[0];
  if (caller?.kind !== 'bot') return null;
  const grant = (
    await tx.query<{ constraints: { mayTag?: unknown } | null }>(`SELECT constraints FROM app.capability_grants WHERE actor_id = $1::uuid AND capability = 'tasks.handoff'`, [actorId])
  ).rows[0];
  const mayTag = grant?.constraints?.mayTag;
  return Array.isArray(mayTag) ? mayTag.filter((t): t is string => typeof t === 'string') : [];
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
