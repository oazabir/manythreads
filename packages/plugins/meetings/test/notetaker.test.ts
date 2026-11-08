import { lastFakeMedia } from '@manythreads/plugin-media-fake';
import {
  ListMeetingNotetakersResponse,
  MeetingTranscriptionState,
  RemoveMeetingNotetakerResponse,
  SetMeetingNotetakerResponse,
  StartMeetingResponse,
} from '@manythreads/shared';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { readTeamNotetakerAllowed } from '../src/notetaker.ts';

// The note-taker in a room (PLAN P15-18): who may add and remove it, which bots are eligible, the switches that can forbid it, the announcement in the call thread, the
// consent reset, the listen-only token, and that it leaves with the room. What it hears and writes is in listener.test.ts.

const { omar, nadia, rafi, sameera, priya } = personas;

describe('TEAM.md: may the team have a note-taker', () => {
  it('allows it when the file, the frontmatter or the key is missing', () => {
    expect(readTeamNotetakerAllowed(null)).toBe(true);
    expect(readTeamNotetakerAllowed('# Team\n')).toBe(true);
    expect(readTeamNotetakerAllowed('---\nname: Engineering\n---\n')).toBe(true);
    expect(readTeamNotetakerAllowed('---\nmeetings:\n  transcribe: server\n---\n')).toBe(true);
    expect(readTeamNotetakerAllowed('---\n---\n')).toBe(true);
  });
  it('reads on and off', () => {
    expect(readTeamNotetakerAllowed('---\nmeetings:\n  noteTaker: on\n---\n')).toBe(true);
    expect(readTeamNotetakerAllowed('---\nmeetings:\n  noteTaker: off\n---\n')).toBe(false);
  });
  it('reads a key that is there but wrong as off, so a typo never lets in what the team meant to keep out', () => {
    expect(readTeamNotetakerAllowed('---\nmeetings:\n  noteTaker: of\n---\n')).toBe(false);
    expect(readTeamNotetakerAllowed('---\nmeetings:\n  noteTaker: true\n---\n')).toBe(false);
    expect(readTeamNotetakerAllowed('---\nmeetings: nope\n---\n')).toBe(false);
    expect(readTeamNotetakerAllowed('---\n: : :\n  - [\n---\n')).toBe(false);
    expect(readTeamNotetakerAllowed('---\njust a string\n---\n')).toBe(false);
  });
});

let w: World;
const saved = { provider: process.env['MANYTHREADS_MEDIA_PROVIDER'], asr: process.env['MANYTHREADS_FAKE_ASR'], max: process.env['MANYTHREADS_NOTETAKER_MAX_ROOMS'] };
const HOOK = Symbol.for('manythreads.meetings.listener.hook');
const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

let noTrigger = '';
const bots: Record<string, string> = {};

async function makeBot(slug: string, name: string, options: { team?: string; triggers?: unknown[]; status?: string; visibility?: string } = {}): Promise<string> {
  return w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement, triggers)
       VALUES ($1, $2, $3, $4, 'Takes notes', 'agent', 'hermes', $5, $6, $7, '{"runner": "default"}', $8::jsonb) RETURNING id`,
      [omar.workspaceId, options.team ?? TEAM_IDS.Engineering, slug, name, options.visibility ?? 'team', 'a'.repeat(64), options.status ?? 'active', JSON.stringify(options.triggers ?? [{ type: 'meeting' }])],
    );
    await tx.query("INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2)", [omar.workspaceId, bot.rows[0]!.id]);
    return bot.rows[0]!.id;
  });
}

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  process.env['MANYTHREADS_FAKE_ASR'] = '1';
  (globalThis as unknown as Record<symbol, unknown>)[HOOK] = { reconcileMs: 250, flushMs: 500 };
  w = await createWorld();
  await ensureChannels(w);
  bots['note-taker'] = await makeBot('note-taker', 'Note-taker');
  bots['second'] = await makeBot('second-taker', 'Second taker');
  bots['workspace'] = await makeBot('workspace-taker', 'Workspace taker', { team: TEAM_IDS.Marketing, visibility: 'workspace' });
  noTrigger = await makeBot('plain-bot', 'Plain bot', { triggers: [{ type: 'mention' }] });
  bots['disabled'] = await makeBot('disabled-taker', 'Disabled taker', { status: 'disabled' });
  bots['marketing'] = await makeBot('marketing-taker', 'Marketing taker', { team: TEAM_IDS.Marketing });
}, 180_000);
afterAll(async () => {
  await w?.close();
  delete (globalThis as unknown as Record<symbol, unknown>)[HOOK];
  restore('MANYTHREADS_MEDIA_PROVIDER', saved.provider);
  restore('MANYTHREADS_FAKE_ASR', saved.asr);
  restore('MANYTHREADS_NOTETAKER_MAX_ROOMS', saved.max);
});

const room = async (who: typeof omar, name: string): Promise<{ id: string; thread: string }> => {
  const res = await w.call(who, 'POST', `/api/channels/${await w.channelId('engineering', name)}/meetings`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const m = StartMeetingResponse.parse(res.body).meeting;
  return { id: m.id, thread: m.threadRootId! };
};
const join = (who: typeof omar, id: string) => w.call(who, 'POST', `/api/meetings/${id}/join`);
const end = (who: typeof omar, id: string) => w.call(who, 'POST', `/api/meetings/${id}/end`);
const consent = (who: typeof omar, id: string, answer: string) => w.call(who, 'POST', `/api/meetings/${id}/consent`, { transcribe: answer });
const list = (who: typeof omar, id: string) => w.call(who, 'GET', `/api/meetings/${id}/notetakers`);
const add = (who: typeof omar, id: string, botId: string) => w.call(who, 'PUT', `/api/meetings/${id}/notetaker`, { botId });
const remove = (who: typeof omar, id: string) => w.call(who, 'DELETE', `/api/meetings/${id}/notetaker`);
const events = (type: string) => w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));
const thread = (rootId: string) => w.system(async (tx) => (await tx.query<{ body: string }>('SELECT body FROM app.messages WHERE thread_root_id = $1 ORDER BY id', [rootId])).rows.map((r) => r.body));
const answers = (id: string) =>
  w.system(async (tx) => Object.fromEntries((await tx.query<{ actor_id: string; consent_transcribe: string }>('SELECT actor_id, consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1', [id])).rows.map((r) => [r.actor_id, r.consent_transcribe])));
const settings = (body: unknown) => w.call(omar, 'PUT', '/api/workspace/meetings-settings', body);
const listenerOf = (id: string) => lastFakeMedia().listenerIn(id);

describe('which bots can be added', () => {
  let id = '';
  beforeAll(async () => {
    id = (await room(nadia, 'general')).id;
  });
  afterAll(async () => void (await end(nadia, id)));

  it('lists the active bots of the room’s team and the workspace-wide ones that list the trigger "meeting", and nobody else', async () => {
    const res = await list(nadia, id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = ListMeetingNotetakersResponse.parse(res.body);
    expect(body.bots.map((b) => b.name)).toEqual(['Note-taker', 'Second taker', 'Workspace taker']);
    expect(body).toMatchObject({ current: null, canAdd: true, reason: null });
  });
  it('is not shown to a stranger', async () => {
    expect((await list(sameera, id)).status).toBe(404);
    expect((await add(sameera, id, bots['note-taker']!)).status).toBe(404);
    expect((await remove(sameera, id)).status).toBe(404);
  });
  it('says a person who has not joined cannot add one, and refuses it', async () => {
    const body = ListMeetingNotetakersResponse.parse((await list(omar, id)).body);
    expect(body).toMatchObject({ canAdd: false, reason: 'Join the voice room to add a note-taker.' });
    expect((await add(omar, id, bots['note-taker']!)).status).toBe(403);
  });
  it('refuses a bot without the trigger, a disabled one, one of another team and one that does not exist', async () => {
    for (const botId of [noTrigger, bots['disabled']!, bots['marketing']!, '00000000-0000-7000-8000-0000000f0000']) {
      const res = await add(nadia, id, botId);
      expect(res.status, botId).toBe(409);
    }
    expect(ListMeetingNotetakersResponse.parse((await list(nadia, id)).body).current).toBeNull();
  });
});

describe('adding and removing', () => {
  let id = '';
  let rootId = '';
  beforeAll(async () => {
    const r = await room(nadia, 'incidents');
    id = r.id;
    rootId = r.thread;
    await join(rafi, id);
    await join(priya, id);
    await consent(nadia, id, 'yes');
    await consent(rafi, id, 'no');
  });

  it('lets anyone who is in the room add one: it moves the room to the server and asks everybody again', async () => {
    const res = await add(rafi, id, bots['note-taker']!);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(SetMeetingNotetakerResponse.parse(res.body).notetaker.bot).toMatchObject({ botId: bots['note-taker'], name: 'Note-taker', slug: 'note-taker' });
    expect(await answers(id)).toEqual({ [nadia.actorId]: 'unasked', [rafi.actorId]: 'unasked', [priya.actorId]: 'unasked' });
    const state = MeetingTranscriptionState.parse((await w.call(nadia, 'GET', `/api/meetings/${id}/transcription`)).body);
    expect(state).toMatchObject({ mode: 'server', turnedOnBy: { actorId: rafi.actorId } });
    const row = await w.system(async (tx) => (await tx.query<{ notetaker_bot_id: string; notetaker_by: string }>('SELECT notetaker_bot_id, notetaker_by FROM app.meetings WHERE id = $1', [id])).rows[0]!);
    expect(row).toEqual({ notetaker_bot_id: bots['note-taker'], notetaker_by: rafi.actorId });
    const added = (await events('meetings.notetaker.added')).filter((p) => p['meetingId'] === id);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ botId: bots['note-taker'], addedBy: rafi.actorId });
    expect(JSON.stringify(added[0])).not.toContain('Note-taker'); // ids only
  });

  it('says so in the call thread, once, in plain words, as the person who added it', async () => {
    const lines = await eventually(async () => {
      const t = await thread(rootId);
      return t.some((b) => b.includes('added')) ? t : undefined;
    }, 20_000, 'the announcement');
    const said = lines.filter((b) => b.includes('added'));
    expect(said).toEqual(['Rafi added Note-taker. It listens on the server and writes notes for Nadia. Everyone is asked again whether it may transcribe their voice.']);
    const author = await w.system(async (tx) => (await tx.query<{ author_id: string }>("SELECT author_id FROM app.messages WHERE thread_root_id = $1 AND body LIKE '%added%'", [rootId])).rows[0]!.author_id);
    expect(author).toBe(rafi.actorId);
  });

  it('joins the room as a hidden listener that can only subscribe, and never publishes', async () => {
    const listener = await eventually(async () => listenerOf(id), 20_000, 'the listener to join');
    const token = lastFakeMedia().tokens.filter((t) => t.room === id && t.kind === 'bot');
    expect(token).toHaveLength(1);
    expect(token[0]).toMatchObject({ identity: `notetaker:${id}`, grants: { canPublish: false, canSubscribe: true, listenOnly: true } });
    expect(token[0]!.identity).not.toMatch(/^[0-9a-f]{8}-/); // never an actor id: the webhook drops unknown UUIDs
    expect(listener.subscriptions()).toEqual([]); // nobody has said yes yet
    expect(lastFakeMedia().published()).toEqual([]);
    expect(ListMeetingNotetakersResponse.parse((await list(nadia, id)).body).current).toMatchObject({ listening: true });
  });

  it('has one at a time: another bot is refused, the same bot again changes nothing', async () => {
    const other = await add(nadia, id, bots['second']!);
    expect(other.status).toBe(409);
    expect(JSON.stringify(other.body)).toContain('already has a note-taker');
    const before = (await events('meetings.notetaker.added')).filter((p) => p['meetingId'] === id).length;
    const again = await add(priya, id, bots['note-taker']!);
    expect(again.status).toBe(200);
    expect((await events('meetings.notetaker.added')).filter((p) => p['meetingId'] === id).length).toBe(before);
    expect(lastFakeMedia().tokens.filter((t) => t.room === id && t.kind === 'bot')).toHaveLength(1);
  });

  it('is removed only by the organizer, the person who added it or a lead, and nobody else in the room', async () => {
    expect((await remove(priya, id)).status).toBe(403);
    expect(ListMeetingNotetakersResponse.parse((await list(nadia, id)).body).current).not.toBeNull();
    const res = await remove(nadia, id); // the organizer
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(RemoveMeetingNotetakerResponse.parse(res.body)).toEqual({ removed: true });
    const gone = (await events('meetings.notetaker.removed')).filter((p) => p['meetingId'] === id);
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ botId: bots['note-taker'], removedBy: nadia.actorId });
    expect(RemoveMeetingNotetakerResponse.parse((await remove(nadia, id)).body)).toEqual({ removed: false });
    expect(ListMeetingNotetakersResponse.parse((await list(nadia, id)).body).current).toBeNull();
  });

  it('leaves the room within seconds of being removed, and says so in the thread', async () => {
    await eventually(async () => (listenerOf(id) === undefined ? true : undefined), 10_000, 'the listener to leave');
    await eventually(async () => ((await thread(rootId)).some((b) => b === 'Nadia removed Note-taker.') ? true : undefined), 20_000, 'the removal notice');
    expect(lastFakeMedia().published()).toEqual([]);
  });

  it('can be added again after it was removed, and a lead may remove it without being in the room', async () => {
    expect((await add(priya, id, bots['second']!)).status).toBe(200);
    await eventually(async () => listenerOf(id), 20_000, 'the second listener');
    expect((await remove(omar, id)).status).toBe(200);
    await eventually(async () => (listenerOf(id) === undefined ? true : undefined), 10_000, 'the second listener to leave');
  });

  it('leaves with the room when it ends, and says it left (removedBy null)', async () => {
    expect((await add(rafi, id, bots['note-taker']!)).status).toBe(200);
    await eventually(async () => listenerOf(id), 20_000, 'the listener');
    expect((await end(nadia, id)).status).toBe(200);
    await eventually(async () => (listenerOf(id) === undefined ? true : undefined), 10_000, 'the listener to leave with the room');
    const left = await eventually(async () => {
      const e = (await events('meetings.notetaker.removed')).filter((p) => p['meetingId'] === id && p['removedBy'] === null);
      return e.length > 0 ? e : undefined;
    }, 20_000, 'the notice that it left');
    expect(left).toHaveLength(1);
    expect((await add(rafi, id, bots['note-taker']!)).status).toBe(409); // the room has ended
  });
});

describe('the switches that can forbid a note-taker', () => {
  it('a workspace admin can switch note-takers off for the workspace: 403 with the reason, and the list says why', async () => {
    const { id } = await room(nadia, 'releases');
    expect((await settings({ notetakerAllowed: false })).status).toBe(200);
    const body = ListMeetingNotetakersResponse.parse((await list(nadia, id)).body);
    expect(body).toMatchObject({ canAdd: false, reason: 'Note-takers are switched off for this workspace. A workspace admin can allow them.' });
    const res = await add(nadia, id, bots['note-taker']!);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('switched off for this workspace');
    expect((await settings({ notetakerAllowed: true })).status).toBe(200);
    expect(ListMeetingNotetakersResponse.parse((await list(nadia, id)).body).canAdd).toBe(true);
    await end(nadia, id);
  });

  it('the team’s TEAM.md can switch them off for the team (and a typo reads as off)', async () => {
    const { id } = await room(nadia, 'releases');
    const write = (content: string) => w.call(omar, 'POST', '/api/teams/engineering/proposals', { path: 'TEAM.md', content, applyNow: true });
    expect((await write('---\nmeetings:\n  noteTaker: off\n---\n# Team\n')).status).toBe(201);
    const off = await add(nadia, id, bots['note-taker']!);
    expect(off.status).toBe(403);
    expect(JSON.stringify(off.body)).toContain('switched off for this team');
    expect((await write('---\nmeetings:\n  noteTaker: nope\n---\n# Team\n')).status).toBe(201);
    expect((await add(nadia, id, bots['note-taker']!)).status).toBe(403);
    expect((await write('---\nmeetings:\n  noteTaker: on\n---\n# Team\n')).status).toBe(201);
    expect(ListMeetingNotetakersResponse.parse((await list(nadia, id)).body).canAdd).toBe(true);
    await end(nadia, id);
  });

  it('switching transcription off for the workspace forbids it too', async () => {
    const { id } = await room(nadia, 'releases');
    expect((await settings({ transcribeCap: 'off' })).status).toBe(200);
    const res = await add(nadia, id, bots['note-taker']!);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('Transcription is switched off for this workspace');
    expect((await settings({ transcribeCap: 'on_device' })).status).toBe(200);
    await end(nadia, id);
  });

  it('answers 409 with a plain reason when there is no media server, and nothing is written', async () => {
    const { id } = await room(nadia, 'releases');
    lastFakeMedia().setConfigured(false);
    try {
      const body = ListMeetingNotetakersResponse.parse((await list(nadia, id)).body);
      expect(body.canAdd).toBe(false);
      expect(body.reason).toContain('fake media server');
      expect((await add(nadia, id, bots['note-taker']!)).status).toBe(409);
    } finally {
      lastFakeMedia().setConfigured(true);
    }
    const row = await w.system(async (tx) => (await tx.query<{ notetaker_bot_id: string | null; transcription: string }>('SELECT notetaker_bot_id, transcription FROM app.meetings WHERE id = $1', [id])).rows[0]!);
    expect(row).toEqual({ notetaker_bot_id: null, transcription: 'off' });
    await end(nadia, id);
  });

  it('answers 409 "busy" when this server already listens to as many rooms as it may', async () => {
    process.env['MANYTHREADS_NOTETAKER_MAX_ROOMS'] = '1';
    const first = await room(nadia, 'general');
    const second = await room(rafi, 'releases');
    try {
      expect((await add(nadia, first.id, bots['note-taker']!)).status).toBe(200);
      const res = await add(rafi, second.id, bots['second']!);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('The note-taker is busy, try again in a minute.');
      expect(ListMeetingNotetakersResponse.parse((await list(rafi, second.id)).body).reason).toBe('The note-taker is busy, try again in a minute.');
      const row = await w.system(async (tx) => (await tx.query<{ notetaker_bot_id: string | null }>('SELECT notetaker_bot_id FROM app.meetings WHERE id = $1', [second.id])).rows[0]!);
      expect(row.notetaker_bot_id).toBeNull();
      // when the first one leaves there is room again
      expect((await remove(nadia, first.id)).status).toBe(200);
      expect((await add(rafi, second.id, bots['second']!)).status).toBe(200);
    } finally {
      restore('MANYTHREADS_NOTETAKER_MAX_ROOMS', saved.max);
      await end(nadia, first.id);
      await end(rafi, second.id);
    }
  });
});
