import { emit, type Tx } from '@manythreads/kernel';
import type { FullReplayEstimate, Reassessment, ReplayResult, WorkshopSession } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeLlm, type FakeLlm } from '../../../../tools/fake-llm/src/server.ts';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// P7-07 (server): the replay of a bot's recorded guard and gate decisions, the full replay behind a confirmation, and the "check this again" notices, through the real server and
// a real database. The model stand-in counts every call, so the free replay can prove it made none.

const { omar, nadia, sameera, lena } = personas;
vi.setConfig({ testTimeout: 120_000 });

let w: RepoWorld;
let fake: FakeLlm;
const saved = { url: process.env['MANYTHREADS_LITELLM_URL'], key: process.env['MANYTHREADS_LITELLM_MASTER_KEY'] };

const BOT_MD = `---
schema: 1
name: Replayed
role: Answers questions about the release checklist.
kind: agent
runtime: hermes
model:
  aliases: [smart]
triggers:
  - type: mention
capabilities:
  native: [messages.post]
guard:
  gate: ['credential rotation']
---

REPLAYED-BODY: you answer questions about the release checklist.
`;

const MSG = {
  rotate: 'Please do the credential rotation today.',
  lunch: 'What is for lunch on Friday?',
  rotate2: 'Start the credential rotation for the staging keys.',
  hello: 'Hello there, bot.',
  lunch2: 'Where is the lunch menu for next week?',
  mine: 'I want the credential rotation done before noon.',
  support: 'A customer asks about their invoice.',
};
type MsgKey = keyof typeof MSG;
const msg: Record<MsgKey, string> = {} as Record<MsgKey, string>;
const run: Record<'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'rehearsal', string> = {} as never;
let botId = '';
let devChannel = '';
let calls = 0;
/** While set, the replayed bot's first answer to a rehearsal is a try to post a message (which a rehearsal must hold), and its second is text. */
let tryAWrite: string | null = null;
const base = '/api/teams/engineering/bots/replayed';
/** The two replay routes are rate limited per person (30 and 10 a minute). A test that asks more often waits out the window instead of failing, so the limit itself stays as it is. */
const patiently = async <T extends { status: number }>(ask: () => Promise<T>): Promise<T> => {
  for (let tries = 0; tries < 80; tries += 1) {
    const res = await ask();
    if (res.status !== 429) return res;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return ask();
};
const replay = (who: typeof omar, days = 30) => patiently(() => w.call<{ replay: ReplayResult; error?: { message: string } }>(who, 'GET', `${base}/replay?days=${String(days)}`));
const full = (who: typeof omar, runId: string, body: unknown = {}) =>
  patiently(() => w.call<{ status: string; estimate: FullReplayEstimate; session: WorkshopSession; error?: { message: string } }>(who, 'POST', `${base}/replay/runs/${runId}/full`, body));
const notices = (who: typeof omar) => w.call<{ reassessments: Reassessment[] }>(who, 'GET', `${base}/reassessments`);
const decisionLine = (tx: Tx, runId: string, seq: number, kind: string, subject: string, outcome: string, opts: { messageId?: string; detail?: unknown; target?: string } = {}) =>
  tx.query(`INSERT INTO app.run_decisions (run_id, seq, kind, subject, outcome, target, message_id, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`, [
    runId,
    seq,
    kind,
    subject,
    outcome,
    opts.target ?? null,
    opts.messageId ?? null,
    JSON.stringify(opts.detail ?? {}),
  ]);
const counts = () =>
  w.system(async (tx) => {
    const one = async (sql: string): Promise<number> => Number((await tx.query<{ n: string }>(sql)).rows[0]!.n);
    return {
      messages: await one('SELECT count(*) AS n FROM app.messages'),
      runs: await one('SELECT count(*) AS n FROM app.bot_runs'),
      decisions: await one('SELECT count(*) AS n FROM app.run_decisions'),
      sessions: await one('SELECT count(*) AS n FROM app.workshop_sessions'),
      notices: await one('SELECT count(*) AS n FROM app.bot_reassessments'),
      spend: await one('SELECT count(*) AS n FROM app.llm_spend'),
      events: await one("SELECT count(*) AS n FROM app.events WHERE type LIKE 'workshop.%' OR type LIKE 'capability.%' OR type LIKE 'runtime.%' OR type LIKE 'approval.%'"),
      proposals: await one('SELECT count(*) AS n FROM app.proposals'),
    };
  });
const iso = (): string => new Date().toISOString();
let counter = 0xa000;
const id7 = (): string => `00000000-0000-7000-8000-${(counter++).toString(16).padStart(12, '0')}`;

beforeAll(async () => {
  fake = await startFakeLlm({
    masterKey: 'sk-fake',
    completion: ({ messages }) => {
      calls += 1;
      if (tryAWrite && (messages[0]?.content ?? '').includes('REPLAYED-BODY') && !messages.some((m) => m.role === 'tool')) {
        return {
          status: 200,
          body: {
            id: 'chatcmpl-replay-write',
            model: 'smart',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'call_replay_1', type: 'function', function: { name: 'messages_post', arguments: JSON.stringify({ channelId: tryAWrite, body: 'HELD-BY-REPLAY' }) } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
          },
        };
      }
      return 'Here is the reply of the replayed bot.';
    },
  });
  process.env['MANYTHREADS_LITELLM_URL'] = fake.url;
  process.env['MANYTHREADS_LITELLM_MASTER_KEY'] = 'sk-fake';
  w = await createRepoWorld();
  const created = await w.call<{ provider: { id: string } }>(omar, 'POST', '/api/workspace/llm/providers', { name: 'OpenAI', kind: 'openai', apiKey: 'sk-provider-secret-8888' });
  const bound = await w.call(omar, 'PUT', '/api/workspace/llm/aliases/smart', { providerId: created.body.provider.id, model: 'gpt-4o', fallbacks: [] });
  expect(bound.status).toBe(200);
  await w.system(async (tx) => {
    await tx.query(`UPDATE app.llm_aliases SET updated_at = updated_at - interval '1 minute'`);
    await tx.query(`UPDATE app.llm_providers SET updated_at = updated_at - interval '1 minute'`);
  });
  const made = await w.commit(omar, 'engineering', [{ op: 'put', path: 'bots/replayed/BOT.md', content: BOT_MD }], 'A bot for the replay tests');
  expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
  await vi.waitFor(async () => expect((await w.call(omar, 'GET', base)).status).toBe(200), { timeout: 30_000, interval: 250 });

  // the template channels exist once the directories are asked for
  await w.call(omar, 'GET', '/api/teams/engineering/channels');
  await w.call(sameera, 'GET', '/api/teams/customer-support/channels');
  const channel = async (team: string, name: string): Promise<string> =>
    (await w.system((tx) => tx.query<{ id: string }>('SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = $1 AND c.name = $2', [team, name]))).rows[0]!.id;
  const dev = await channel('engineering', 'dev');
  devChannel = dev;
  const support = await channel('customer-support', 'support');
  const post = async (who: typeof omar, channelId: string, body: string): Promise<string> => {
    const res = await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null, attachments: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id;
  };
  msg.rotate = await post(nadia, dev, MSG.rotate);
  msg.lunch = await post(nadia, dev, MSG.lunch);
  msg.rotate2 = await post(nadia, dev, MSG.rotate2);
  msg.hello = await post(nadia, dev, MSG.hello);
  msg.lunch2 = await post(nadia, dev, MSG.lunch2);
  msg.mine = await post(omar, dev, MSG.mine);
  msg.support = await post(sameera, support, MSG.support);

  await w.system(async (tx) => {
    botId = (await tx.query<{ id: string }>("SELECT id FROM app.bots WHERE slug = 'replayed'")).rows[0]!.id;
    const team = '00000000-0000-7000-8000-0000000b0001';
    const open = async (trigger: string, asker: string, rehearsal = false): Promise<string> =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, rehearsal) VALUES ($1, $2, $3, $4, $5, 'done', $6) RETURNING id`,
          [omar.workspaceId, botId, team, trigger, asker, rehearsal],
        )
      ).rows[0]!.id;
    run.r1 = await open('conversation', nadia.actorId);
    run.r2 = await open('mention', nadia.actorId);
    run.r3 = await open('conversation', omar.actorId);
    run.r4 = await open('mention', nadia.actorId);
    run.r5 = await open('conversation', omar.actorId);
    run.rehearsal = await open('conversation', omar.actorId, true);
    // r1: Nadia's private conversation (only she reads it). The topic list of today holds the first message and no longer the second; the guard and the tool door are as they were.
    await decisionLine(tx, run.r1, 0, 'gate', 'gate', 'passed', { messageId: msg.rotate });
    await decisionLine(tx, run.r1, 1, 'gate', 'gate', 'held', { messageId: msg.lunch, detail: { stage: 'list' } });
    await decisionLine(tx, run.r1, 2, 'guard', 'smart', 'redact', { detail: { reason: 'dlp', preset: 'standard' } });
    await decisionLine(tx, run.r1, 3, 'tool', 'messages.post', 'allowed', { target: 'dev', detail: { reason: 'granted', tool: 'messages.post' } });
    // r2: a mention. The held message is still held; the local model held another (not replayed); a dangerous tool was allowed and is not granted today.
    await decisionLine(tx, run.r2, 0, 'gate', 'gate', 'held', { messageId: msg.rotate2, detail: { stage: 'list' } });
    await decisionLine(tx, run.r2, 1, 'gate', 'gate', 'passed', { messageId: msg.hello });
    await decisionLine(tx, run.r2, 2, 'gate', 'gate', 'held', { messageId: msg.lunch2, detail: { stage: 'classifier' } });
    await decisionLine(tx, run.r2, 3, 'tool', 'email.send', 'needs_approval', { detail: { reason: 'destructive', tool: 'email.send' } });
    // r3: Omar's own conversation (Nadia never sees it): a message the list now holds, and a tool call that was refused and is granted today.
    await decisionLine(tx, run.r3, 0, 'gate', 'gate', 'passed', { messageId: msg.mine });
    await decisionLine(tx, run.r3, 1, 'tool', 'messages.post', 'denied', { detail: { reason: 'not granted', tool: 'messages.post' } });
    // r4: the gate read a message of a channel Nadia cannot read.
    await decisionLine(tx, run.r4, 0, 'gate', 'gate', 'passed', { messageId: msg.support });
    // the original cost of r2, as the spend ledger kept it
    for (const [p, c, cost] of [[100, 20, 0.004], [50, 10, 0.002]] as const) {
      await tx.query(
        `INSERT INTO app.llm_spend (workspace_id, team_id, bot_id, run_id, alias, prompt_tokens, completion_tokens, cost_usd) VALUES ($1, $2, $3, $4, 'smart', $5, $6, $7)`,
        [omar.workspaceId, team, botId, run.r2, p, c, cost],
      );
    }
  });
}, 300_000);

afterAll(async () => {
  await w?.close();
  await fake?.close();
  for (const [name, value] of [
    ['MANYTHREADS_LITELLM_URL', saved.url],
    ['MANYTHREADS_LITELLM_MASTER_KEY', saved.key],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('the free replay', () => {
  it('shows a lead every run and says which decisions would come out differently, in plain words', async () => {
    const res = await replay(omar);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = res.body.replay;
    expect(r.model).toBe('none');
    // Nadia's private conversation (r1) is hers alone: a lead does not read it, so it is not replayed for the lead
    expect(r.runs).toBe(4);
    expect(r.counts.total).toBe(7);
    expect(r.counts.tighter).toBe(2);
    expect(r.counts.looser).toBe(1);
    expect(r.counts.same + r.counts.notReplayed).toBe(4);
    expect(r.byKind.gate.total).toBe(5);
    expect(r.byKind.guard.total).toBe(0);
    expect(r.byKind.tool.total).toBe(2);
    const verdictOf = (what: string, recorded: string) => r.changes.filter((c) => c.what.includes(what) && c.recorded === recorded).map((c) => c.verdict);
    expect(verdictOf('topic list', 'allowed')).toEqual(['tighter']);
    expect(verdictOf('topic list', 'waits_for_person')).toEqual(['not_replayed']);
    expect(r.changes.every((c) => c.explanation.length > 20 && c.verdict !== 'same')).toBe(true);
    expect(r.changes.some((c) => c.kind === 'tool' && c.verdict === 'tighter' && c.now === 'refused')).toBe(true);
    expect(r.changes.some((c) => c.kind === 'tool' && c.verdict === 'looser' && c.now === 'allowed')).toBe(true);
    expect(r.notes.length).toBeGreaterThanOrEqual(3);
    // a lead may ask the bot again for a run that kept its message
    expect(r.fullReplayable.map((x) => x.runId)).toEqual(expect.arrayContaining([run.r2, run.r3, run.r4]));
    expect(r.fullReplayable.map((x) => x.runId)).not.toContain(run.r1);
    expect(r.fullReplayable.map((x) => x.runId)).not.toContain(run.r5);
  });

  it('shows anyone else only the runs they started, and offers no full replay', async () => {
    const r = (await replay(nadia)).body.replay;
    expect(r.runs).toBe(3);
    expect(r.counts.total).toBe(9);
    expect(r.counts.tighter).toBe(2);
    expect(r.counts.looser).toBe(1);
    expect(r.changes.some((c) => c.verdict === 'looser' && c.kind === 'gate')).toBe(true);
    expect(r.fullReplayable).toEqual([]);
    // the message of a channel she cannot read is not replayed, and not read
    expect(r.counts.notReplayed).toBe(2);
    const theirs = (await replay(nadia)).body.replay.changes.map((c) => c.runId);
    expect(theirs).not.toContain(run.r3);
  });

  it('is closed to people with no access and refuses a window outside 1 to 30 days', async () => {
    expect([403, 404]).toContain((await replay(lena)).status);
    expect([403, 404]).toContain((await replay(sameera)).status);
    expect((await replay(omar, 0)).status).toBe(400);
    expect((await replay(omar, 9999)).status).toBe(400);
  });

  it('never calls a model, acts, or writes anything (HOSTILE)', async () => {
    const before = await counts();
    const callsBefore = calls;
    const modelCallsBefore = fake.state.calls.length;
    for (const who of [omar, nadia, omar]) expect((await replay(who)).status).toBe(200);
    expect(await counts()).toEqual(before);
    expect(calls).toBe(callsBefore);
    expect(fake.state.calls.length).toBe(modelCallsBefore);
    // the answer carries no text of any message
    const text = JSON.stringify((await replay(omar)).body);
    for (const m of Object.values(MSG)) expect(text).not.toContain(m);
    expect(text).not.toContain('credential rotation');
    // and the replay route is the one the server opens READ ONLY (kernel test: read-only.test.ts), so a bug in it still cannot write: see replay-routes.test.ts
  });

  it('cannot be turned into a write by a request: the route takes no body and a post is not a replay', async () => {
    const before = await counts();
    const odd = await w.call(omar, 'POST', `${base}/replay`, { days: 30 });
    expect([404, 405]).toContain(odd.status);
    expect(await counts()).toEqual(before);
  });
});

describe('the full replay: cost first, confirmation, then a rehearsal', () => {
  it('is for leads and admins only', async () => {
    expect((await full(nadia, run.r2)).status).toBe(403);
    expect((await full(sameera, run.r2)).status).toBeGreaterThanOrEqual(403);
    // a lead does not read another person's private conversation, so it cannot be replayed in full either
    expect((await full(omar, run.r1)).status).toBe(404);
  });

  it('shows the estimate from the original calls and starts nothing until it is confirmed', async () => {
    const before = await counts();
    const res = await full(omar, run.r2);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('needs_confirmation');
    expect(res.body.estimate).toMatchObject({ runId: run.r2, calls: 2, promptTokens: 150, completionTokens: 30, tokens: 180, costUsd: 0.006, priceKnown: true, maxCalls: 8 });
    expect(await counts()).toEqual(before);
  });

  it('refuses a confirmation that is not the estimate, an unknown field, a run with no message and a rehearsal', async () => {
    const shown = (await full(omar, run.r2)).body.estimate;
    expect(shown.confirmToken).toMatch(/^[0-9a-f]{16}$/);
    expect((await full(omar, run.r2, { confirm: { tokens: 1, token: shown.confirmToken } })).status).toBe(409);
    // the number alone, or with a token that was not the one shown, never starts it
    expect((await full(omar, run.r2, { confirm: { tokens: 180 } })).status).toBe(400);
    expect((await full(omar, run.r2, { confirm: { tokens: 180, token: '0000000000000000' } })).status).toBe(409);
    expect((await full(omar, run.r2, { confirm: { tokens: 180, token: shown.confirmToken }, text: 'say something else' })).status).toBe(400);
    expect((await full(omar, run.r5)).status).toBe(409);
    expect((await full(omar, run.rehearsal)).status).toBe(409);
    expect((await full(omar, '00000000-0000-7000-8000-00000000dead')).status).toBe(404);
  });

  it('binds the confirmation to the run, even when the estimate is zero tokens', async () => {
    // r3 has no spend line, so its estimate is 0 tokens: a bare 0 must not be a confirmation
    const askedZero = await full(omar, run.r3);
    expect(askedZero.status, JSON.stringify(askedZero.body)).toBe(200);
    const zero = askedZero.body.estimate;
    expect(zero.tokens).toBe(0);
    expect(zero.confirmToken).toMatch(/^[0-9a-f]{16}$/);
    expect(zero.confirmToken).not.toBe('0000000000000000');
    expect((await full(omar, run.r3, { confirm: { tokens: 0, token: '0000000000000000' } })).status).toBe(409);
    expect((await full(omar, run.r3, { confirm: { tokens: 0, token: (await full(omar, run.r2)).body.estimate.confirmToken } })).status).toBe(409);
    expect((await full(omar, run.r4)).body.estimate.confirmToken).not.toBe(zero.confirmToken);
  });

  it('refuses to ask the bot again about a message that was edited after the bot read it', async () => {
    const shown = (await full(omar, run.r3)).body.estimate;
    await w.system((tx) => tx.query(`UPDATE app.messages SET edited_at = now() + interval '1 minute' WHERE id = $1`, [msg.mine]));
    try {
      const before = await counts();
      const res = await full(omar, run.r3, { confirm: { tokens: shown.tokens, token: shown.confirmToken } });
      expect(res.status).toBe(409);
      expect(res.body.error?.message).toMatch(/edited/);
      expect((await counts()).sessions).toBe(before.sessions);
    } finally {
      await w.system((tx) => tx.query(`UPDATE app.messages SET edited_at = NULL WHERE id = $1`, [msg.mine]));
    }
  });

  it('starts a rehearsal of the stored message once confirmed, and says so with an event that carries no text', async () => {
    const before = await counts();
    const shown = (await full(omar, run.r2)).body.estimate;
    tryAWrite = devChannel;
    const res = await full(omar, run.r2, { confirm: { tokens: 180, token: shown.confirmToken } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('started');
    expect(res.body.session.mode).toBe('rehearse');
    expect(res.body.session.entries[0]).toMatchObject({ kind: 'person', text: MSG.rotate2 });
    expect((await counts()).sessions).toBe(before.sessions + 1);
    const events = await w.system((tx) => tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'workshop.replay.started'"));
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload).toMatchObject({ runId: run.r2, tokens: 180, slug: 'replayed' });
    expect(JSON.stringify(events.rows[0]!.payload)).not.toContain(MSG.rotate2);
    // the rehearsal runs the model once the person asked for it, and holds every write
    await vi.waitFor(
      async () => {
        const s = (await w.call<{ session: WorkshopSession }>(omar, 'GET', `${base}/workshop/sessions/${res.body.session.id}`)).body.session;
        expect(['ready', 'failed']).toContain(s.status);
        expect(s.status).toBe('ready');
      },
      { timeout: 60_000, interval: 250 },
    );
    expect(calls).toBeGreaterThan(0);
    tryAWrite = null;
    // the bot did try to post, the rehearsal held it: no message was written, nothing waits as a proposal, and the held step is kept on the rehearsal's own run
    const after = await counts();
    expect(after.messages).toBe(before.messages);
    expect(after.proposals).toBe(before.proposals);
    const written = await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.messages WHERE body = 'HELD-BY-REPLAY'`));
    expect(written.rows[0]!.n).toBe('0');
    const held = await w.system((tx) =>
      tx.query<{ capability: string }>(`SELECT capability FROM app.rehearsal_intercepts WHERE run_id IN (SELECT id FROM app.bot_runs WHERE rehearsal AND bot_id = $1)`, [botId]),
    );
    expect(held.rows.length).toBeGreaterThan(0);
    // the money the rehearsal spent is labelled as a rehearsal of this session, and is the only spend it left
    const spend = await w.system((tx) => tx.query<{ purpose: string | null; bot_id: string | null }>(`SELECT purpose, bot_id FROM app.llm_spend WHERE session_id = $1`, [`rehearsal:${res.body.session.id}`]));
    expect(spend.rows.length).toBeGreaterThan(0);
    expect(spend.rows.every((r) => r.purpose === 'rehearsal' && r.bot_id === botId)).toBe(true);
    expect(after.spend).toBe(before.spend + spend.rows.length);
  });
});

describe('the limits of one replay', () => {
  const team = '00000000-0000-7000-8000-0000000b0001';
  const mine: string[] = [];
  const openRuns = async (n: number): Promise<string[]> => {
    const rows = await w.system((tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, rehearsal)
         SELECT $1, $2, $3, 'mention', $4, 'done', false FROM generate_series(1, $5::int) RETURNING id`,
        [omar.workspaceId, botId, team, omar.actorId, n],
      ),
    );
    const ids = rows.rows.map((r) => r.id);
    mine.push(...ids);
    return ids;
  };
  const cleanUp = () => w.system((tx) => tx.query(`DELETE FROM app.bot_runs WHERE id = ANY ($1::uuid[])`, [mine.splice(0)]));

  it('says so when it read only the newest 6000 decisions, and the numbers are those 6000', async () => {
    const quiet = (await replay(omar)).body.replay;
    expect(quiet.decisionsCapped).toBe(false);
    const ids = await openRuns(21);
    try {
      await w.system((tx) =>
        tx.query(
          `INSERT INTO app.run_decisions (run_id, seq, kind, subject, outcome, detail)
           SELECT r, s, 'guard', 'smart', 'allow', '{"reason":"dlp","preset":"standard"}'::jsonb FROM unnest($1::uuid[]) r, generate_series(0, 299) s`,
          [ids],
        ),
      );
      const res = await replay(omar);
      expect(res.status).toBe(200);
      const r = res.body.replay;
      expect(r.decisionsCapped).toBe(true);
      expect(r.counts.total).toBe(6000);
      expect(r.notes[0]).toMatch(/Only the newest 6000 decisions/);
    } finally {
      await cleanUp();
    }
    expect((await replay(omar)).body.replay.decisionsCapped).toBe(false);
  });

  it('asks the permission door about 80 different requests at most, lists the rest as not checked and says why', async () => {
    const before = (await replay(omar)).body.replay;
    const [id] = await openRuns(1);
    try {
      await w.system(async (tx) => {
        for (let i = 0; i < 90; i += 1) await decisionLine(tx, id!, i, 'tool', 'messages.post', 'allowed', { detail: { reason: 'granted', tool: 'messages.post', path: `pages/question-${String(i)}.md` } });
        // a call that named more places than were kept is never asked again
        await decisionLine(tx, id!, 90, 'tool', 'pages.write', 'allowed', { detail: { reason: 'granted', tool: 'pages.write', truncated: true } });
      });
      const r = (await replay(omar)).body.replay;
      expect(r.decisionsCapped).toBe(true);
      expect(r.notes[0]).toMatch(/at most 80 different requests/);
      expect(r.counts.total).toBe(before.counts.total + 91);
      // 80 questions are asked; every other distinct request (the 10 more of these and the older ones of other runs) is listed as not checked, and so is the one recorded in part
      const tooMany = before.byKind.tool.total + 90 - 80;
      expect(r.counts.notReplayed - before.counts.notReplayed).toBe(tooMany + 1);
      expect(r.changes.filter((c) => /too many different requests/.test(c.explanation))).toHaveLength(tooMany);
      const text = r.changes.map((c) => c.explanation).join(' | ');
      expect(text).toMatch(/too many different requests/);
      expect(text).toMatch(/more places than were kept/);
      expect(r.changes.filter((c) => /too many different requests/.test(c.explanation)).every((c) => !/could not be checked/.test(c.explanation))).toBe(true);
    } finally {
      await cleanUp();
    }
  });
});

describe('check this again', () => {
  const eventBase = () => ({ schemaVersion: 1, workspaceId: omar.workspaceId, at: iso() });
  const team = '00000000-0000-7000-8000-0000000b0001';
  const waitFor = async (who: typeof omar, reason: string, subject: string): Promise<Reassessment> => {
    let found: Reassessment | undefined;
    await vi.waitFor(async () => {
      found = (await notices(who)).body.reassessments.find((n) => n.reason === reason);
      expect(found, `a ${reason} notice for ${subject}`).toBeDefined();
    }, { timeout: 30_000, interval: 250 });
    return found as Reassessment;
  };
  const emitEvent = (event: Record<string, unknown>) => w.system((tx) => emit(tx, { ...eventBase(), ...event }));
  const callsBefore = () => calls;

  it('files a notice when a knowledge base the bot reads is removed, and not for a base it does not read', async () => {
    await w.system((tx) => tx.query(`UPDATE app.bots SET knowledge = '[{"base": "manuals", "answer_only_from": true}]'::jsonb, placement = '{"runs_on": "office-box"}'::jsonb WHERE id = $1`, [botId]));
    const used = callsBefore();
    await emitEvent({ type: 'knowledge.base.deleted', teamId: team, baseId: id7(), slug: 'other-base', documents: 3, deletedBy: omar.actorId });
    await emitEvent({ type: 'knowledge.base.deleted', teamId: team, baseId: id7(), slug: 'manuals', documents: 3, deletedBy: omar.actorId });
    const n = await waitFor(omar, 'knowledge_removed', 'manuals');
    expect(n).toMatchObject({ botSlug: 'replayed', subject: 'manuals', status: 'open' });
    expect(n.headline).toContain('manuals');
    expect(n.checks.length).toBeGreaterThan(0);
    expect((await notices(omar)).body.reassessments.filter((x) => x.reason === 'knowledge_removed')).toHaveLength(1);
    expect(calls).toBe(used);
    const created = await w.system((tx) => tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'workshop.reassessment.created'"));
    expect(created.rows.map((r) => r.payload['reason'])).toContain('knowledge_removed');
  });

  it('files a notice for a runner the bot runs on, once while one waits', async () => {
    const gone = { type: 'bot_runner.runner.deleted', runnerId: id7(), name: 'office-box', kind: 'llm_gateway', actorId: omar.actorId };
    await emitEvent(gone);
    await emitEvent({ ...gone, runnerId: id7() });
    const n = await waitFor(omar, 'runner_revoked', 'office-box');
    expect(n.headline).toContain('office-box');
    // a second one waits behind the first: still one open notice
    await vi.waitFor(async () => expect((await w.system((tx) => tx.query("SELECT 1 FROM app.events WHERE type = 'bot_runner.runner.deleted'"))).rowCount).toBe(2));
    expect((await notices(omar)).body.reassessments.filter((x) => x.reason === 'runner_revoked')).toHaveLength(1);
  });

  const evalRun = async (score: number, ok: boolean, mode: 'static' | 'model' = 'static', set = 'default'): Promise<string> => {
    const eid = await w.system(
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.bot_eval_runs (workspace_id, team_id, bot_id, bot_slug, set_name, trigger, mode, status, min_score, total, judged, passed, score, ok, finished_at)
             VALUES ($1, $2, $3, 'replayed', $7, 'on_demand', $8, 'finished', 0.8, 10, 10, $4, $5, $6, now()) RETURNING id`,
            [omar.workspaceId, team, botId, Math.round(score * 10), score, ok, set, mode],
          )
        ).rows[0]!.id,
    );
    await emitEvent({
      type: 'bots.eval.run.finished',
      teamId: team,
      botId,
      slug: 'replayed',
      runId: eid,
      set,
      trigger: 'on_demand',
      mode,
      status: 'finished',
      commitSha: null,
      total: 10,
      judged: 10,
      passed: Math.round(score * 10),
      score,
      minScore: 0.8,
      ok,
    });
    return eid;
  };
  const evalNotices = async (): Promise<Reassessment[]> => (await notices(omar)).body.reassessments.filter((x) => x.reason === 'eval_dropped');

  it('files a notice when the eval score drops, and none when it holds or rises', async () => {
    const run = evalRun;
    await run(0.9, true);
    await run(0.95, true);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await notices(omar)).body.reassessments.filter((x) => x.reason === 'eval_dropped')).toHaveLength(0);
    await run(0.5, false);
    const n = await waitFor(omar, 'eval_dropped', '');
    expect(n.headline).toMatch(/50%/);
  });

  it('is read by anyone who can read the bot, and closed only by a lead or an admin, once', async () => {
    const list = (await notices(nadia)).body.reassessments;
    expect(list.length).toBeGreaterThanOrEqual(3);
    const first = list[0]!;
    const close = (who: typeof omar, id: string, answer: unknown) => w.call<{ reassessment?: Reassessment; error?: { message: string } }>(who, 'POST', `${base}/reassessments/${id}/close`, { answer });
    expect((await close(nadia, first.id, 'done')).status).toBe(403);
    expect((await close(omar, first.id, 'maybe')).status).toBe(400);
    const done = await close(omar, first.id, 'done');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.reassessment).toMatchObject({ id: first.id, status: 'done' });
    expect((await close(omar, first.id, 'dismissed')).status).toBe(404);
    expect((await notices(omar)).body.reassessments.map((x) => x.id)).not.toContain(first.id);
    const closed = await w.system((tx) => tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'workshop.reassessment.closed'"));
    expect(closed.rows.map((r) => r.payload['answer'])).toEqual(['done']);
    // a person who cannot read the bot reads nothing
    expect([403, 404]).toContain((await notices(sameera)).status);
  });

  it('files nothing for a bot of another team or one that does not use the thing', async () => {
    const used = (await notices(omar)).body.reassessments.length;
    await emitEvent({ type: 'bot_runner.runner.deleted', runnerId: id7(), name: 'someone-elses-box', kind: 'llm_gateway', actorId: omar.actorId });
    await emitEvent({ type: 'knowledge.base.created', teamId: '00000000-0000-7000-8000-0000000b0002', baseId: id7(), slug: 'manuals', name: 'Manuals', createdBy: omar.actorId });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await notices(omar)).body.reassessments.length).toBe(used);
  });

  it('compares a score only with the run before it of the same set and the same mode, and never files for a first run', async () => {
    const open = (await evalNotices()).length;
    // a model run of 90%, then a free run of 50% in the same set: two different measures, not a drop
    await evalRun(0.9, true, 'model', 'other');
    await evalRun(0.5, false, 'static', 'other');
    // the very first run of a set, far under the minimum: nothing to have dropped from
    await evalRun(0.1, false, 'static', 'fresh');
    await new Promise((r) => setTimeout(r, 2000));
    expect(await evalNotices()).toHaveLength(open);
    // a real drop in the same mode still files
    await evalRun(0.3, false, 'static', 'other');
    await vi.waitFor(async () => expect(await evalNotices()).toHaveLength(open + 1), { timeout: 30_000, interval: 250 });
    expect((await evalNotices()).some((n) => /50% to 30%/.test(n.headline))).toBe(true);
  });

  it('tells a bot that lists no knowledge base (it searches all of its team’s) when a base appears, in words that say why, and pages past 500 bots', async () => {
    await w.system((tx) => tx.query(`UPDATE app.bots SET knowledge = '[]'::jsonb WHERE id = $1`, [botId]));
    await emitEvent({ type: 'knowledge.base.created', teamId: team, baseId: id7(), slug: 'handbook', name: 'Handbook', createdBy: omar.actorId });
    const n = await waitFor(omar, 'knowledge_added', 'handbook');
    expect(n.headline).toMatch(/lists none, so it searches every base of its team/);
    // 600 more bots of the team that list none: every one of them gets the notice (no silent cap at 200)
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, knowledge)
         SELECT $1, $2, 'bulk-' || g, 'Bulk ' || g, 'x', 'agent', 'hermes', 'team', repeat('a', 64), 'active', '[]'::jsonb FROM generate_series(1, 600) g`,
        [omar.workspaceId, team],
      ),
    );
    await emitEvent({ type: 'knowledge.base.created', teamId: team, baseId: id7(), slug: 'faq', name: 'FAQ', createdBy: omar.actorId });
    await vi.waitFor(
      async () => {
        const n2 = await w.system((tx) => tx.query<{ n: string }>("SELECT count(*) AS n FROM app.bot_reassessments WHERE reason = 'knowledge_added' AND subject = 'faq'"));
        expect(Number(n2.rows[0]!.n)).toBeGreaterThanOrEqual(601);
      },
      { timeout: 60_000, interval: 500 },
    );
  });
});
