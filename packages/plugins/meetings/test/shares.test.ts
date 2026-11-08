import {
  CreateMeetingShareResponse,
  DeleteMeetingShareResponse,
  GetMeetingNotesResponse,
  GetMeetingTranscriptResponse,
  ListMeetingSharesResponse,
} from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type FilesWorld } from '../../files/test/world.ts';
import { ok, seedNoteTakerMeeting, type SeededMeeting } from './notes-world.ts';

// Sharing a note-taker meeting's notes (PLAN P15-22, decision C18). The organizer's notes are in their Personal space; a share lets one person, or the readers of one channel, open
// them through the meeting page. Every grant and revoke is an audit event, and the reader's right is checked again on every read: a person who has left the team reads nothing.

const { omar, nadia, rafi, priya, sameera } = personas;
vi.setConfig({ testTimeout: 120_000 });

let w: FilesWorld;
let general = '';
let meeting: SeededMeeting;
let shareToRafi = '';

const sharesOf = (id: string) => w.call(nadia, 'GET', `/api/meetings/${id}/shares`);
const notesFor = (who: typeof nadia, id: string) => w.call(who, 'GET', `/api/meetings/${id}/notes`);
const events = (type: string) => w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld({ limiter: relaxedRateLimiter() } as never);
  await ensureChannels(w);
  general = await w.channelId('engineering', 'general');
  meeting = await seedNoteTakerMeeting(w, {
    organizer: nadia,
    channelId: general,
    others: [[rafi, 'yes'], [priya, 'yes']],
    lines: [[nadia, 'We ship on Thursday.'], [rafi, 'Agreed.']],
  });
}, 240_000);
afterAll(async () => {
  await w?.close();
  delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
});

describe('who may see and make shares', () => {
  it('shows the list to the organizer, empty at first', async () => {
    expect(ListMeetingSharesResponse.parse(ok(await sharesOf(meeting.id))).shares).toEqual([]);
  });
  it('does not show a person who was not shared with the meeting’s notes at all: 404, as for a meeting that does not exist', async () => {
    expect((await w.call(priya, 'GET', `/api/meetings/${meeting.id}/shares`)).status).toBe(404);
    expect((await w.call(priya, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'person', personId: rafi.personId })).status).toBe(404);
    expect((await notesFor(priya, meeting.id)).status).toBe(404);
    expect((await w.call(priya, 'GET', `/api/meetings/${meeting.id}/transcript?copy=organizer`)).status).toBe(404);
  });
  it('keeps the room’s own transcript from a person who was in the call but was not given the notes: the words are the organizer’s Personal copy', async () => {
    expect((await w.call(nadia, 'GET', `/api/meetings/${meeting.id}/transcript`)).status).toBe(200);
    expect((await w.call(priya, 'GET', `/api/meetings/${meeting.id}/transcript`)).status).toBe(404);
    expect((await w.call(rafi, 'GET', `/api/meetings/${meeting.id}/transcript`)).status).toBe(404);
  });
  it('refuses a share with oneself, with someone who does not exist, and with someone who is not in the place the call was held', async () => {
    expect((await w.call(nadia, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'person', personId: nadia.personId })).status).toBe(400);
    expect((await w.call(nadia, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'person', personId: '00000000-0000-7000-8000-0000000cffff' })).status).toBe(404);
    expect((await w.call(nadia, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'person', personId: sameera.personId })).status).toBe(409);
  });
  it('refuses to share a call that is still going', async () => {
    const live = await seedNoteTakerMeeting(w, { organizer: nadia, channelId: await w.channelId('engineering', 'incidents'), title: 'Live one', end: false });
    expect((await w.call(nadia, 'POST', `/api/meetings/${live.id}/shares`, { kind: 'person', personId: rafi.personId })).status).toBe(409);
    ok(await w.call(nadia, 'POST', `/api/meetings/${live.id}/end`));
  });
});

describe('sharing with a person', () => {
  it('makes the share, tells the audit log (ids only) and lets the person read the notes and the organizer’s copy of the transcript', async () => {
    const made = CreateMeetingShareResponse.parse(ok(await w.call(nadia, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'person', personId: rafi.personId })));
    shareToRafi = made.share.id;
    expect(made.share).toMatchObject({ meetingId: meeting.id, revokedAt: null, grantee: { kind: 'person', personId: rafi.personId, displayName: 'Rafi' } });
    const logged = (await events('meetings.notes.shared')).filter((e) => e['meetingId'] === meeting.id);
    expect(logged).toEqual([expect.objectContaining({ sharedBy: nadia.actorId, granteeKind: 'person', granteeId: rafi.personId, revoked: false })]);
    expect(JSON.stringify(logged)).not.toContain('ship on Thursday');

    const notes = GetMeetingNotesResponse.parse(ok(await notesFor(rafi, meeting.id)));
    expect(notes).toMatchObject({ status: 'written', location: 'personal', summary: 'They agreed to ship on Thursday.', canEdit: false, canShare: false, canSaveToTeam: false });
    expect(notes.notesMd).toContain('Ship on Thursday');
    // a shared reader is never told where the organizer's Personal files are
    expect(notes.transcriptPath).toBeNull();
    expect(notes.notesPath).toBeNull();

    // with the share the room's own transcript opens too (the same lines)
    expect((await w.call(rafi, 'GET', `/api/meetings/${meeting.id}/transcript`)).status).toBe(200);
    const lines = GetMeetingTranscriptResponse.parse(ok(await w.call(rafi, 'GET', `/api/meetings/${meeting.id}/transcript?copy=organizer`))).lines;
    expect(lines.map((l) => [l.speakerName, l.text])).toEqual([['Nadia', 'We ship on Thursday.'], ['Rafi', 'Agreed.']]);
    expect(lines.every((l) => !l.editable)).toBe(true);
  });
  it('sharing again with the same person returns the same share and logs nothing new', async () => {
    const again = CreateMeetingShareResponse.parse(ok(await w.call(nadia, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'person', personId: rafi.personId })));
    expect(again.share.id).toBe(shareToRafi);
    expect((await events('meetings.notes.shared')).filter((e) => e['meetingId'] === meeting.id)).toHaveLength(1);
  });
  it('a person it was shared with cannot make or take back shares, and does not see the list', async () => {
    expect((await w.call(rafi, 'GET', `/api/meetings/${meeting.id}/shares`)).status).toBe(403);
    expect((await w.call(rafi, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'person', personId: priya.personId })).status).toBe(403);
    expect((await w.call(rafi, 'DELETE', `/api/meetings/${meeting.id}/shares/${shareToRafi}`)).status).toBe(403);
  });
  it('a person it was shared with cannot edit, share or save the notes', async () => {
    expect((await w.call(rafi, 'PUT', `/api/meetings/${meeting.id}/notes`, { notesMd: 'Rewritten.' })).status).toBe(403);
    expect((await w.call(rafi, 'POST', `/api/meetings/${meeting.id}/save-to-team`, { addToMemory: false })).status).toBe(403);
  });
  it('taking the share back stops the reading at once and is logged', async () => {
    const gone = DeleteMeetingShareResponse.parse(ok(await w.call(nadia, 'DELETE', `/api/meetings/${meeting.id}/shares/${shareToRafi}`)));
    expect(gone.share.revokedAt).not.toBeNull();
    expect((await notesFor(rafi, meeting.id)).status).toBe(404);
    expect((await w.call(rafi, 'GET', `/api/meetings/${meeting.id}/transcript?copy=organizer`)).status).toBe(404);
    const logged = (await events('meetings.notes.shared')).filter((e) => e['meetingId'] === meeting.id);
    expect(logged.map((e) => e['revoked'])).toEqual([false, true]);
    // taking it back twice is not an error, and logs nothing more
    expect(DeleteMeetingShareResponse.parse(ok(await w.call(nadia, 'DELETE', `/api/meetings/${meeting.id}/shares/${shareToRafi}`))).share.revokedAt).not.toBeNull();
    expect((await events('meetings.notes.shared')).filter((e) => e['meetingId'] === meeting.id)).toHaveLength(2);
  });
  it('a share can be made again after it was taken back', async () => {
    const again = CreateMeetingShareResponse.parse(ok(await w.call(nadia, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'person', personId: rafi.personId })));
    expect(again.share.id).not.toBe(shareToRafi);
    expect((await notesFor(rafi, meeting.id)).status).toBe(200);
    shareToRafi = again.share.id;
  });
});

describe('sharing with a channel', () => {
  let channelId = '';
  it('refuses a channel the organizer cannot see', async () => {
    const hidden = '00000000-0000-7000-8000-0000000ffff0';
    expect((await w.call(nadia, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'channel', channelId: hidden })).status).toBe(404);
  });
  it('lets the readers of the channel read, and only them', async () => {
    channelId = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'notes-readers', private: true }), 201).channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${channelId}/members`, { personId: nadia.personId }));
    ok(await w.call(omar, 'POST', `/api/channels/${channelId}/members`, { personId: priya.personId }));
    expect((await notesFor(priya, meeting.id)).status).toBe(404);
    const made = CreateMeetingShareResponse.parse(ok(await w.call(nadia, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'channel', channelId })));
    expect(made.share.grantee).toMatchObject({ kind: 'channel', channelId });
    expect((await notesFor(priya, meeting.id)).status).toBe(200);
    // a person who cannot read the channel the notes were shared with reads nothing
    expect((await notesFor(sameera, meeting.id)).status).toBe(404);
    const logged = (await events('meetings.notes.shared')).filter((e) => e['granteeKind'] === 'channel');
    expect(logged[0]).toMatchObject({ granteeId: channelId, revoked: false });
  });
  it('taking the channel share back closes it again', async () => {
    const list = ListMeetingSharesResponse.parse(ok(await sharesOf(meeting.id))).shares;
    const share = list.find((s) => s.grantee.kind === 'channel')!;
    ok(await w.call(nadia, 'DELETE', `/api/meetings/${meeting.id}/shares/${share.id}`));
    expect((await notesFor(priya, meeting.id)).status).toBe(404);
  });
});

describe('a person who left the team no longer reads', () => {
  it('is refused with 404 after being removed from the team, whatever the share says, and the share is still on the list', async () => {
    const made = CreateMeetingShareResponse.parse(ok(await w.call(nadia, 'POST', `/api/meetings/${meeting.id}/shares`, { kind: 'person', personId: priya.personId })));
    expect((await notesFor(priya, meeting.id)).status).toBe(200);
    const removed = await w.call(omar, 'DELETE', `/api/teams/engineering/members/${priya.personId}`);
    expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);
    expect((await notesFor(priya, meeting.id)).status).toBe(404);
    expect((await w.call(priya, 'GET', `/api/meetings/${meeting.id}/transcript?copy=organizer`)).status).toBe(404);
    expect((await w.call(priya, 'GET', `/api/meetings/${meeting.id}/summary`)).status).toBe(404);
    expect(ListMeetingSharesResponse.parse(ok(await sharesOf(meeting.id))).shares.some((s) => s.id === made.share.id && s.revokedAt === null)).toBe(true);
  });
});

describe('an organizer who left the team', () => {
  it('keeps their own Personal copy but no longer reads or edits the notes written for the team', async () => {
    const personal = await seedNoteTakerMeeting(w, { organizer: rafi, channelId: general, others: [[nadia, 'yes']], lines: [[rafi, 'My own words.']], title: 'Rafi personal' });
    const team = await seedNoteTakerMeeting(w, { organizer: rafi, channelId: general, others: [[nadia, 'yes']], lines: [[rafi, 'Words for the team.']], title: 'Rafi team' });
    await w.system(async (tx) => {
      await tx.query("UPDATE app.meeting_notes SET location = 'repo', transcript_path = 'meetings/2026/11/08-1000-rafi-team/transcript.md', notes_path = 'meetings/2026/11/08-1000-rafi-team/notes.md' WHERE meeting_id = $1", [team.id]);
    });
    expect((await notesFor(rafi, team.id)).status).toBe(200);
    const removed = await w.call(omar, 'DELETE', `/api/teams/engineering/members/${rafi.personId}`);
    expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);
    expect((await notesFor(rafi, team.id)).status).toBe(404);
    expect((await w.call(rafi, 'PUT', `/api/meetings/${team.id}/notes`, { notesMd: 'Rewritten after leaving.', baseUpdatedAt: '2020-01-01T00:00:00.000Z' })).status).toBe(404);
    expect((await notesFor(rafi, personal.id)).status).toBe(200);
    // the people still in the team read the team's copy as before
    expect((await notesFor(nadia, team.id)).status).toBe(200);
  });
});
