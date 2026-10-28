import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { DndSettings, dndState } from '@manythreads/shared';
import { normalizePrefs } from './prefs.ts';
import { announce } from './announce.ts';

/** The `dnd_settings` row of a person (presence plugin) with their time zone; a person with no row has Do not disturb off. */
interface DndFacts extends Record<string, unknown> {
  person_id: string;
  enabled: boolean | null;
  paused_until: Date | null;
  schedule: unknown;
  time_zone: string | null;
}

async function dndFactsOf(tx: PluginTx, personIds: readonly string[]): Promise<DndFacts[]> {
  const res = await tx.query<DndFacts>(
    `SELECT w.person_id, d.enabled, d.paused_until, d.schedule, s.time_zone
       FROM unnest($1::uuid[]) AS w(person_id)
       JOIN app.dnd_settings d ON d.person_id = w.person_id
       LEFT JOIN app.person_status s ON s.person_id = w.person_id`,
    [personIds],
  );
  return res.rows;
}

/** Is Do not disturb on for this person at `now`? A settings document that no longer parses counts as off, so nothing stays held for good. */
function isQuiet(f: DndFacts, now: Date): boolean {
  const parsed = DndSettings.safeParse({ enabled: f.enabled === true, pausedUntil: f.paused_until ? f.paused_until.toISOString() : null, schedule: f.schedule });
  return parsed.success && dndState(parsed.data, f.time_zone, now, false).active;
}

/** Of these people, the ones who have Do not disturb on at `now`. */
export async function quietPeople(tx: PluginTx, personIds: readonly string[], now: Date): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const facts = await dndFactsOf(tx, personIds);
  return new Set(facts.filter((f) => isQuiet(f, now)).map((f) => f.person_id));
}

/**
 * Releases what was held for these people: clears `held_at` and announces each row as a new notification (live push, browser alert flag,
 * event). Returns how many rows were released. The caller has already decided that Do not disturb is over for them.
 */
export async function releaseHeld(ctx: PluginContext, tx: PluginTx, personIds: readonly string[]): Promise<number> {
  if (personIds.length === 0) return 0;
  const released = await tx.query<{ id: string; person_id: string; workspace_id: string }>(
    'UPDATE app.notifications SET held_at = NULL WHERE person_id = ANY ($1::uuid[]) AND held_at IS NOT NULL RETURNING id, person_id, workspace_id',
    [personIds],
  );
  if (released.rows.length === 0) return 0;
  const prefs = await tx.query<{ person_id: string; prefs: unknown }>('SELECT person_id, prefs FROM app.notification_prefs WHERE person_id = ANY ($1::uuid[])', [
    [...new Set(released.rows.map((r) => r.person_id))],
  ]);
  const prefsOf = new Map(prefs.rows.map((r) => [r.person_id, normalizePrefs(r.prefs)]));
  // Rows of one workspace at a time (the event names it); in practice a person belongs to one.
  const byWorkspace = new Map<string, typeof released.rows>();
  for (const r of released.rows) byWorkspace.set(r.workspace_id, [...(byWorkspace.get(r.workspace_id) ?? []), r]);
  for (const [workspaceId, rows] of byWorkspace) await announce(ctx, tx, workspaceId, rows, prefsOf);
  return released.rows.length;
}

/** The release job: every minute (the cron grid of the job queue; 5-field cron in UTC). */
export const RELEASE_HELD_QUEUE = 'notifications.release_held';
export const RELEASE_HELD_CRON = '* * * * *';

/** At most this many people are looked at per run of the release job; the next minute takes the rest. */
const RELEASE_BATCH = 500;

/**
 * The release job's body: of the people who have held notifications, release those whose Do not disturb is over (a pause ran out, a schedule
 * ended, or the settings changed without an event reaching us). Returns the number of notifications released.
 */
export async function releaseDue(ctx: PluginContext, tx: PluginTx, now: Date): Promise<number> {
  const waiting = await tx.query<{ person_id: string }>('SELECT DISTINCT person_id FROM app.notifications WHERE held_at IS NOT NULL LIMIT $1', [RELEASE_BATCH]);
  const people = waiting.rows.map((r) => r.person_id);
  if (people.length === 0) return 0;
  const quiet = await quietPeople(tx, people, now);
  return releaseHeld(ctx, tx, people.filter((id) => !quiet.has(id)));
}
