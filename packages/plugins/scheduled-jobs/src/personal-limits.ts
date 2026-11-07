import type { PluginTx } from '@manythreads/sdk';
import {
  PERSONAL_ROUTINE_LIMITS,
  ROUTINE_SOURCE_CONNECTION,
  ROUTINE_SOURCE_LABELS,
  type PersonalRoutineStopReason,
  type RoutineQuietHours,
  type RoutineSettings,
  type RoutineSource,
} from '@manythreads/shared';

// What a person's routines are held to (P20-14): who may have routines, their time zone and quiet hours, the monthly spending allowance, and the checks that decide
// whether a routine may run now (its bot, the person's yes to that bot, the connections it reads from). The same checks serve the routes (as the person) and the
// scheduler (as the system role); every statement runs under row level security either way.

export interface Member {
  personId: string;
  actorId: string;
  workspaceId: string;
}

/** The caller as a member who has a Personal space (owner, admin or member): a guest, a bot and a suspended person have none and so no routines. */
export async function requireMemberOrNull(tx: PluginTx): Promise<Member | null> {
  const r = (
    await tx.query<{ role: string | null; person_id: string | null; workspace_id: string | null; actor_id: string | null }>(
      'SELECT app.lookup_workspace_role() AS role, app.person_id() AS person_id, app.workspace_id() AS workspace_id, app.actor() AS actor_id',
    )
  ).rows[0];
  if (!r?.person_id || !r.workspace_id || !r.actor_id || r.role === null || r.role === 'guest') return null;
  return { personId: r.person_id, actorId: r.actor_id, workspaceId: r.workspace_id };
}

export async function getSettings(tx: PluginTx, personId: string): Promise<RoutineSettings> {
  const row = (
    await tx.query<{ time_zone: string | null; quiet_from: string | null; quiet_to: string | null }>(
      'SELECT time_zone, quiet_from, quiet_to FROM app.routine_person_settings WHERE person_id = $1::uuid',
      [personId],
    )
  ).rows[0];
  const quietHours: RoutineQuietHours | null = row?.quiet_from && row.quiet_to ? { from: row.quiet_from, to: row.quiet_to } : null;
  return { timeZone: row?.time_zone ?? null, quietHours };
}

/** The monthly allowance per person for the workspace: the admin's setting, else the default of 5 US dollars. */
export async function monthlyCapUsd(tx: PluginTx, workspaceId: string): Promise<number> {
  const row = (await tx.query<{ monthly_cap_usd: string }>('SELECT monthly_cap_usd FROM app.routine_workspace_settings WHERE workspace_id = $1::uuid', [workspaceId])).rows[0];
  return row ? Number(row.monthly_cap_usd) : PERSONAL_ROUTINE_LIMITS.monthlyCapUsdDefault;
}

/** The first instant of the calendar month in UTC. */
export const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** What the person's routines spent this month, as the person asks (the definer function answers only to the person themself). */
export async function spentAsPerson(tx: PluginTx, personId: string, now: Date): Promise<number> {
  const r = (await tx.query<{ s: string }>('SELECT app.routine_spend_month($1::uuid, $2::timestamptz) AS s', [personId, monthStart(now)])).rows[0];
  return Number(r?.s ?? 0);
}

/** The same sum for the scheduler (the system role reads the ledger directly). */
export async function spentAsSystem(tx: PluginTx, personId: string, now: Date): Promise<number> {
  const r = (
    await tx.query<{ s: string }>(
      `SELECT coalesce(sum(s.cost_usd), 0) AS s FROM app.scheduled_job_runs r JOIN app.llm_spend s ON s.run_id = r.run_id
        WHERE r.owner_person_id = $1::uuid AND r.started_at >= $2::timestamptz`,
      [personId, monthStart(now)],
    )
  ).rows[0];
  return Number(r?.s ?? 0);
}

/** The kinds of enabled connection the person owns (their own mail and calendar accounts). */
export async function personConnectionKinds(tx: PluginTx, personId: string): Promise<Set<string>> {
  const rows = (
    await tx.query<{ kind: string }>(
      `SELECT DISTINCT c.kind FROM app.connections c JOIN app.actors a ON a.id = c.owner_id AND a.kind = 'person'
        WHERE c.scope = 'person' AND a.ref_id = $1::uuid AND c.status = 'enabled' AND (c.expires_at IS NULL OR c.expires_at > now())`,
      [personId],
    )
  ).rows;
  return new Set(rows.map((r) => r.kind));
}

/** The sources whose connection the person does not have, as the plain labels the screen uses ("My mail"). */
export async function missingConnections(tx: PluginTx, personId: string, sources: readonly RoutineSource[]): Promise<RoutineSource[]> {
  const needed = sources.filter((s) => ROUTINE_SOURCE_CONNECTION[s] !== undefined);
  if (needed.length === 0) return [];
  const have = await personConnectionKinds(tx, personId);
  return needed.filter((s) => !(ROUTINE_SOURCE_CONNECTION[s] ?? []).some((k) => have.has(k)));
}

export const sourceLabel = (s: RoutineSource): string => ROUTINE_SOURCE_LABELS[s];

export type BotForRoutine = {
  id: string;
  slug: string;
  name: string;
  status: string;
  scope: string;
  team_id: string;
};

/** The bot of a slug the person can ask: the workspace Brain, or a bot of a team they are on. */
export async function resolveBotFor(tx: PluginTx, personId: string, slug: string): Promise<BotForRoutine | null> {
  return (
    (
      await tx.query<BotForRoutine>(
        `SELECT b.id, b.slug, b.name, b.status, b.scope, b.team_id FROM app.bots b
          WHERE b.slug = $2 AND b.workspace_id = app.workspace_id()
            AND (b.scope = 'workspace' OR EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' WHERE tm.team_id = b.team_id AND a.ref_id = $1::uuid))
          ORDER BY (b.scope = 'workspace') DESC, b.created_at LIMIT 1`,
        [personId, slug],
      )
    ).rows[0] ?? null
  );
}

/**
 * Whether the bot's definition asks to read Personal spaces (`personal.read`) and what the person answered (null: never asked). A person cannot read other actors or the
 * grants of a team, so the person's own call goes through `bot_consent_rows()`; the scheduler (the system role) reads the tables.
 */
async function consentOf(tx: PluginTx, personId: string, botId: string): Promise<{ canAsk: boolean; allowed: boolean | null }> {
  const system = (await tx.query<{ system: boolean }>('SELECT app.is_system() AS system')).rows[0]?.system === true;
  if (system) {
    const r = (
      await tx.query<{ granted: boolean; allowed: boolean | null }>(
        `SELECT EXISTS (SELECT 1 FROM app.actors ba JOIN app.capability_grants g ON g.actor_id = ba.id AND g.capability = 'personal.read' WHERE ba.kind = 'bot' AND ba.ref_id = $1::uuid) AS granted,
                (SELECT c.allowed FROM app.bot_personal_consents c WHERE c.bot_id = $1::uuid AND c.person_id = $2::uuid) AS allowed`,
        [botId, personId],
      )
    ).rows[0];
    return { canAsk: r?.granted === true, allowed: r?.allowed ?? null };
  }
  const own = (await tx.query<{ can_ask: boolean; allowed: boolean; is_default: boolean }>('SELECT can_ask, allowed, is_default FROM app.bot_consent_rows() WHERE bot_id = $1::uuid', [botId])).rows[0];
  if (!own) return { canAsk: false, allowed: null };
  return { canAsk: own.can_ask, allowed: own.is_default ? null : own.allowed };
}

/**
 * Why this person's routine with this bot may not run, or null when it may: the bot is off or gone, the person is no longer on its team, the person said no to the bot
 * reading their Personal space (or the bot never asked), or a connection a source needs is gone. These are the stop reasons; the same list serves creation (where it is
 * a refusal with a plain sentence) and the scheduler (where it is a stop).
 */
export async function runBlocker(
  tx: PluginTx,
  input: { personId: string; botId: string | null; sources: readonly RoutineSource[] },
): Promise<PersonalRoutineStopReason | null> {
  const person = (await tx.query<{ status: string }>('SELECT p.status FROM app.people p WHERE p.id = $1::uuid', [input.personId])).rows[0];
  if (!person || person.status !== 'active') return 'owner_deactivated';
  if (input.botId === null) return 'bot_gone';
  const bot = (
    await tx.query<{ status: string; scope: string; slug: string; team_id: string; is_member: boolean }>(
      `SELECT b.status, b.scope, b.slug, b.team_id,
              EXISTS (SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' WHERE tm.team_id = b.team_id AND a.ref_id = $2::uuid) AS is_member
         FROM app.bots b WHERE b.id = $1::uuid`,
      [input.botId, input.personId],
    )
  ).rows[0];
  if (!bot) return 'bot_gone';
  if (bot.status !== 'active') return 'bot_off';
  if (bot.scope !== 'workspace' && !bot.is_member) return 'not_a_member';
  // the same rule as app.run_space_context(): the workspace Brain is allowed unless the person said no; any other bot needs its definition to ask AND the person to say yes
  const isBrain = bot.scope === 'workspace' && bot.slug === 'brain';
  const { canAsk, allowed } = await consentOf(tx, input.personId, input.botId);
  const personalOpen = isBrain ? allowed !== false : canAsk && allowed === true;
  if (!personalOpen) return 'consent_withdrawn';
  if ((await missingConnections(tx, input.personId, input.sources)).length > 0) return 'connection_gone';
  return null;
}
