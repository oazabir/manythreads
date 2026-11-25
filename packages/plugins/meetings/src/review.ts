import { randomUUID } from 'node:crypto';
import { conflict, invalid, json, notFound, route, type PluginContext, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import {
  ConfirmMeetingReviewRequest,
  ConfirmMeetingReviewResponse,
  GetMeetingReviewResponse,
  MEETING_MARK_WINDOW_MS,
  MEETING_MARKS_PER_PERSON,
  MEETING_REVIEW_ITEMS_MAX,
  MEETING_REVIEW_PUSH,
  MEETING_REVIEW_TEXT_MAX,
  MarkMeetingActionResponse,
  MeetingNoteItem,
  MeetingPathParams,
  MeetingReview,
  MeetingReviewItem,
  MeetingReviewPush,
  MeetingsActionItemsConfirmedEvent,
  MeetingsMeetingEndedEvent,
  MeetingsNotesWrittenEvent,
  MeetingsReviewOpenedEvent,
  confirmMeetingReviewRoute,
  getMeetingReviewRoute,
  markMeetingActionRoute,
  type MeetingReviewStatus,
  type MeetingTranscriptLine,
} from '@manythreads/shared';
import { z } from 'zod';
import { readLiveTranscriptLines } from './assistant.ts';
import { comparableText, stripHostileText } from './limits.ts';
import { actionItemLine, putNotesFile } from './notes.ts';
import { announceMeeting, callerPerson } from './notes-access.ts';
import { loadMeeting, type MeetingRow } from './rows.ts';

// Mark action item and the end-of-call review (PLAN P17-06 step 2, docs/plans/meeting-assistant.md "Step 2").
//
//  * MARK (`POST /api/meetings/:id/marks`). A person in the live call presses the button: the final lines that ended in the last 30 seconds, read as that person (row-level
//    security) and only of people who said yes to being transcribed, become one mark (`app.meeting_marks`). Nothing said, or transcription off, is a plain 409.
//  * REVIEW. A job (`meetings.review`) opens it once the call has ended: at once for a call with a note-taker (its notes are the organizer's own copy and stay out of the
//    review), else when the Scribe's notes are written or failed, or ten minutes after the end at the latest. Its items are the notes' action items, then the marks, the
//    same words once. The people who were in the call and can still read its channel are told (`meetings.review.opened`, a notification) and their pages asked again.
//    Notes that arrive after the review opened are added to it; after it was confirmed, they open it again with the confirmed items and the new ones.
//  * CONFIRM (`POST /api/meetings/:id/review/confirm`), by one of those people, as themself (the row policy and the guard trigger decide): the kept items with their words and
//    owners. `meetings.action_items.confirmed` (ids and counts) is the follow-ups' start (P17-07); a job (`meetings.review.apply`) writes the confirmed items into the notes'
//    list of action items (`meeting_notes.items` and the "Action items" section of `notes.md`), so only confirmed items are in the notes from then on.

export const REVIEW_QUEUE = 'meetings.review';
export const APPLY_QUEUE = 'meetings.review.apply';
/** The latest a review waits for the Scribe's notes after the call ended. */
export const REVIEW_FALLBACK_MS = 10 * 60_000;
/** A mark reads lines that started up to this long before its window, and keeps those that ended inside it (a long sentence that began earlier still counts). */
const MARK_LOOKBACK_MS = 60_000;

const ReviewPayload = z.object({ meetingId: z.uuid(), workspaceId: z.uuid() });

/** Asks the review job to look at a call (deduplicated per reason). Exported for the notes job, which says when no notes will come. */
export async function enqueueReview(ctx: PluginContext, tx: PluginTx, meetingId: string, workspaceId: string, reason: string, runAt?: Date): Promise<void> {
  await ctx.jobs.enqueue(tx, REVIEW_QUEUE, { meetingId, workspaceId }, { dedupeKey: `review:${meetingId}:${reason}`, ...(runAt ? { runAt } : {}) });
}

// ---- pure parts ----------------------------------------------------------------------------------------------------------------------------------------------------

/** The final lines that ended inside the window before `nowMs`, oldest first. */
export function linesForMark(lines: readonly MeetingTranscriptLine[], nowMs: number): MeetingTranscriptLine[] {
  const from = nowMs - MEETING_MARK_WINDOW_MS;
  return lines.filter((l) => l.transcribed && l.endMs >= from).sort((a, b) => a.startMs - b.startMs);
}

/** A mark's words: "Nadia: I will send the draft. Rafi: By Friday." cut at a word to the item length. Linear in the lines. */
export function markText(lines: readonly Pick<MeetingTranscriptLine, 'speakerName' | 'text'>[]): string {
  const parts: string[] = [];
  let lastSpeaker = '';
  for (const l of lines) {
    const who = stripHostileText(l.speakerName).slice(0, 80);
    const words = stripHostileText(l.text);
    if (words === '') continue;
    parts.push(who === lastSpeaker ? words : `${who}: ${words}`);
    lastSpeaker = who;
  }
  const text = parts.join(' ');
  if (text.length <= MEETING_REVIEW_TEXT_MAX) return text;
  const cut = text.slice(0, MEETING_REVIEW_TEXT_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > MEETING_REVIEW_TEXT_MAX / 2 ? cut.slice(0, space) : cut}…`;
}

/** Items in order, each once (the same words compared without case and punctuation), at most the review's size. The first copy wins. */
export function mergeItems(...lists: ReadonlyArray<readonly MeetingReviewItem[]>): MeetingReviewItem[] {
  const out: MeetingReviewItem[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list) {
      const key = comparableText(item.text);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= MEETING_REVIEW_ITEMS_MAX) return out;
    }
  }
  return out;
}

/** The notes' action items as review items (each gets an id of its own). */
export function noteItemsForReview(items: readonly MeetingNoteItem[], newId: () => string = randomUUID): MeetingReviewItem[] {
  return items
    .filter((i) => i.kind === 'action')
    .map((i) => MeetingReviewItem.parse({ id: newId(), source: 'notes', text: i.text.slice(0, MEETING_REVIEW_TEXT_MAX), ownerId: i.ownerId, ownerName: i.ownerName, due: i.due, atMs: i.atMs }));
}

/**
 * `notes.md` with its "Action items" section holding `items` (a "*None.*" line when there are none): the rest of the file, a person's edits included, is left as it is. A
 * file without the section gets it at the end. Linear in the lines.
 */
export function replaceActionItems(markdown: string, items: readonly Pick<MeetingNoteItem, 'text' | 'ownerName' | 'due' | 'atMs'>[]): string {
  const body = ['', ...(items.length > 0 ? items.map(actionItemLine) : ['*None.*']), ''];
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Action items');
  if (start < 0) return [...lines.slice(0, lines.at(-1) === '' ? -1 : lines.length), '', '## Action items', ...body].join('\n');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]!.startsWith('## ') || lines[i]!.startsWith('# ')) {
      end = i;
      break;
    }
  }
  const tail = lines.slice(end);
  return [...lines.slice(0, start + 1), ...(tail.length > 0 ? body : body.slice(0, -1)), ...tail].join('\n') + (tail.length > 0 ? '' : '\n');
}

// ---- reading ----------------------------------------------------------------------------------------------------------------------------------------------------

interface ReviewRow {
  meeting_id: string;
  workspace_id: string;
  channel_id: string;
  team_id: string | null;
  status: MeetingReviewStatus;
  items: unknown;
  confirmed_items: unknown;
  notes_included: boolean;
  opened_at: Date;
  confirmed_at: Date | null;
  confirmed_by: string | null;
  [key: string]: unknown;
}
const REVIEW_COLUMNS =
  'meeting_id::text AS meeting_id, workspace_id::text AS workspace_id, channel_id::text AS channel_id, team_id::text AS team_id, status, items, confirmed_items, notes_included, opened_at, confirmed_at, confirmed_by::text AS confirmed_by';

const readItems = (raw: unknown): MeetingReviewItem[] => {
  const parsed = z.array(MeetingReviewItem).max(MEETING_REVIEW_ITEMS_MAX).safeParse(raw);
  return parsed.success ? parsed.data : [];
};

/** Everyone who was in the call (people only, once each, by the name they joined with), read through `tx`. */
async function peopleOf(tx: PluginTx, meetingId: string): Promise<{ actorId: string; personId: string; displayName: string }[]> {
  return (
    await tx.query<{ actor_id: string; person_id: string; display_name: string }>(
      'SELECT actor_id::text AS actor_id, person_id::text AS person_id, display_name FROM app.meeting_participants WHERE meeting_id = $1::uuid ORDER BY first_joined_at, actor_id',
      [meetingId],
    )
  ).rows.map((r) => ({ actorId: r.actor_id, personId: r.person_id, displayName: r.display_name }));
}

/** The review as the caller reads it. */
function toReview(row: ReviewRow, people: readonly { actorId: string; displayName: string }[]): MeetingReview {
  const items = readItems(row.status === 'confirmed' ? row.confirmed_items : row.items);
  const offered = new Map(people.map((p) => [p.actorId, p.displayName]));
  // a team member the notes named who was not in the call can keep the item
  for (const i of readItems(row.items)) if (i.ownerId !== null && !offered.has(i.ownerId)) offered.set(i.ownerId, i.ownerName ?? 'Someone');
  return MeetingReview.parse({
    meetingId: row.meeting_id,
    status: row.status,
    items,
    notesIncluded: row.notes_included,
    openedAt: row.opened_at.toISOString(),
    confirmedAt: row.confirmed_at ? row.confirmed_at.toISOString() : null,
    confirmedByName: row.confirmed_by ? (offered.get(row.confirmed_by) ?? 'Someone') : null,
    canConfirm: row.status === 'open',
    people: [...offered].slice(0, 250).map(([actorId, displayName]) => ({ actorId, displayName: displayName.slice(0, 200) })),
  });
}

/** The people a review is for: those who were in the call and can still read its channel (person ids). */
async function reviewersOf(tx: PluginTx, m: Pick<MeetingRow, 'id' | 'channel_id'>): Promise<string[]> {
  if (m.channel_id === null) return [];
  return (
    await tx.query<{ person_id: string }>(
      `SELECT DISTINCT p.person_id::text AS person_id FROM app.meeting_participants p
        WHERE p.meeting_id = $1::uuid AND p.person_id IN (SELECT person_id FROM app.channel_audience($2::uuid))`,
      [m.id, m.channel_id],
    )
  ).rows.map((r) => r.person_id);
}

async function pushReview(ctx: PluginContext, tx: PluginTx, meetingId: string, personIds: readonly string[], status: MeetingReviewStatus): Promise<void> {
  if (personIds.length === 0) return;
  await ctx.realtime.pushToPeople(tx, [...new Set(personIds)], MEETING_REVIEW_PUSH, MeetingReviewPush.parse({ meetingId, status }));
}

// ---- the jobs ---------------------------------------------------------------------------------------------------------------------------------------------------

export type ReviewOutcome = 'opened' | 'added' | 'reopened' | 'nothing' | 'skipped';

/** The review job's body, exported for the tests: opens a call's review, or adds the notes' items that came after it opened. Runs as the system. */
export async function openReview(ctx: PluginContext, tx: PluginTx, payload: { meetingId: string }): Promise<ReviewOutcome> {
  const m = await loadMeeting(tx, payload.meetingId);
  if (!m || m.state !== 'ended' || m.channel_id === null) return 'skipped';
  const notes = (await tx.query<{ status: string; location: string; items: unknown }>('SELECT status, location, items FROM app.meeting_notes WHERE meeting_id = $1::uuid', [m.id])).rows[0];
  const notesReady = notes?.status === 'written' && notes.location !== 'personal';
  const parsedNotes = z.array(MeetingNoteItem).safeParse(notes?.items ?? []);
  const fromNotes = notesReady && parsedNotes.success ? noteItemsForReview(parsedNotes.data) : [];
  const existing = (await tx.query<ReviewRow>(`SELECT ${REVIEW_COLUMNS} FROM app.meeting_reviews WHERE meeting_id = $1::uuid FOR UPDATE`, [m.id])).rows[0];

  if (!existing) {
    const marks = (
      await tx.query<{ id: string; at_ms: number; text: string }>('SELECT id::text AS id, at_ms, text FROM app.meeting_marks WHERE meeting_id = $1::uuid ORDER BY created_at, id', [m.id])
    ).rows.map((k) => MeetingReviewItem.parse({ id: k.id, source: 'mark', text: k.text, ownerId: null, ownerName: null, due: null, atMs: k.at_ms }));
    const items = mergeItems(fromNotes, marks);
    if (items.length === 0) return 'nothing';
    const made = await tx.query(
      `INSERT INTO app.meeting_reviews (meeting_id, workspace_id, channel_id, team_id, items, notes_included) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6)
       ON CONFLICT (meeting_id) DO NOTHING RETURNING meeting_id`,
      [m.id, m.workspace_id, m.channel_id, m.team_id, JSON.stringify(items), notesReady],
    );
    if (made.rows.length === 0) return 'skipped';
    const people = await reviewersOf(tx, m);
    await ctx.audit.emit(
      tx,
      MeetingsReviewOpenedEvent.parse({
        type: 'meetings.review.opened',
        schemaVersion: 1,
        workspaceId: m.workspace_id,
        teamId: m.team_id,
        channelId: m.channel_id,
        meetingId: m.id,
        personIds: people.slice(0, 250),
        itemCount: items.length,
        at: ctx.runtime.now().toISOString(),
      }),
    );
    await pushReview(ctx, tx, m.id, people, 'open');
    return 'opened';
  }
  if (existing.notes_included || !notesReady) return 'skipped';
  const people = await reviewersOf(tx, m);
  if (existing.status === 'open') {
    const items = mergeItems(fromNotes, readItems(existing.items));
    await tx.query(`UPDATE app.meeting_reviews SET items = $2::jsonb, notes_included = true, updated_at = now() WHERE meeting_id = $1::uuid`, [m.id, JSON.stringify(items)]);
    await pushReview(ctx, tx, m.id, people, 'open');
    return 'added';
  }
  // confirmed before the notes came: open it again with what was confirmed and the notes' items, so nothing reaches the notes unconfirmed
  const items = mergeItems(readItems(existing.confirmed_items), fromNotes);
  await tx.query(
    `UPDATE app.meeting_reviews SET status = 'open', items = $2::jsonb, confirmed_items = NULL, confirmed_at = NULL, confirmed_by = NULL, notes_included = true, updated_at = now()
      WHERE meeting_id = $1::uuid`,
    [m.id, JSON.stringify(items)],
  );
  await pushReview(ctx, tx, m.id, people, 'open');
  return 'reopened';
}

export type ApplyOutcome = 'applied' | 'skipped';

/**
 * The apply job's body, exported for the tests: the confirmed items become the notes' action items (the rows and the "Action items" section of the file). Notes that are not
 * written yet, or are the organizer's own copy, are left alone (the review opens again when the Scribe's notes come). Runs as the system.
 */
export async function applyConfirmed(ctx: PluginContext, tx: PluginTx, payload: { meetingId: string }): Promise<ApplyOutcome> {
  const m = await loadMeeting(tx, payload.meetingId);
  if (!m) return 'skipped';
  const review = (await tx.query<ReviewRow>(`SELECT ${REVIEW_COLUMNS} FROM app.meeting_reviews WHERE meeting_id = $1::uuid`, [m.id])).rows[0];
  if (review?.status !== 'confirmed') return 'skipped';
  const notes = (
    await tx.query<{ status: string; location: 'repo' | 'channel_files' | 'personal'; transcript_path: string | null; notes_md: string; items: unknown }>(
      'SELECT status, location, transcript_path, notes_md, items FROM app.meeting_notes WHERE meeting_id = $1::uuid FOR UPDATE',
      [m.id],
    )
  ).rows[0];
  if (!notes || notes.status !== 'written' || notes.location === 'personal' || notes.transcript_path === null) return 'skipped';
  const old = z.array(MeetingNoteItem).safeParse(notes.items);
  const confirmed: MeetingNoteItem[] = readItems(review.confirmed_items).map((i) => ({
    kind: 'action',
    text: i.text,
    ownerName: i.ownerName,
    ownerId: i.ownerId,
    due: i.due,
    atMs: i.atMs,
  }));
  const items = [...(old.success ? old.data.filter((i) => i.kind !== 'action') : []), ...confirmed];
  const markdown = replaceActionItems(notes.notes_md, confirmed);
  // written the way the notes were written first: a commit to the team repo, or the channel's Files
  const written = await putNotesFile(ctx, tx, m, notes.location, notes.transcript_path, markdown);
  await tx.query(
    `UPDATE app.meeting_notes SET items = $2::jsonb, notes_md = $3, notes_path = $4,
            file_ids = CASE WHEN $5::uuid IS NULL OR $5::uuid = ANY (file_ids) THEN file_ids ELSE array_append(file_ids, $5::uuid) END, updated_at = now()
      WHERE meeting_id = $1::uuid`,
    [m.id, JSON.stringify(items), markdown, written.path, written.fileId],
  );
  await announceMeeting(ctx, tx, m, await reviewersOf(tx, m));
  return 'applied';
}

// ---- the routes ------------------------------------------------------------------------------------------------------------------------------------------------

export function registerReview(ctx: PluginContext): void {
  ctx.http.route({
    ...markMeetingActionRoute,
    schema: { response: MarkMeetingActionResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const who = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That call is not available');
      if (m.state !== 'live') throw conflict('The call has ended.');
      const here = await tx.query('SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid AND left_at IS NULL', [m.id, who.actorId]);
      if (here.rows.length === 0) throw conflict('Join the call to mark an action item.');
      if (m.transcription === 'off') throw conflict('Turn on transcription to mark action items: a mark keeps what was just said.');
      const mine = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.meeting_marks WHERE meeting_id = $1::uuid AND marked_by = $2::uuid', [m.id, who.actorId])).rows[0]?.n ?? 0;
      if (mine >= MEETING_MARKS_PER_PERSON) throw conflict(`You marked ${MEETING_MARKS_PER_PERSON} action items in this call already.`);
      const nowMs = Math.max(0, ctx.runtime.now().getTime() - m.started_at.getTime());
      // read as the caller (their own row-level security), only the words of people who said yes
      const lines = await readLiveTranscriptLines(tx, m.id, { fromMs: Math.max(0, nowMs - MEETING_MARK_WINDOW_MS - MARK_LOOKBACK_MS) });
      const taken = linesForMark(lines ?? [], nowMs);
      const text = markText(taken);
      if (text === '') throw conflict('Nothing was written down in the last 30 seconds. Say the action item, then mark it.');
      const row = (
        await tx.query<{ id: string; at_ms: number; text: string; created_at: Date }>(
          'INSERT INTO app.meeting_marks (meeting_id, marked_by, at_ms, text) VALUES ($1::uuid, $2::uuid, $3, $4) RETURNING id::text AS id, at_ms, text, created_at',
          [m.id, who.actorId, taken[0]!.startMs, text],
        )
      ).rows[0]!;
      const count = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.meeting_marks WHERE meeting_id = $1::uuid', [m.id])).rows[0]?.n ?? 1;
      return json(
        MarkMeetingActionResponse.parse({
          mark: { id: row.id, meetingId: m.id, markedBy: who.actorId, atMs: row.at_ms, text: row.text, createdAt: row.created_at.toISOString() },
          count,
        }),
        201,
      );
    }),
  });

  ctx.http.route({
    ...getMeetingReviewRoute,
    schema: { response: GetMeetingReviewResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      await callerPerson(tx);
      // the row policy decides: someone who was in the call and can still read its channel
      const row = (await tx.query<ReviewRow>(`SELECT ${REVIEW_COLUMNS} FROM app.meeting_reviews WHERE meeting_id = $1::uuid`, [meetingId])).rows[0];
      if (!row) return json(GetMeetingReviewResponse.parse({ review: null }));
      return json(GetMeetingReviewResponse.parse({ review: toReview(row, await peopleOf(tx, meetingId)) }));
    }),
  });

  ctx.http.route({
    ...confirmMeetingReviewRoute,
    schema: { body: ConfirmMeetingReviewRequest, response: ConfirmMeetingReviewResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const body = ConfirmMeetingReviewRequest.parse(req.body);
      const who = await callerPerson(tx);
      // not FOR UPDATE: that would read through the update policy, which hides a confirmed review; the UPDATE below takes the lock and answers no row when someone was first
      const row = (await tx.query<ReviewRow>(`SELECT ${REVIEW_COLUMNS} FROM app.meeting_reviews WHERE meeting_id = $1::uuid`, [meetingId])).rows[0];
      if (!row) throw notFound('There is no review of that call for you');
      const people = await peopleOf(tx, meetingId);
      if (row.status !== 'open') throw conflict(`${toReview(row, people).confirmedByName ?? 'Someone'} confirmed these action items already.`);
      const proposed = readItems(row.items);
      if (body.seen !== proposed.length) throw conflict('The review changed since you opened it. Look at it again, then confirm.');
      const byId = new Map(proposed.map((i) => [i.id, i]));
      const offered = new Map(toReview(row, people).people.map((p) => [p.actorId, p.displayName]));
      const used = new Set<string>();
      const confirmed: MeetingReviewItem[] = [];
      for (const sent of body.items) {
        const item = byId.get(sent.id);
        if (!item || used.has(sent.id)) throw invalid('Only the items of this review can be confirmed, each once.');
        used.add(sent.id);
        if (sent.ownerId !== null && !offered.has(sent.ownerId)) throw invalid('Give an item to someone who was in the call, or to nobody.');
        const text = stripHostileText(sent.text).slice(0, MEETING_REVIEW_TEXT_MAX);
        if (text === '') throw invalid('An action item needs words.');
        const sameOwner = sent.ownerId === item.ownerId;
        confirmed.push(
          MeetingReviewItem.parse({
            ...item,
            text,
            ownerId: sent.ownerId,
            ownerName: sent.ownerId === null ? null : sameOwner && item.ownerName ? item.ownerName : (offered.get(sent.ownerId) ?? null),
          }),
        );
      }
      const updated = (
        await tx.query<ReviewRow>(
          `UPDATE app.meeting_reviews SET status = 'confirmed', confirmed_items = $2::jsonb, confirmed_by = $3::uuid, updated_at = now() WHERE meeting_id = $1::uuid AND status = 'open' RETURNING ${REVIEW_COLUMNS}`,
          [meetingId, JSON.stringify(confirmed), who.actorId],
        )
      ).rows[0];
      if (!updated) throw conflict('Someone confirmed these action items a moment ago. Look at the review again.');
      const owners = [...new Set(confirmed.flatMap((i) => (i.ownerId === null ? [] : [i.ownerId])))].slice(0, 50);
      await ctx.audit.emit(
        tx,
        MeetingsActionItemsConfirmedEvent.parse({
          type: 'meetings.action_items.confirmed',
          schemaVersion: 1,
          workspaceId: row.workspace_id,
          teamId: row.team_id,
          channelId: row.channel_id,
          meetingId,
          confirmedBy: who.actorId,
          itemCount: confirmed.length,
          removedCount: proposed.length - confirmed.length,
          ownerIds: owners,
          at: ctx.runtime.now().toISOString(),
        }),
      );
      await ctx.jobs.enqueue(tx, APPLY_QUEUE, { meetingId, workspaceId: row.workspace_id }, { dedupeKey: `review-apply:${meetingId}:${ctx.runtime.now().getTime()}` });
      await pushReview(ctx, tx, meetingId, people.map((p) => p.personId), 'confirmed');
      return json(ConfirmMeetingReviewResponse.parse({ review: toReview(updated, people) }));
    }),
  });

  ctx.jobs.register(
    REVIEW_QUEUE,
    async (raw, tx) => {
      await openReview(ctx, tx, ReviewPayload.parse(raw));
    },
    { serialKey: 'meetingId', maxAttempts: 3 },
  );
  ctx.jobs.register(
    APPLY_QUEUE,
    async (raw, tx) => {
      await applyConfirmed(ctx, tx, ReviewPayload.parse(raw));
    },
    { serialKey: 'meetingId', maxAttempts: 3 },
  );

  // The call ended: a note-taker's call (its notes are the organizer's own copy) is reviewed at once; another waits for the Scribe's notes, ten minutes at most.
  ctx.events.subscribe('meetings.meeting.ended', async (raw: PluginEvent, tx) => {
    const event = MeetingsMeetingEndedEvent.parse(raw);
    if (event.channelId === null) return;
    const m = await loadMeeting(tx, event.meetingId);
    if (!m) return;
    const spoken = (await tx.query("SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1::uuid AND final AND text <> '' LIMIT 1", [m.id])).rows.length > 0;
    const waitForNotes = m.notetaker_bot_id === null && spoken;
    await enqueueReview(ctx, tx, m.id, m.workspace_id, 'ended', waitForNotes ? new Date(ctx.runtime.now().getTime() + REVIEW_FALLBACK_MS) : undefined);
  });
  // The Scribe's notes are written: their action items join the review (or open it).
  ctx.events.subscribe('meetings.notes.written', async (raw: PluginEvent, tx) => {
    const event = MeetingsNotesWrittenEvent.parse(raw);
    if (event.store === 'organizer_files') return;
    await enqueueReview(ctx, tx, event.meetingId, event.workspaceId, 'notes');
  });
}
