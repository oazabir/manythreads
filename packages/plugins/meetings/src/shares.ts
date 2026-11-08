import { conflict, forbidden, invalid, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  CreateMeetingShareRequest,
  CreateMeetingShareResponse,
  DeleteMeetingShareResponse,
  ListMeetingSharesResponse,
  MeetingPathParams,
  MeetingSharePathParams,
  MeetingShare,
  MeetingsNotesSharedEvent,
  createMeetingShareRoute,
  deleteMeetingShareRoute,
  listMeetingSharesRoute,
} from '@manythreads/shared';
import { announceMeeting, callerPerson, notesAccess } from './notes-access.ts';
import type { MeetingRow } from './rows.ts';

// Work package S5 (P15-22, decision C18): the organizer shares a meeting's notes with a person or a channel, and takes the share back. The share is a row of `meeting_shares`
// (the database lets only the organizer make or revoke one, and shows a grant to the organizer and to the person it is for); the reader's access is checked again on every
// read by `app.meetings_can_read_notes`, so a person who has left the team no longer reads, whatever the share says. Every grant and every revoke is an audit event (ids only).

interface ShareRow {
  id: string;
  meeting_id: string;
  grantee_kind: 'person' | 'channel';
  grantee_person_id: string | null;
  grantee_channel_id: string | null;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
  display_name: string | null;
  channel_name: string | null;
  [key: string]: unknown;
}

const SHARE_SQL = `SELECT s.id, s.meeting_id, s.grantee_kind, s.grantee_person_id, s.grantee_channel_id, s.created_by, s.created_at, s.revoked_at,
                          p.display_name, c.name AS channel_name
                     FROM app.meeting_shares s
                     LEFT JOIN app.people p ON p.id = s.grantee_person_id
                     LEFT JOIN app.channels c ON c.id = s.grantee_channel_id`;

function toShare(r: ShareRow): MeetingShare {
  return MeetingShare.parse({
    id: r.id,
    meetingId: r.meeting_id,
    grantee:
      r.grantee_kind === 'person'
        ? { kind: 'person', personId: r.grantee_person_id, displayName: r.display_name ?? 'Someone' }
        : { kind: 'channel', channelId: r.grantee_channel_id, channelName: r.channel_name },
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
  });
}

/** The meeting for the organizer: 404 for anyone who cannot see the notes at all, 403 for someone who can read them but did not hold the call. */
async function organizersMeeting(ctx: PluginContext, tx: PluginTx, meetingId: string): Promise<MeetingRow> {
  const who = await callerPerson(tx);
  const access = await notesAccess(ctx, tx, meetingId);
  if (!access) throw notFound('That meeting is not available');
  if (access.meeting.organizer_id !== who.actorId) throw forbidden('Only the person who started the call shares its notes.');
  return access.meeting;
}

/** Can this person read the place the call happened in? Only such a person can open shared notes (the database checks again on every read), so a share with anyone else would do nothing. */
async function personIsInPlace(tx: PluginTx, m: MeetingRow, personId: string): Promise<boolean> {
  if (m.channel_id !== null) {
    return (await tx.query('SELECT 1 FROM app.channel_audience($1::uuid) WHERE person_id = $2::uuid', [m.channel_id, personId])).rows.length > 0;
  }
  if (m.team_id === null) return false;
  return (
    (
      await tx.query(
        `SELECT 1 FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' WHERE tm.team_id = $1::uuid AND a.ref_id = $2::uuid`,
        [m.team_id, personId],
      )
    ).rows.length > 0
  );
}

async function emitShared(ctx: PluginContext, tx: PluginTx, m: MeetingRow, by: string, kind: 'person' | 'channel', granteeId: string, revoked: boolean): Promise<void> {
  await ctx.audit.emit(
    tx,
    MeetingsNotesSharedEvent.parse({
      type: 'meetings.notes.shared',
      schemaVersion: 1,
      workspaceId: m.workspace_id,
      teamId: m.team_id,
      channelId: m.channel_id,
      meetingId: m.id,
      sharedBy: by,
      granteeKind: kind,
      granteeId,
      revoked,
      at: ctx.runtime.now().toISOString(),
    }),
  );
}

/** Tells the people a share changes things for (the person, or a channel's readers) to look again. */
async function tellGrantee(ctx: PluginContext, tx: PluginTx, m: MeetingRow, share: ShareRow): Promise<void> {
  if (share.grantee_kind === 'person' && share.grantee_person_id) {
    await announceMeeting(ctx, tx, m, [share.grantee_person_id]);
    return;
  }
  if (share.grantee_channel_id) {
    const people = (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [share.grantee_channel_id])).rows.map((r) => r.person_id);
    await announceMeeting(ctx, tx, m, people);
  }
}

export function registerShares(ctx: PluginContext): void {
  ctx.http.route({
    ...listMeetingSharesRoute,
    schema: { response: ListMeetingSharesResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const m = await organizersMeeting(ctx, tx, meetingId);
      const rows = (await tx.query<ShareRow>(`${SHARE_SQL} WHERE s.meeting_id = $1::uuid ORDER BY s.created_at, s.id`, [m.id])).rows;
      return json(ListMeetingSharesResponse.parse({ shares: rows.map(toShare) }));
    }),
  });

  ctx.http.route({
    ...createMeetingShareRoute,
    schema: { body: CreateMeetingShareRequest, response: CreateMeetingShareResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const body = CreateMeetingShareRequest.parse(req.body);
      const who = await callerPerson(tx);
      const m = await organizersMeeting(ctx, tx, meetingId);
      if (m.state !== 'ended') throw conflict('The call is still going. Share its notes once it has ended.');

      let granteeId: string;
      if (body.kind === 'person') {
        granteeId = body.personId;
        if (granteeId === who.personId) throw invalid('The notes are already yours.');
        const person = (await tx.query<{ id: string }>('SELECT id FROM app.people WHERE id = $1::uuid', [granteeId])).rows[0];
        if (!person) throw notFound('That person is not available');
        if (!(await personIsInPlace(tx, m, granteeId))) {
          throw conflict('That person is not in the place this call was held, so they could not open its notes. Share with a channel they are in instead.');
        }
      } else {
        granteeId = body.channelId;
        const channel = (await tx.query<{ kind: string; ok: boolean | null }>(`SELECT c.kind, app.lookup_channel_can(c.id, 'read') AS ok FROM app.channels c WHERE c.id = $1::uuid`, [granteeId])).rows[0];
        if (!channel || channel.ok !== true) throw notFound('That channel is not available');
        if (channel.kind !== 'channel') throw invalid('Notes are shared with a channel, not with a direct message.');
      }

      // sharing again with the same person or channel is not an error: the share that is there is returned
      const column = body.kind === 'person' ? 'grantee_person_id' : 'grantee_channel_id';
      const existing = (await tx.query<ShareRow>(`${SHARE_SQL} WHERE s.meeting_id = $1::uuid AND s.${column} = $2::uuid AND s.revoked_at IS NULL`, [m.id, granteeId])).rows[0];
      if (existing) return json(CreateMeetingShareResponse.parse({ share: toShare(existing) }));

      const made = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.meeting_shares (meeting_id, grantee_kind, grantee_person_id, grantee_channel_id, created_by)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid) RETURNING id`,
          [m.id, body.kind, body.kind === 'person' ? granteeId : null, body.kind === 'channel' ? granteeId : null, who.actorId],
        )
      ).rows[0]!;
      const row = (await tx.query<ShareRow>(`${SHARE_SQL} WHERE s.id = $1::uuid`, [made.id])).rows[0]!;
      await emitShared(ctx, tx, m, who.actorId, body.kind, granteeId, false);
      await tellGrantee(ctx, tx, m, row);
      return json(CreateMeetingShareResponse.parse({ share: toShare(row) }));
    }),
  });

  ctx.http.route({
    ...deleteMeetingShareRoute,
    schema: { response: DeleteMeetingShareResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId, shareId } = MeetingSharePathParams.parse(req.params);
      const who = await callerPerson(tx);
      const m = await organizersMeeting(ctx, tx, meetingId);
      const row = (await tx.query<ShareRow>(`${SHARE_SQL} WHERE s.id = $1::uuid AND s.meeting_id = $2::uuid`, [shareId, m.id])).rows[0];
      if (!row) throw notFound('That share is not available');
      if (row.revoked_at !== null) return json(DeleteMeetingShareResponse.parse({ share: toShare(row) }));
      await tx.query('UPDATE app.meeting_shares SET revoked_at = now() WHERE id = $1::uuid AND revoked_at IS NULL', [row.id]);
      const after = (await tx.query<ShareRow>(`${SHARE_SQL} WHERE s.id = $1::uuid`, [row.id])).rows[0]!;
      await emitShared(ctx, tx, m, who.actorId, row.grantee_kind, (row.grantee_person_id ?? row.grantee_channel_id)!, true);
      await tellGrantee(ctx, tx, m, row);
      return json(DeleteMeetingShareResponse.parse({ share: toShare(after) }));
    }),
  });
}
