import { enqueue } from '@manythreads/kernel';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { askText, digestText, pulseOf, standupDecision } from '../src/standups.ts';
import { createWorld, ensureChannels, eventually, personas, type World } from './world.ts';

// P35-09 / P18-04 through the real server: a lead turns a stand-up on in #standup (a member cannot); the job asks each member of Engineering in their own
// conversation with the bot, skipping one who is out of office and one on Do not disturb; Nadia's next message there is her answer (with a pulse); the
// digest goes to the channel with her answer, who was away and who did not answer, and the pulse as counts; a late answer goes under the digest.

const { omar, nadia, rafi } = personas;
vi.setConfig({ testTimeout: 120_000 });

let w: World;
let channel = '';
let botActor = '';

const ALL_DAY = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' };
const runJob = async (): Promise<void> => {
  const id = await w.system(async (tx) => (await enqueue(tx, 'channels.standup', {})).id);
  await eventually(
    async () => {
      const row = (await w.system(async (tx) => (await tx.query<{ state: string; last_error: string | null }>('SELECT state, last_error FROM app.jobs WHERE id = $1', [id])).rows[0]))!;
      expect(row.last_error).toBeNull();
      return row.state === 'done' ? true : undefined;
    },
    30_000,
    'the stand-up job',
  );
};
const asks = async () =>
  (
    await w.system((tx) =>
      tx.query<{ person_id: string; skipped: string | null; conversation_id: string | null; question_message_id: string | null; answer: string | null; pulse: number | null; digest_message_id: string | null }>(
        'SELECT person_id, skipped, conversation_id, question_message_id, answer, pulse, digest_message_id FROM app.standup_asks ORDER BY asked_at',
      ),
    )
  ).rows;

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  channel = await w.channelId('engineering', 'standup').catch(() => w.channelId('engineering', 'general'));
  botActor = await w.system(async (tx) => {
    const bot = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
         VALUES ($1, $2, 'standup-collector', 'Stand-up collector', '', 'automation', 'rules', 'team', repeat('a', 64), 'active', '[{"type":"conversation"}]'::jsonb, ARRAY['fast']) RETURNING id`,
        [nadia.workspaceId, TEAM_IDS.Engineering],
      )
    ).rows[0]!.id;
    const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [nadia.workspaceId, bot])).rows[0]!.id;
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, actor, nadia.workspaceId]);
    // everyone on the team works all day in UTC (the job runs on the real clock); Omar is out of office, Rafi is on Do not disturb
    const people = (await tx.query<{ person_id: string }>(`SELECT a.ref_id AS person_id FROM app.team_members tm JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' WHERE tm.team_id = $1`, [TEAM_IDS.Engineering])).rows;
    for (const p of people) {
      await tx.query(
        `INSERT INTO app.person_status (person_id, workspace_id, time_zone, working_hours, ooo_active) VALUES ($1, $2, 'UTC', $3::jsonb, $4)
         ON CONFLICT (person_id) DO UPDATE SET time_zone = 'UTC', working_hours = EXCLUDED.working_hours, ooo_active = EXCLUDED.ooo_active`,
        [p.person_id, nadia.workspaceId, JSON.stringify(ALL_DAY), p.person_id === omar.personId],
      );
    }
    await tx.query(`INSERT INTO app.dnd_settings (person_id, workspace_id, enabled) VALUES ($1, $2, true) ON CONFLICT (person_id) DO UPDATE SET enabled = true`, [rafi.personId, nadia.workspaceId]);
    return actor;
  });
}, 180_000);

afterAll(async () => {
  await w?.close();
});

describe('stand-up rules', () => {
  it('asks from the start of the working day to its end, on the stand-up days, and skips out of office before Do not disturb', () => {
    const wed10 = new Date('2026-11-25T10:00:00Z');
    const base = { now: wed10, zone: 'UTC', hours: null, days: [1, 2, 3, 4, 5], dnd: null, ooo: null };
    expect(standupDecision(base)).toEqual({ ask: true, localDate: '2026-11-25', skipped: null });
    expect(standupDecision({ ...base, now: new Date('2026-11-25T08:00:00Z') })).toEqual({ ask: false });
    expect(standupDecision({ ...base, now: new Date('2026-11-25T19:00:00Z') })).toEqual({ ask: false });
    expect(standupDecision({ ...base, days: [1] })).toEqual({ ask: false });
    // 10:00 UTC is 05:00 in New York: not yet
    expect(standupDecision({ ...base, zone: 'America/New_York' })).toEqual({ ask: false });
    expect(standupDecision({ ...base, ooo: { active: true, returnsOn: null, delegatePersonId: null, message: '' }, dnd: { enabled: true, pausedUntil: null, schedule: { enabled: false, windows: [] } } })).toMatchObject({ skipped: 'out_of_office' });
    expect(standupDecision({ ...base, dnd: { enabled: true, pausedUntil: null, schedule: { enabled: false, windows: [] } } })).toMatchObject({ skipped: 'do_not_disturb' });
  });

  it('reads a pulse at the end of an answer, and the digest shows the pulse only as counts', () => {
    expect(pulseOf('Shipped the fix. Blocked on staging. 4')).toBe(4);
    expect(pulseOf('mood: 2/5')).toBe(2);
    expect(pulseOf('Version 3 is out, working on 6')).toBeNull();
    expect(askText(['A?', 'B?'], true, 'standup')).toContain('3. Last, a number from 1 (rough) to 5 (great)');
    const d = digestText({ dateText: 'Wed 25 Nov', answers: [{ name: 'Nadia', answer: 'Done\nBlocked' }], away: [{ name: 'Omar', why: 'out_of_office' }], missing: ['Priya'], pulses: [4, 2] });
    expect(d).toContain('> Blocked');
    expect(d).toContain('Away: Omar (out of office)');
    expect(d).toContain('No answer: Priya');
    expect(d).toContain('Pulse (anonymous): 2 answers, average 3.0 (4: 1 · 2: 1)');
    expect(d).not.toMatch(/Nadia.*4/);
  });
});

describe('stand-ups (P35-09, P18-04)', () => {
  it('a member cannot turn one on; a lead can', async () => {
    const body = { enabled: true, botSlug: 'standup-collector', questions: ['What did you finish?', 'What is next?', 'Anything blocking you?'], pulse: true, days: [1, 2, 3, 4, 5, 6, 7], digestAt: '23:59' };
    expect((await w.call(nadia, 'PUT', `/api/channels/${channel}/standup`, body)).status).toBe(403);
    expect((await w.call(omar, 'PUT', `/api/channels/${channel}/standup`, { ...body, botSlug: 'nobody' })).status).toBe(400);
    const saved = await w.call<{ standup: { enabled: boolean; digestAt: string } }>(omar, 'PUT', `/api/channels/${channel}/standup`, body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const read = await w.call<{ standup: { botSlug: string; pulse: boolean; days: number[] }; canManage: boolean }>(nadia, 'GET', `/api/channels/${channel}/standup`);
    expect(read.body).toMatchObject({ standup: { botSlug: 'standup-collector', pulse: true, days: [1, 2, 3, 4, 5, 6, 7] }, canManage: false });
  });

  it('asks each member once in their conversation with the bot, and skips the one out of office and the one on Do not disturb', async () => {
    await runJob();
    const rows = await asks();
    const of = (id: string) => rows.find((r) => r.person_id === id);
    expect(of(omar.personId)).toMatchObject({ skipped: 'out_of_office', question_message_id: null });
    expect(of(rafi.personId)).toMatchObject({ skipped: 'do_not_disturb', question_message_id: null });
    const mine = of(nadia.personId)!;
    expect(mine).toMatchObject({ skipped: null });
    expect(mine.question_message_id).not.toBeNull();
    const q = (await w.system((tx) => tx.query<{ body: string; author_id: string; kind: string }>('SELECT m.body, m.author_id, c.kind FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE m.id = $1', [mine.question_message_id]))).rows[0]!;
    expect(q).toMatchObject({ author_id: botActor, kind: 'bot_conversation' });
    expect(q.body).toContain('Anything blocking you?');
    // a second pass asks nobody again
    await runJob();
    expect((await asks()).length).toBe(rows.length);
  });

  it('her next message there is the answer, with its pulse; the digest goes to the channel with what each said, who was away and the pulse as counts', async () => {
    const mine = (await asks()).find((r) => r.person_id === nadia.personId)!;
    const posted = await w.call(nadia, 'POST', `/api/channels/${mine.conversation_id}/messages`, { channelId: mine.conversation_id, body: 'Finished the export.\nNext: the import.\nBlocked on the staging database. 4', threadRootId: null });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    await eventually(async () => ((await asks()).find((r) => r.person_id === nadia.personId)!.answer ? true : undefined), 20_000, 'the answer');
    expect((await asks()).find((r) => r.person_id === nadia.personId)).toMatchObject({ pulse: 4 });
    // the digest is due when every member was asked and answered or skipped; the others in the team did not answer, so make it due by its time
    await w.system((tx) => tx.query(`UPDATE app.standups SET digest_minute = 0, last_digest_on = NULL`));
    await runJob();
    const digest = (
      await w.system((tx) => tx.query<{ id: string; body: string; author_id: string }>(`SELECT id, body, author_id FROM app.messages WHERE channel_id = $1 AND meta ? 'standupDigest' ORDER BY created_at DESC LIMIT 1`, [channel]))
    ).rows[0]!;
    expect(digest.author_id).toBe(botActor);
    expect(digest.body).toContain('> Blocked on the staging database. 4');
    expect(digest.body).toMatch(/Away: .*out of office/);
    expect(digest.body).toMatch(/do not disturb/);
    expect(digest.body).toContain('Pulse (anonymous): 1 answer, average 4.0');
    expect((await asks()).every((r) => r.digest_message_id === digest.id)).toBe(true);
    const event = (await w.system((tx) => tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'channel.standup.digested' ORDER BY id DESC LIMIT 1`))).rows[0]!.payload;
    expect(event).toMatchObject({ channelId: channel, digestMessageId: digest.id, answered: 1 });
  });
});
