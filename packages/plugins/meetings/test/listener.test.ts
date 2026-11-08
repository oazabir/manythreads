import { lastFakeMedia } from '@manythreads/plugin-media-fake';
import { readFakeAsrText, type LlmTranscriber } from '@manythreads/sdk';
import { GetMeetingTranscriptResponse, StartMeetingResponse } from '@manythreads/shared';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';

// What the note-taker does once it is in the room (PLAN P15-18, P15-19, P15-20): it hears only the people who said yes, writes what they say as server lines, keeps the
// transcript in the organizer's Personal space, stops hearing a person within five seconds of a withdrawn yes or a kick, and writes the rest when the room ends. The
// transcriber is stood in for by a function that reads the text out of the fake WAV (the real door is tested in gateway-llm).

const { omar, nadia, rafi, priya } = personas;

let w: World;
const saved = { provider: process.env['MANYTHREADS_MEDIA_PROVIDER'] };
const HOOK = Symbol.for('manythreads.meetings.listener.hook');
let outage = false;
let attempts = 0;
const transcriber: LlmTranscriber = {
  id: 'test-transcriber',
  async transcribe(_tx, request) {
    attempts += 1;
    if (outage) return { outcome: 'unavailable', reason: 'The transcription model is not reachable.' };
    return { outcome: 'text', text: readFakeAsrText(request.wav), lang: 'en' };
  },
};

let botId = '';
let id = '';
let rootId = '';

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  (globalThis as unknown as Record<symbol, unknown>)[HOOK] = { transcriber, reconcileMs: 250, flushMs: 600 };
  w = await createWorld();
  await ensureChannels(w);
  botId = await w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement, triggers)
       VALUES ($1, $2, 'note-taker', 'Note-taker', 'Takes notes', 'agent', 'hermes', 'team', $3, 'active', '{"runner": "default"}', '[{"type": "meeting"}]'::jsonb) RETURNING id`,
      [omar.workspaceId, TEAM_IDS.Engineering, 'a'.repeat(64)],
    );
    await tx.query("INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2)", [omar.workspaceId, bot.rows[0]!.id]);
    return bot.rows[0]!.id;
  });
}, 180_000);
afterAll(async () => {
  await w?.close();
  delete (globalThis as unknown as Record<symbol, unknown>)[HOOK];
  if (saved.provider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = saved.provider;
});

const call = (who: typeof omar, method: string, path: string, body?: unknown) => w.call(who, method, path, body);
const consent = async (who: typeof omar, answer: string): Promise<void> => {
  expect((await call(who, 'POST', `/api/meetings/${id}/consent`, { transcribe: answer })).status).toBe(200);
};
const speak = async (who: typeof omar, text: string): Promise<boolean> => {
  const res = await call(omar, 'POST', '/api/test/media/speak', { meetingId: id, actorId: who.actorId, text });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { delivered: boolean }).delivered;
};
const subscribed = (): string[] => [...(lastFakeMedia().listeners.get(id)?.subscriptions() ?? [])].sort();
const sorted = (...who: Array<typeof omar>): string[] => who.map((p) => p.actorId).sort();
const segments = () =>
  w.system(async (tx) =>
    (await tx.query<{ speaker_id: string; text: string; source: string }>("SELECT speaker_id, text, source FROM app.meeting_segments WHERE meeting_id = $1 ORDER BY start_ms, id", [id])).rows,
  );
const textsOf = async (who: typeof omar): Promise<string[]> => (await segments()).filter((s) => s.speaker_id === who.actorId && s.text !== '').map((s) => s.text);
const events = (type: string) => w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));
const transcriptFile = async (): Promise<string | undefined> => {
  const note = await w.system(async (tx) => (await tx.query<{ transcript_path: string | null; file_ids: string[] }>("SELECT transcript_path, file_ids FROM app.meeting_notes WHERE meeting_id = $1 AND location = 'personal'", [id])).rows[0]);
  if (!note?.transcript_path || note.file_ids.length === 0) return undefined;
  const res = await fetch(`${w.server.url}/api/files/${note.file_ids[0]}/content`, {
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId }) },
  });
  return res.status === 200 ? await res.text() : undefined;
};

describe('the note-taker hears the people who said yes', () => {
  it('sets up: a room with three people, a note-taker, and everyone asked again', async () => {
    const res = await call(nadia, 'POST', `/api/channels/${await w.channelId('engineering', 'general')}/meetings`, {});
    expect(res.status).toBe(200);
    const m = StartMeetingResponse.parse(res.body).meeting;
    id = m.id;
    rootId = m.threadRootId!;
    expect((await call(rafi, 'POST', `/api/meetings/${id}/join`)).status).toBe(200);
    expect((await call(priya, 'POST', `/api/meetings/${id}/join`)).status).toBe(200);
    expect((await call(rafi, 'PUT', `/api/meetings/${id}/notetaker`, { botId })).status).toBe(200);
    await eventually(async () => lastFakeMedia().listeners.get(id), 20_000, 'the listener to join');
    expect(subscribed()).toEqual([]); // the add reset everyone to "not asked"
    await consent(nadia, 'yes');
    await consent(rafi, 'yes');
    await consent(priya, 'no');
    await eventually(async () => (JSON.stringify(subscribed()) === JSON.stringify(sorted(nadia, rafi)) ? true : undefined), 5_000, 'the subscriptions to follow the answers');
  });

  it('hears a person who said yes: the words become a server line and a caption, and a person who said no is never delivered', async () => {
    expect(await speak(nadia, 'We ship on Friday.')).toBe(true);
    expect(await speak(priya, 'This must never be written down.')).toBe(false);
    await eventually(async () => ((await textsOf(nadia)).length > 0 ? true : undefined), 10_000, 'the line');
    const lines = await segments();
    expect(lines.filter((l) => l.speaker_id === nadia.actorId)).toEqual([{ speaker_id: nadia.actorId, text: 'We ship on Friday.', source: 'server' }]);
    expect(lines.some((l) => l.speaker_id === priya.actorId)).toBe(false);
    const shown = GetMeetingTranscriptResponse.parse((await call(rafi, 'GET', `/api/meetings/${id}/transcript`)).body).lines;
    expect(shown.map((l) => [l.speakerName, l.text])).toContainEqual(['Nadia', 'We ship on Friday.']);
    expect(lastFakeMedia().published()).toEqual([]);
  });

  it('writes each stretch of speech as its own line, a second voice too', async () => {
    expect(await speak(rafi, 'Agreed, Friday works.')).toBe(true);
    await eventually(async () => ((await textsOf(rafi)).length > 0 ? true : undefined), 10_000, 'the second person’s line');
    expect(await textsOf(nadia)).toEqual(['We ship on Friday.']);
    expect(await textsOf(rafi)).toEqual(['Agreed, Friday works.']);
  });

  it('keeps the transcript in the organizer’s Personal space within about half a minute (here: a second), in a folder of its own', async () => {
    const text = await eventually(async () => {
      const t = await transcriptFile();
      return t?.includes('Agreed, Friday works.') ? t : undefined;
    }, 15_000, 'the Personal transcript with both lines');
    expect(text).toContain('source: server');
    expect(text).toContain('note_taker: "Note-taker"');
    expect(text).toContain('**Nadia:** We ship on Friday.');
    expect(text).toContain('**Rafi:** Agreed, Friday works.');
    expect(text).not.toContain('never be written down');
    const note = await w.system(async (tx) => (await tx.query<{ transcript_path: string; organizer_id: string }>("SELECT transcript_path, organizer_id FROM app.meeting_notes WHERE meeting_id = $1", [id])).rows[0]!);
    expect(note.transcript_path).toMatch(/^Meetings\/\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+\/transcript\.md$/);
    expect(note.organizer_id).toBe(nadia.actorId);
  });

  it('follows a yes given while the room is running: the new voice is heard within five seconds', async () => {
    expect(await speak(priya, 'Before I said yes.')).toBe(false);
    const at = Date.now();
    await consent(priya, 'yes');
    await eventually(async () => (subscribed().includes(priya.actorId) ? true : undefined), 5_000, 'the new subscription');
    expect(Date.now() - at).toBeLessThan(5_000);
    expect(await speak(priya, 'Now I agree.')).toBe(true);
    await eventually(async () => ((await textsOf(priya)).includes('Now I agree.') ? true : undefined), 10_000, 'priya’s line');
    expect(await textsOf(priya)).toEqual(['Now I agree.']);
  });
});

describe('a withdrawn yes and a kick end the listening within five seconds', () => {
  it('a withdrawn yes: the track is dropped at once, nothing more is delivered and nothing already in flight is written', async () => {
    const at = Date.now();
    await consent(rafi, 'no');
    await eventually(async () => (!subscribed().includes(rafi.actorId) ? true : undefined), 5_000, 'the subscription to go');
    expect(Date.now() - at).toBeLessThan(5_000);
    expect(await speak(rafi, 'Said after saying no.')).toBe(false);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await segments()).some((s) => s.text.includes('after saying no'))).toBe(false);
    // the earlier words of that person are blanked by the consent rule, as for every other source
    expect(await textsOf(rafi)).toEqual([]);
  });

  it('a kick: removing a person from the team leaves them no track within five seconds, and no more lines', async () => {
    expect(subscribed()).toContain(priya.actorId);
    const at = Date.now();
    const res = await call(omar, 'DELETE', `/api/teams/engineering/members/${priya.personId}`);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await eventually(async () => (!subscribed().includes(priya.actorId) ? true : undefined), 5_000, 'the subscription to go');
    expect(Date.now() - at).toBeLessThan(5_000);
    expect(await speak(priya, 'Said after being removed.')).toBe(false);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await segments()).some((s) => s.text.includes('after being removed'))).toBe(false);
    expect(subscribed()).toEqual(sorted(nadia));
  });
});

describe('an unavailable transcriber', () => {
  it('writes nothing and breaks nothing; the next stretch of speech is written when it is back', async () => {
    outage = true;
    try {
      const before = attempts;
      expect(await speak(nadia, 'Lost to the outage.')).toBe(true);
      await eventually(async () => (attempts > before ? true : undefined), 20_000, 'the transcriber to be asked');
      await new Promise((r) => setTimeout(r, 500));
      expect((await segments()).some((s) => s.text.includes('outage'))).toBe(false);
    } finally {
      outage = false;
    }
    expect(await speak(nadia, 'Back again.')).toBe(true);
    await eventually(async () => ((await textsOf(nadia)).includes('Back again.') ? true : undefined), 10_000, 'the line after the outage');
    expect(lastFakeMedia().listeners.get(id)).toBeDefined(); // the listener never left
  });
});

describe('the organizer leaves and the room ends', () => {
  it('the organizer leaving does not stop the note-taker or change whose Personal space holds the transcript', async () => {
    await consent(rafi, 'yes');
    await eventually(async () => (subscribed().includes(rafi.actorId) ? true : undefined), 5_000, 'rafi’s subscription');
    expect((await call(nadia, 'POST', `/api/meetings/${id}/leave`)).status).toBe(200);
    await eventually(async () => (!subscribed().includes(nadia.actorId) ? true : undefined), 5_000, 'the organizer’s subscription to go');
    expect(await speak(rafi, 'Carrying on without the organizer.')).toBe(true);
    await eventually(async () => ((await textsOf(rafi)).includes('Carrying on without the organizer.') ? true : undefined), 10_000, 'rafi’s line');
    const note = await w.system(async (tx) => (await tx.query<{ organizer_id: string }>('SELECT organizer_id FROM app.meeting_notes WHERE meeting_id = $1', [id])).rows[0]!);
    expect(note.organizer_id).toBe(nadia.actorId);
  });

  it('ending the room hears what is left, writes the last of the transcript once, says so, and leaves', async () => {
    expect(await speak(rafi, 'One last thing before we end.')).toBe(true);
    expect((await call(nadia, 'POST', `/api/meetings/${id}/end`)).status).toBe(200);
    await eventually(async () => (lastFakeMedia().listeners.get(id) === undefined ? true : undefined), 15_000, 'the listener to leave');
    const written = await eventually(
      async () => {
        const e = (await events('meetings.transcript.written')).filter((p) => p['meetingId'] === id);
        return e.length > 0 ? e : undefined;
      },
      20_000,
      'the transcript-written notice',
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ store: 'organizer_files', lineCount: expect.any(Number) });
    expect(written[0]!['lineCount'] as number).toBeGreaterThanOrEqual(4);
    expect(String(written[0]!['path'])).toMatch(/^Meetings\/.+\/transcript\.md$/);
    const text = await transcriptFile();
    expect(text).toContain('**Rafi:** Carrying on without the organizer.');
    expect(text).toContain('**Rafi:** One last thing before we end.');
    expect(text).toContain('**Nadia:** Back again.');
    expect(text).not.toContain('after being removed');
    expect(text).not.toContain('after saying no');
    expect(text).not.toContain('outage');
    expect((text!.match(/^---$/gm) ?? []).length).toBe(2); // one header, however many times it was appended to
    const left = await eventually(
      async () => {
        const e = (await events('meetings.notetaker.removed')).filter((p) => p['meetingId'] === id);
        return e.length > 0 ? e : undefined;
      },
      20_000,
      'the notice that it left',
    );
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ removedBy: null });
    expect(rootId).not.toBe('');
  });
});
