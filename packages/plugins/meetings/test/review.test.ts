import {
  ConfirmMeetingReviewResponse,
  GetMeetingReviewResponse,
  MarkMeetingActionResponse,
  StartMeetingResponse,
  type MeetingReview,
} from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eventually } from '../../channels/test/world.ts';
import { createWorld, ensureChannels, personas, type FilesWorld } from '../../files/test/world.ts';
import { ok } from './notes-world.ts';

// Mark action item and the end-of-call review (PLAN P17-06 step 2) through the real server:
//  * a person in the live call marks the last 30 seconds: the words of people who said yes only; a person not in the call, and a call where nothing was said, are refused;
//  * when the call has ended the review opens for the people who were in it (a notification each), not for a reader of the channel who was not;
//  * Confirm checks what it is sent (the count seen, the ids, the owners), keeps the edited words and owners, says so with ids and counts only, and is done once;
//  * notes written after the confirmation open the review again; the second confirmation writes only the confirmed items into the notes' list and its file.

const { omar, nadia, rafi, priya } = personas;
vi.setConfig({ testTimeout: 180_000 });

let w: FilesWorld;
let general = '';
let room = '';
let startedAt = 0;
let seq = 0;

const clockNow = (): number => Date.now() - startedAt;
const say = async (who: typeof nadia, text: string): Promise<void> => {
  const at = Math.max(0, clockNow() - 2000);
  ok(await w.call(who, 'POST', `/api/meetings/${room}/segments`, { segments: [{ clientSegId: `rv${++seq}`, startMs: at, endMs: at + 1500, text, final: true }] }));
};
const reviewOf = async (who: typeof nadia): Promise<MeetingReview | null> => GetMeetingReviewResponse.parse(ok(await w.call(who, 'GET', `/api/meetings/${room}/review`))).review;
const enqueueReview = () =>
  w.system((tx) => tx.query("SELECT app.enqueue_job('meetings.review', $1::jsonb, now(), NULL)", [JSON.stringify({ meetingId: room, workspaceId: omar.workspaceId })]));
const events = (type: string) => w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld({ limiter: relaxedRateLimiter() } as never);
  await ensureChannels(w);
  general = await w.channelId('engineering', 'general');
  const started = StartMeetingResponse.parse(ok(await w.call(nadia, 'POST', `/api/channels/${general}/meetings`, { title: 'Release planning' })));
  room = started.meeting.id;
  startedAt = Date.parse(started.meeting.startedAt);
  for (const p of [rafi, priya]) ok(await w.call(p, 'POST', `/api/meetings/${room}/join`));
  ok(await w.call(nadia, 'PUT', `/api/meetings/${room}/transcription`, { mode: 'on_device' }));
  ok(await w.call(nadia, 'POST', `/api/meetings/${room}/consent`, { transcribe: 'yes' }));
  ok(await w.call(rafi, 'POST', `/api/meetings/${room}/consent`, { transcribe: 'yes' }));
  ok(await w.call(priya, 'POST', `/api/meetings/${room}/consent`, { transcribe: 'no' }));
}, 240_000);
afterAll(async () => {
  await w?.close();
  delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
});

describe('Mark action item', () => {
  it('says so when nothing was written down yet', async () => {
    const res = await w.call(rafi, 'POST', `/api/meetings/${room}/marks`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Nothing was written down in the last 30 seconds');
  });

  it('keeps the last 30 seconds, only the words of people who said yes', async () => {
    await say(nadia, 'I will send the release draft.');
    await say(priya, 'PRIYA-NEVER-WRITTEN');
    await say(rafi, 'By Friday then.');
    const res = MarkMeetingActionResponse.parse(ok(await w.call(rafi, 'POST', `/api/meetings/${room}/marks`), 201));
    expect(res.mark.text).toBe('Nadia: I will send the release draft. Rafi: By Friday then.');
    expect(res.mark.markedBy).toBe(rafi.actorId);
    expect(res.count).toBe(1);
  });

  it('is refused for a person who is not in the call', async () => {
    const res = await w.call(omar, 'POST', `/api/meetings/${room}/marks`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Join the call');
  });

  it('opens no review while the call is live', async () => {
    expect(await reviewOf(rafi)).toBeNull();
  });
});

describe('the end-of-call review', () => {
  let review: MeetingReview;

  beforeAll(async () => {
    ok(await w.call(nadia, 'POST', `/api/meetings/${room}/end`));
    // the notes of this call may fail (no Scribe in this world) and open the review by themselves; the fallback is ten minutes away, so ask now as well
    await eventually(async () => (await w.system(async (tx) => (await tx.query("SELECT status FROM app.meeting_notes WHERE meeting_id = $1 AND status <> 'pending'", [room])).rows[0])) ?? false, 15_000, 'the notes to settle').catch(() => undefined);
    await enqueueReview();
    review = await eventually(async () => (await reviewOf(rafi)) ?? undefined, 30_000, 'the review');
  }, 120_000);

  it('holds the mark, for the people who were in the call', async () => {
    expect(review.status).toBe('open');
    expect(review.items.map((i) => [i.source, i.text])).toEqual([['mark', 'Nadia: I will send the release draft. Rafi: By Friday then.']]);
    expect(review.canConfirm).toBe(true);
    expect(review.people.map((p) => p.displayName).sort()).toEqual(['Nadia', 'Priya', 'Rafi']);
    expect(await reviewOf(priya)).not.toBeNull();
    // a reader of the channel who was not in the call sees no review
    expect(await reviewOf(omar)).toBeNull();
  });

  it('tells each of them once, and opens the meeting page', async () => {
    const opened = await events('meetings.review.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ meetingId: room, itemCount: 1 });
    expect((opened[0]!['personIds'] as string[]).sort()).toEqual([nadia.personId, rafi.personId, priya.personId].sort());
    const rows = await eventually(
      async () => {
        const r = await w.system(async (tx) => (await tx.query<{ person_id: string; preview: string; ref_type: string }>("SELECT person_id, preview, ref_type FROM app.notifications WHERE ref_id = $1 AND kind = 'meeting_actions'", [room])).rows);
        return r.length >= 3 ? r : undefined;
      },
      20_000,
      'the notifications',
    );
    expect(rows.map((r) => r.person_id).sort()).toEqual([nadia.personId, rafi.personId, priya.personId].sort());
    expect(rows[0]).toMatchObject({ preview: 'Review 1 action item from Release planning', ref_type: 'meeting' });
  });

  it('checks what Confirm is sent', async () => {
    const id = review.items[0]!.id;
    const stale = await w.call(rafi, 'POST', `/api/meetings/${room}/review/confirm`, { items: [], seen: 2 });
    expect(stale.status).toBe(409);
    const unknown = await w.call(rafi, 'POST', `/api/meetings/${room}/review/confirm`, { items: [{ id: '00000000-0000-4000-8000-000000000999', text: 'x', ownerId: null }], seen: 1 });
    expect(unknown.status).toBe(400);
    const stranger = await w.call(rafi, 'POST', `/api/meetings/${room}/review/confirm`, { items: [{ id, text: 'x', ownerId: omar.actorId }], seen: 1 });
    expect(stranger.status).toBe(400);
    const outsider = await w.call(omar, 'POST', `/api/meetings/${room}/review/confirm`, { items: [], seen: 1 });
    expect(outsider.status).toBe(404);
  });

  it('keeps the edited words and owner, says so with counts only, and is done once', async () => {
    const id = review.items[0]!.id;
    const res = ConfirmMeetingReviewResponse.parse(
      ok(await w.call(rafi, 'POST', `/api/meetings/${room}/review/confirm`, { items: [{ id, text: 'Send the release draft by Friday', ownerId: nadia.actorId }], seen: 1 })),
    );
    expect(res.review).toMatchObject({ status: 'confirmed', confirmedByName: 'Rafi', canConfirm: false });
    expect(res.review.items).toEqual([expect.objectContaining({ id, text: 'Send the release draft by Friday', ownerId: nadia.actorId, ownerName: 'Nadia' })]);
    const confirmed = await events('meetings.action_items.confirmed');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ meetingId: room, confirmedBy: rafi.actorId, itemCount: 1, removedCount: 0, ownerIds: [nadia.actorId] });
    expect(JSON.stringify(confirmed[0])).not.toContain('Friday');
    const again = await w.call(nadia, 'POST', `/api/meetings/${room}/review/confirm`, { items: [], seen: 1 });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain('Rafi confirmed these action items already');
  });

  it('opens again when the notes come after it, and the second Confirm puts only the confirmed items into the notes', async () => {
    // the Scribe's notes arrive late: written as the notes job writes them, with two action items, one of them the same as the confirmed one
    const notesMd = ['# Release planning', '', '## Summary', '', 'Hand-edited summary.', '', '## Action items', '', '- [ ] Scribe item — no owner', '', '## Open questions', '', '*None.*', ''].join('\n');
    const items = [
      { kind: 'decision', text: 'Ship on Friday', ownerName: null, ownerId: null, due: null, atMs: 0 },
      { kind: 'action', text: 'Send the release draft by Friday', ownerName: null, ownerId: null, due: null, atMs: 0 },
      { kind: 'action', text: 'Book the launch room', ownerName: 'Rafi', ownerId: rafi.actorId, due: '2026-12-01', atMs: 0 },
    ];
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.meeting_notes (meeting_id, workspace_id, organizer_id, location, transcript_path, notes_path, summary, notes_md, items, status)
         VALUES ($1, $2, $3, 'repo', $4, $5, 'x', $6, $7::jsonb, 'written')
         ON CONFLICT (meeting_id) DO UPDATE SET status = 'written', failure = NULL, location = 'repo', transcript_path = coalesce(app.meeting_notes.transcript_path, EXCLUDED.transcript_path),
                notes_md = EXCLUDED.notes_md, items = EXCLUDED.items, summary = 'x'`,
        [room, omar.workspaceId, nadia.actorId, 'meetings/2026/11/25/1000-release-planning/transcript.md', 'meetings/2026/11/25/1000-release-planning/notes.md', notesMd, JSON.stringify(items)],
      ),
    );
    await enqueueReview();
    const reopened = await eventually(async () => {
      const r = await reviewOf(nadia);
      return r?.status === 'open' ? r : undefined;
    }, 30_000, 'the review to open again');
    expect(reopened.notesIncluded).toBe(true);
    expect(reopened.items.map((i) => i.text)).toEqual(['Send the release draft by Friday', 'Book the launch room']);
    // no second notification: the people were told when it first opened
    expect(await events('meetings.review.opened')).toHaveLength(1);

    const keep = reopened.items[1]!;
    ok(await w.call(nadia, 'POST', `/api/meetings/${room}/review/confirm`, { items: [{ id: keep.id, text: keep.text, ownerId: keep.ownerId }], seen: 2 }));
    const notes = await eventually(
      async () => {
        const r = (await w.system(async (tx) => (await tx.query<{ items: Array<{ kind: string; text: string; ownerName: string | null; due: string | null }>; notes_md: string }>('SELECT items, notes_md FROM app.meeting_notes WHERE meeting_id = $1', [room])).rows[0]))!;
        return r.notes_md.includes('Book the launch room') ? r : undefined;
      },
      30_000,
      'the notes to change',
    );
    expect(notes.items.filter((i) => i.kind === 'action')).toEqual([expect.objectContaining({ text: 'Book the launch room', ownerName: 'Rafi', due: '2026-12-01' })]);
    expect(notes.items.filter((i) => i.kind === 'decision')).toHaveLength(1);
    expect(notes.notes_md).toContain('Hand-edited summary.');
    expect(notes.notes_md).toContain('- [ ] Book the launch room — owner: Rafi, due 2026-12-01');
    expect(notes.notes_md).not.toContain('Scribe item');
    expect(notes.notes_md).not.toContain('Send the release draft');
  });
});

describe('a no to being transcribed takes the words out of the marks', () => {
  const marksOf = (meetingId: string) =>
    w.system(async (tx) => (await tx.query<{ text: string; speaker_ids: string[] }>('SELECT text, speaker_ids::text[] AS speaker_ids FROM app.meeting_marks WHERE meeting_id = $1 ORDER BY created_at', [meetingId])).rows);

  beforeAll(async () => {
    const started = StartMeetingResponse.parse(ok(await w.call(nadia, 'POST', `/api/channels/${general}/meetings`, { title: 'Second planning' })));
    room = started.meeting.id;
    startedAt = Date.parse(started.meeting.startedAt);
    ok(await w.call(rafi, 'POST', `/api/meetings/${room}/join`));
    ok(await w.call(priya, 'POST', `/api/meetings/${room}/join`));
    ok(await w.call(nadia, 'PUT', `/api/meetings/${room}/transcription`, { mode: 'on_device' }));
    for (const p of [nadia, rafi, priya]) ok(await w.call(p, 'POST', `/api/meetings/${room}/consent`, { transcribe: 'yes' }));
  }, 120_000);

  it('a mark names whose words it holds; a no from one of them removes it, the others stay', async () => {
    await say(nadia, 'NADIA-SECRET-PLAN for the launch.');
    await say(rafi, 'Sounds right.');
    const first = MarkMeetingActionResponse.parse(ok(await w.call(rafi, 'POST', `/api/meetings/${room}/marks`), 201));
    expect(first.mark.text).toContain('NADIA-SECRET-PLAN');
    expect((await marksOf(room))[0]!.speaker_ids.sort()).toEqual([nadia.actorId, rafi.actorId].sort());

    ok(await w.call(nadia, 'POST', `/api/meetings/${room}/consent`, { transcribe: 'no' }));
    expect(JSON.stringify(await marksOf(room))).not.toContain('NADIA-SECRET-PLAN');
    expect(await marksOf(room)).toEqual([]);
  });

  it('a mark whose speaker said no since is left out of the review; the others are reviewed', async () => {
    await say(priya, 'PRIYA-LATE-NO words.');
    const hers = MarkMeetingActionResponse.parse(ok(await w.call(priya, 'POST', `/api/meetings/${room}/marks`), 201));
    expect(hers.mark.text).toContain('PRIYA-LATE-NO');
    // and a mark of Rafi's words alone (written as the platform: the 30-second window still holds Priya's line)
    await w.system((tx) =>
      tx.query("INSERT INTO app.meeting_marks (meeting_id, marked_by, at_ms, text, speaker_ids) VALUES ($1, $2, 0, 'Rafi: I will book the room.', ARRAY[$2]::uuid[])", [room, rafi.actorId]),
    );
    // her answer turns to no without the consent route (a mark that slipped past it): the review job leaves her mark out and removes it
    await w.system((tx) => tx.query("UPDATE app.meeting_participants SET consent_transcribe = 'no' WHERE meeting_id = $1 AND actor_id = $2", [room, priya.actorId]));
    ok(await w.call(nadia, 'POST', `/api/meetings/${room}/end`));
    await enqueueReview();
    const review = await eventually(async () => (await reviewOf(rafi)) ?? undefined, 30_000, 'the review');
    expect(review.items.map((i) => i.text)).toEqual(['Rafi: I will book the room.']);
    expect(JSON.stringify(review)).not.toContain('PRIYA-LATE-NO');
    expect((await marksOf(room)).map((k) => k.text)).toEqual(['Rafi: I will book the room.']);
  });
});
