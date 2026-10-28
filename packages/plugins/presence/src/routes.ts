import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  DEFAULT_DND_SETTINGS,
  ListPresenceCardsResponse,
  MyPresence,
  PRESENCE_TTL_SECONDS,
  PresenceDndChangedEvent,
  UpdateDndRequest,
  UpdateMyPresenceRequest,
  dndState,
  getMyPresenceRoute,
  listPresenceCardsRoute,
  localDate,
  updateDndRoute,
  updateMyPresenceRoute,
} from '@manythreads/shared';
import { callerPerson } from './heartbeat.ts';
import { invalid, json, route } from './http.ts';
import { PERSON_STATUS_COLUMNS, outOfOfficeOf, statusOf, toDndSettings, toPresenceCard, workingHoursOf, type PersonStatusRow } from './rows.ts';

interface DndRow extends Record<string, unknown> {
  enabled: boolean;
  paused_until: Date | null;
  schedule: unknown;
}

async function loadStatus(tx: PluginTx, personId: string): Promise<PersonStatusRow | undefined> {
  const res = await tx.query<PersonStatusRow>(`SELECT ${PERSON_STATUS_COLUMNS} FROM app.person_status s WHERE s.person_id = $1::uuid`, [personId]);
  return res.rows[0];
}

async function loadDnd(tx: PluginTx, personId: string): Promise<DndRow | undefined> {
  const res = await tx.query<DndRow>('SELECT enabled, paused_until, schedule FROM app.dnd_settings WHERE person_id = $1::uuid', [personId]);
  return res.rows[0];
}

/** Every part of the caller's own settings, with Do not disturb worked out for `now`. */
async function myPresence(tx: PluginTx, personId: string, now: Date): Promise<MyPresence> {
  const [row, dndRow] = [await loadStatus(tx, personId), await loadDnd(tx, personId)];
  const dnd = toDndSettings(dndRow);
  return MyPresence.parse({
    status: row ? statusOf(row, now) : null,
    timeZone: row?.time_zone ?? null,
    workingHours: row ? workingHoursOf(row) : null,
    outOfOffice: row ? outOfOfficeOf(row, now) : null,
    dnd,
    dndState: dndState(dnd, row?.time_zone ?? null, now),
  });
}

/**
 * The durable half of presence: a custom status, a time zone with working hours, an out-of-office note (all readable by the workspace's
 * members, through one list), and Do not disturb (private to the person). A person writes only their own rows; row level security enforces it.
 */
export function registerStatusRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listPresenceCardsRoute,
    schema: { response: ListPresenceCardsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      const now = ctx.runtime.now();
      // `people`, `person_status` and `presence` each show the caller what their own policy allows: members see the workspace, a guest only themself.
      const res = await tx.query<PersonStatusRow & { has_status_row: boolean; beat_status: string | null; beat_seen_at: Date | null }>(
        `SELECT p.id AS person_id, ${PERSON_STATUS_COLUMNS.replace('s.person_id, ', '')}, (s.person_id IS NOT NULL) AS has_status_row,
                pr.status AS beat_status, pr.seen_at AS beat_seen_at
           FROM app.people p
           LEFT JOIN app.person_status s ON s.person_id = p.id
           LEFT JOIN app.presence pr ON pr.person_id = p.id AND pr.seen_at > now() - make_interval(secs => $1)
          WHERE p.workspace_id = app.workspace_id() AND p.status = 'active' AND (s.person_id IS NOT NULL OR pr.person_id IS NOT NULL)
          ORDER BY p.id LIMIT 2000`,
        [PRESENCE_TTL_SECONDS],
      );
      const people = res.rows.map((r) =>
        toPresenceCard(r.has_status_row ? r : undefined, r.person_id, r.beat_status && r.beat_seen_at ? { status: r.beat_status, seen_at: r.beat_seen_at } : undefined, now),
      );
      return json(ListPresenceCardsResponse.parse({ people }));
    }),
  });

  ctx.http.route({
    ...getMyPresenceRoute,
    schema: { response: MyPresence },
    handler: route(async (_req, tx) => json(await myPresence(tx, await callerPerson(tx), ctx.runtime.now()))),
  });

  ctx.http.route({
    ...updateMyPresenceRoute,
    schema: { body: UpdateMyPresenceRequest, response: MyPresence },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const body = UpdateMyPresenceRequest.parse(req.body ?? {});
      const me = await callerPerson(tx);
      const now = ctx.runtime.now();
      const cur = await loadStatus(tx, me);

      let emoji = cur?.status_emoji ?? null;
      let text = cur?.status_text ?? '';
      let clearsAt = cur?.status_clears_at ?? null;
      if (body.status !== undefined) {
        if (body.status === null) {
          [emoji, text, clearsAt] = [null, '', null];
        } else {
          if (body.status.clearsAt !== null && Date.parse(body.status.clearsAt) <= now.getTime()) throw invalid('That clear time has already passed. Choose a later one.');
          [emoji, text, clearsAt] = [body.status.emoji, body.status.text, body.status.clearsAt ? new Date(body.status.clearsAt) : null];
        }
      }

      const timeZone = body.timeZone !== undefined ? body.timeZone : (cur?.time_zone ?? null);
      const workingHours = body.workingHours !== undefined ? body.workingHours : (cur ? workingHoursOf(cur) : null);
      if (workingHours !== null && timeZone === null) throw invalid('Choose your time zone before you set working hours.');

      let ooo = { active: cur?.ooo_active ?? false, returnsOn: cur?.ooo_returns_on ?? null, delegate: cur?.ooo_delegate_id ?? null, message: cur?.ooo_message ?? '' };
      if (body.outOfOffice !== undefined) {
        const note = body.outOfOffice;
        if (note === null || !note.active) {
          ooo = { active: false, returnsOn: null, delegate: null, message: '' };
        } else {
          if (note.returnsOn !== null && note.returnsOn <= localDate(now, timeZone ?? 'UTC')) throw invalid('Choose a return day after today.');
          if (note.delegatePersonId !== null) {
            if (note.delegatePersonId === me) throw invalid('You cannot be your own delegate.');
            const known = await tx.query<{ ok: boolean }>('SELECT app.presence_person_in_workspace($1::uuid) AS ok', [note.delegatePersonId]);
            if (!known.rows[0]?.ok) throw invalid('That person is not on this workspace.');
          }
          ooo = { active: true, returnsOn: note.returnsOn, delegate: note.delegatePersonId, message: note.message };
        }
      }

      await tx.query(
        `INSERT INTO app.person_status AS s
           (person_id, workspace_id, status_emoji, status_text, status_clears_at, time_zone, working_hours, ooo_active, ooo_returns_on, ooo_delegate_id, ooo_message)
         VALUES ($1::uuid, app.workspace_id(), $2, $3, $4, $5, $6::jsonb, $7, $8::date, $9::uuid, $10)
         ON CONFLICT (person_id) DO UPDATE SET status_emoji = EXCLUDED.status_emoji, status_text = EXCLUDED.status_text,
           status_clears_at = EXCLUDED.status_clears_at, time_zone = EXCLUDED.time_zone, working_hours = EXCLUDED.working_hours,
           ooo_active = EXCLUDED.ooo_active, ooo_returns_on = EXCLUDED.ooo_returns_on, ooo_delegate_id = EXCLUDED.ooo_delegate_id,
           ooo_message = EXCLUDED.ooo_message, updated_at = now()`,
        [me, emoji, text, clearsAt, timeZone, workingHours === null ? null : JSON.stringify(workingHours), ooo.active, ooo.returnsOn, ooo.delegate, ooo.message],
      );
      // A changed time zone moves a weekly Do not disturb schedule, so the notifications plugin is told to look again.
      if (body.timeZone !== undefined && body.timeZone !== (cur?.time_zone ?? null)) await announceDnd(ctx, tx, me, now);
      return json(await myPresence(tx, me, now));
    }),
  });

  ctx.http.route({
    ...updateDndRoute,
    schema: { body: UpdateDndRequest, response: MyPresence },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const body = UpdateDndRequest.parse(req.body ?? {});
      const me = await callerPerson(tx);
      const now = ctx.runtime.now();
      const cur = toDndSettings(await loadDnd(tx, me));
      const next = {
        enabled: body.enabled ?? cur.enabled,
        pausedUntil:
          body.pauseMinutes === undefined ? cur.pausedUntil : body.pauseMinutes === null ? null : new Date(now.getTime() + body.pauseMinutes * 60_000).toISOString(),
        schedule: body.schedule ?? cur.schedule ?? DEFAULT_DND_SETTINGS.schedule,
      };
      await tx.query(
        `INSERT INTO app.dnd_settings AS d (person_id, workspace_id, enabled, paused_until, schedule) VALUES ($1::uuid, app.workspace_id(), $2, $3, $4::jsonb)
         ON CONFLICT (person_id) DO UPDATE SET enabled = EXCLUDED.enabled, paused_until = EXCLUDED.paused_until, schedule = EXCLUDED.schedule, updated_at = now()`,
        [me, next.enabled, next.pausedUntil, JSON.stringify(next.schedule)],
      );
      await announceDnd(ctx, tx, me, now);
      return json(await myPresence(tx, me, now));
    }),
  });
}

/** Writes `presence.dnd.changed` with whether Do not disturb is on now; the notifications plugin delivers what it held when it is off. */
async function announceDnd(ctx: PluginContext, tx: PluginTx, personId: string, now: Date): Promise<void> {
  const [row, dndRow] = [await loadStatus(tx, personId), await loadDnd(tx, personId)];
  const state = dndState(toDndSettings(dndRow), row?.time_zone ?? null, now);
  const ws = (await tx.query<{ id: string }>('SELECT app.workspace_id() AS id')).rows[0]!.id;
  await ctx.audit.emit(
    tx,
    PresenceDndChangedEvent.parse({ type: 'presence.dnd.changed', schemaVersion: 1, workspaceId: ws, personId, active: state.active, until: state.until }),
  );
}
