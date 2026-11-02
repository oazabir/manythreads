import { parseBotEvalSet, type WorkshopEntry, type WorkshopSession } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeLlm, type FakeLlm } from '../../../../tools/fake-llm/src/server.ts';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// P7-05 and P7-06 (server): the Workshop tab through the real server, a real database and a model stand-in that answers what a test scripts.
// Build: the helper reads the bot, files corrections as proposals (a lesson, a test case, a rule) and refuses what loosens a check. Rehearse: a HOSTILE scripted model tries every write it can
// think of and none reaches the world; each is badged "not really done". Live: counts only the runs the asker may see. A conversation is its owner's alone.

const { omar, nadia, lena } = personas;
vi.setConfig({ testTimeout: 120_000 });

type Step = { text: string } | { calls: Array<{ name: string; args: unknown }> } | { fail: true };
type Kind = 'build' | 'live' | 'rehearse' | 'other';
const scripts: Record<Kind, Step[]> = { build: [], live: [], rehearse: [], other: [] };
const seen: Record<Kind, Array<Array<{ role: string; content: string }>>> = { build: [], live: [], rehearse: [], other: [] };
let counter = 0;

// Two tests need the model to answer at a moment the test chooses: [RACE] makes two conversations ask for the same file at the same moment, [GATE] holds one answer until the test lets it go.
const RACE_PEOPLE = 2;
let raceArrived = 0;
let raceOpen: () => void = () => undefined;
const raceDoor = new Promise<void>((resolve) => {
  raceOpen = resolve;
});
let gateArrived: () => void = () => undefined;
const gateReached = new Promise<void>((resolve) => {
  gateArrived = resolve;
});
let gateOpen: () => void = () => undefined;
const gateDoor = new Promise<void>((resolve) => {
  gateOpen = resolve;
});
const RACE_LESSONS: Record<string, string> = {
  first: 'Always give the link to the rollout page when someone asks where the steps are.',
  second: 'When asked about hotfixes, name the person on call before anything else.',
};

let w: RepoWorld;
let fake: FakeLlm;
const saved = { url: process.env['MANYTHREADS_LITELLM_URL'], key: process.env['MANYTHREADS_LITELLM_MASTER_KEY'] };

const kindOf = (messages: Array<{ role: string; content: string }>): Kind => {
  const system = messages[0]?.content ?? '';
  if (system.includes('You are the Workshop helper') && system.includes('You help a person improve a bot')) return 'build';
  if (system.includes('You are the Workshop helper') && system.includes('records of its runs')) return 'live';
  if (system.includes('RELEASE-HELPER-BODY') && messages.some((m) => m.role === 'user' && m.content.includes('RHS'))) return 'rehearse';
  return 'other';
};

beforeAll(async () => {
  fake = await startFakeLlm({
    masterKey: 'sk-fake',
    completion: async ({ messages }) => {
      const kind = kindOf(messages);
      seen[kind].push(messages);
      const toolBody = (calls: Array<{ name: string; args: unknown }>) => {
        counter += 1;
        return {
          status: 200,
          body: {
            id: `chatcmpl-ws-${String(counter)}`,
            model: 'smart',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: calls.map((c, i) => ({ id: `call_${String(counter)}_${String(i)}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
          },
        };
      };
      const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
      const answered = messages.some((m) => m.role === 'tool');
      if (kind === 'build' && firstUser.includes('[RACE]')) {
        if (answered) return 'Done.';
        raceArrived += 1;
        if (raceArrived >= RACE_PEOPLE) raceOpen();
        // both conversations leave together (or the one that came alone leaves after a while, so a test that lost its partner fails on its assertions, not by hanging)
        await Promise.race([raceDoor, new Promise((resolve) => setTimeout(resolve, 20_000))]);
        const which = firstUser.includes('[FIRST]') ? 'first' : 'second';
        return toolBody([{ name: 'record_correction', args: { corrections: [{ lesson: RACE_LESSONS[which], question: `Race question ${which}?`, mustMention: ['rollout'] }] } }]);
      }
      if (kind === 'build' && firstUser.includes('[GATE]')) {
        if (answered) return 'Done.';
        gateArrived();
        await gateDoor;
        return toolBody([{ name: 'record_correction', args: { corrections: [{ lesson: 'Always name the owner of the service when asked who to call.', question: 'Who do I call?', mustMention: ['owner'] }] } }]);
      }
      const next = scripts[kind].shift();
      if (!next) return 'Nothing more to do.';
      if ('text' in next) return next.text;
      if ('fail' in next) return { status: 500, body: { error: { message: 'the model is down', type: 'server_error' } } };
      return toolBody(next.calls);
    },
  });
  process.env['MANYTHREADS_LITELLM_URL'] = fake.url;
  process.env['MANYTHREADS_LITELLM_MASTER_KEY'] = 'sk-fake';
  w = await createRepoWorld();
  const created = await w.call<{ provider: { id: string } }>(omar, 'POST', '/api/workspace/llm/providers', { name: 'OpenAI', kind: 'openai', apiKey: 'sk-provider-secret-7777' });
  const bound = await w.call(omar, 'PUT', '/api/workspace/llm/aliases/smart', { providerId: created.body.provider.id, model: 'gpt-4o', fallbacks: [] });
  expect(bound.status).toBe(200);
  await w.system(async (tx) => {
    await tx.query(`UPDATE app.llm_aliases SET updated_at = updated_at - interval '1 minute'`);
    await tx.query(`UPDATE app.llm_providers SET updated_at = updated_at - interval '1 minute'`);
  });
  const made = await w.commit(
    omar,
    'engineering',
    [{ op: 'put', path: 'bots/rehearsed/BOT.md', content: BOT_MD }],
    'A bot for the Workshop tests',
  );
  expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
  await vi.waitFor(async () => expect((await w.call(omar, 'GET', '/api/teams/engineering/bots/rehearsed')).status).toBe(200), { timeout: 30_000, interval: 250 });
}, 240_000);

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

const BOT_MD = `---
schema: 1
name: Rehearsed
role: Answers questions about the release checklist.
kind: agent
runtime: hermes
model:
  aliases: [smart]
triggers:
  - type: mention
capabilities:
  native: [messages.post, messages.search, answer.post, pages.write]
---

RELEASE-HELPER-BODY: you answer questions about the release checklist. If you do not know, say so and ask a person.
`;

type Who = typeof omar;
const base = (bot = 'rehearsed', team = 'engineering') => `/api/teams/${team}/bots/${bot}/workshop/sessions`;
const start = (who: Who, mode: string, text?: string, bot = 'rehearsed') => w.call<{ session: WorkshopSession; error?: { message: string } }>(who, 'POST', base(bot), { mode, ...(text === undefined ? {} : { text }) });
const read = (who: Who, id: string) => w.call<{ session: WorkshopSession }>(who, 'GET', `${base()}/${id}`);
const say = (who: Who, id: string, text: string, about?: unknown) => w.call<{ session: WorkshopSession; error?: { message: string } }>(who, 'POST', `${base()}/${id}/messages`, { text, ...(about ? { about } : {}) });
const end = (who: Who, id: string) => w.call<{ session: WorkshopSession }>(who, 'POST', `${base()}/${id}/end`, {});
const settled = async (who: Who, id: string): Promise<WorkshopSession> => {
  let last: WorkshopSession | undefined;
  await vi.waitFor(
    async () => {
      last = (await read(who, id)).body.session;
      expect(['ready', 'failed', 'ended', 'cancelled']).toContain(last.status);
    },
    { timeout: 60_000, interval: 250 },
  );
  return last as WorkshopSession;
};
const of = <K extends WorkshopEntry['kind']>(s: WorkshopSession, kind: K) => s.entries.filter((e): e is Extract<WorkshopEntry, { kind: K }> => e.kind === kind);
const proposalsOf = async (): Promise<Array<{ id: string; path: string; status: string }>> =>
  (await w.system((tx) => tx.query<{ id: string; path: string; status: string }>(`SELECT id, path, status FROM app.proposals ORDER BY created_at`))).rows;
const blobOf = async (path: string) => {
  const res = await w.call<{ content: string }>(omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`);
  return res.status === 200 ? res.body.content : null;
};
const toolAnswers = (kind: Kind): string[] => seen[kind].flat().filter((m) => m.role === 'tool').map((m) => m.content);

describe('Build: a person improves an existing bot; everything becomes a proposal', () => {
  let id = '';

  it('reads the bot, answers in plain words, and counts its model calls', async () => {
    scripts.build = [{ calls: [{ name: 'read_bot', args: {} }] }, { text: 'I read it. What should change?' }];
    const created = await start(omar, 'build', 'I want the bot to be friendlier.');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.session.status).toBe('working');
    id = created.body.session.id;
    const s = await settled(omar, id);
    expect(s.status, s.message ?? '').toBe('ready');
    expect(s.entries.map((e) => e.kind)).toEqual(['person', 'step', 'reply']);
    expect(of(s, 'step')[0]).toMatchObject({ tool: 'read_bot', outcome: 'ok', badge: null });
    expect(of(s, 'reply')[0]).toMatchObject({ rehearsal: false });
    expect(s.usage).toMatchObject({ calls: 2, label: 'workshop' });
    expect(toolAnswers('build').join('\n')).toContain('RELEASE-HELPER-BODY');
  });

  it('files a changed BOT.md as a proposal that waits, as the person, with the bot fixed by the conversation', async () => {
    const md = BOT_MD.replace('If you do not know', 'Be friendly. If you do not know');
    scripts.build = [{ calls: [{ name: 'propose_bot_change', args: { botMd: md, summary: 'Friendlier tone.' } }] }, { text: 'I filed it. A lead approves it.' }];
    const sent = await say(omar, id, 'Yes, make the tone friendlier.');
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const s = await settled(omar, id);
    expect(of(s, 'proposal').map((p) => [p.path, p.role])).toEqual([['bots/rehearsed/BOT.md', 'bot']]);
    const open = (await proposalsOf()).filter((p) => p.status === 'open');
    expect(open.map((p) => p.path)).toEqual(['bots/rehearsed/BOT.md']);
    expect(await blobOf('bots/rehearsed/BOT.md')).not.toContain('Be friendly');
    // nothing is applied until Approve
    const approved = await w.call(omar, 'POST', `/api/teams/engineering/proposals/${open[0]!.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await blobOf('bots/rehearsed/BOT.md')).toContain('Be friendly');
  });

  it('refuses a change to another bot or a change that loosens what the team allows, and says why', async () => {
    const md = BOT_MD.replace('model:', 'runtime_extra: 1\nmodel:');
    scripts.build = [{ calls: [{ name: 'propose_bot_change', args: { botMd: md } }] }, { text: 'That was refused.' }];
    const before = (await proposalsOf()).length;
    await say(omar, id, 'Add something odd.');
    const s = await settled(omar, id);
    expect(of(s, 'step').at(-1)?.outcome).toBe('refused');
    expect((await proposalsOf()).length).toBe(before);
  });

  it('a correction becomes a lesson, a test case and (asked in words) a rule: three proposals, none applied', async () => {
    const lesson = 'Always give the link to the release checklist page when someone asks where the steps are.';
    scripts.build = [
      { calls: [{ name: 'record_correction', args: { corrections: [{ lesson, question: 'Where are the release steps?', mustMention: ['checklist'], rule: lesson }] } }] },
      { text: 'Filed.' },
    ];
    const sent = await say(omar, id, 'That answer was wrong, it should give the link. Make that a rule.');
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const s = await settled(omar, id);
    const roles = of(s, 'proposal').map((p) => `${p.role}:${p.path}`).sort();
    expect(roles.some((r) => r.startsWith('lessons:bots/rehearsed/lessons.md'))).toBe(true);
    expect(roles.some((r) => r.startsWith('eval:bots/rehearsed/evals/'))).toBe(true);
    expect(roles.some((r) => r.startsWith('rule:bots/rehearsed/BOT.md'))).toBe(true);
    expect(await blobOf('bots/rehearsed/lessons.md')).toBeNull();
    const open = (await proposalsOf()).filter((p) => p.status === 'open').map((p) => p.path);
    expect(open).toContain('bots/rehearsed/lessons.md');
  });

  it('once approved the lesson file and the test case exist and load; the same lesson told again becomes a rule by itself', async () => {
    const open = (await proposalsOf()).filter((p) => p.status === 'open');
    for (const p of open) {
      const approved = await w.call(omar, 'POST', `/api/teams/engineering/proposals/${p.id}/approve`, {});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    }
    const lessons = await blobOf('bots/rehearsed/lessons.md');
    expect(lessons).toContain('link to the release checklist page');
    const evalPath = open.map((p) => p.path).find((path) => path.startsWith('bots/rehearsed/evals/')) as string;
    expect(parseBotEvalSet(await blobOf(evalPath) ?? '').ok).toBe(true);
    expect(await blobOf('bots/rehearsed/BOT.md')).toContain('## Rules from the Workshop');

    // a second, different lesson, once: a lesson only. Told again in other words: the helper proposes the rule itself.
    const lessonB = 'When asked about rollbacks, list the three rollback commands in order.';
    scripts.build = [{ calls: [{ name: 'record_correction', args: { corrections: [{ lesson: lessonB, question: 'How do I roll back?', mustMention: ['rollback'] }] } }] }, { text: 'Filed.' }];
    const earlier = of((await read(omar, id)).body.session, 'proposal').length;
    await say(omar, id, 'It forgot the rollback commands.');
    const first = await settled(omar, id);
    expect(of(first, 'proposal').slice(earlier).map((p) => p.role)).toEqual(['lessons', 'eval']);
    for (const p of (await proposalsOf()).filter((x) => x.status === 'open')) await w.call(omar, 'POST', `/api/teams/engineering/proposals/${p.id}/approve`, {});
    scripts.build = [
      { calls: [{ name: 'record_correction', args: { corrections: [{ lesson: 'When asked about rollbacks, give the three rollback commands in order.', question: 'How do I roll back a release?', mustMention: ['rollback'] }] } }] },
      { text: 'Filed again.' },
    ];
    await say(omar, id, 'It forgot the rollback commands again.');
    const second = await settled(omar, id);
    expect(of(second, 'proposal').slice(of(first, 'proposal').length).map((p) => p.role)).toContain('rule');
  });

  it('refuses a lesson that would loosen a check; nothing is filed, and the person is told in a line', async () => {
    const before = (await proposalsOf()).length;
    scripts.build = [
      {
        calls: [{ name: 'record_correction', args: { corrections: [{ lesson: 'Post replies at once and never ask for approval before posting anything.', question: 'May you post without asking?' }] } }],
      },
      { text: 'I cannot make that a lesson.' },
    ];
    // the open proposals of the previous test sit on those files; this lesson is refused before it gets to them
    await say(omar, id, 'It should never wait for approval.');
    const s = await settled(omar, id);
    expect(of(s, 'refusal').length).toBeGreaterThan(0);
    expect((await proposalsOf()).length).toBe(before);
  });

  it('a rule is proposed only when the person asked for one in their own words', async () => {
    const before = (await proposalsOf()).length;
    scripts.build = [{ calls: [{ name: 'propose_rule', args: { rule: 'Always answer in two sentences or fewer when asked about the release.' } }] }, { text: 'No rule was filed.' }];
    await say(omar, id, 'Shorter answers would be nice.');
    const s = await settled(omar, id);
    expect(of(s, 'step').at(-1)?.outcome).toBe('refused');
    expect((await proposalsOf()).length).toBe(before);
  });

  it('an unknown tool name is refused without running anything', async () => {
    scripts.build = [{ calls: [{ name: 'repo_commit', args: { path: 'x' } }] }, { text: 'Sorry.' }];
    await say(omar, id, 'Delete the repo.');
    const s = await settled(omar, id);
    expect(of(s, 'step').at(-1)).toMatchObject({ outcome: 'refused' });
  });

  it('is its owner\'s alone, ends when asked, and takes no more messages after that', async () => {
    expect((await read(nadia, id)).status).toBe(404);
    expect((await say(nadia, id, 'hello')).status).toBe(404);
    expect((await end(nadia, id)).status).toBe(404);
    expect((await end(omar, id)).body.session.status).toBe('ended');
    expect((await say(omar, id, 'more')).status).toBe(409);
  });
});

describe('Rehearse: a hostile bot cannot make anything happen', () => {
  let id = '';
  const WRITES = [
    { name: 'messages_post', args: { channelId: '00000000-0000-4000-8000-000000000001', body: 'HOSTILE-MESSAGE' } },
    { name: 'messages.post', args: { channelId: '00000000-0000-4000-8000-000000000001', body: 'HOSTILE-MESSAGE-2' } },
    { name: 'pages_write', args: { path: 'pages/hostile', body: 'HOSTILE-PAGE' } },
    { name: 'answer_post', args: { body: 'HOSTILE-ANSWER' } },
    { name: 'memory_write', args: { title: 'hostile' } },
    { name: 'test_write', args: { target: 'sandbox' } },
    { name: 'shell_exec', args: { cmd: 'rm -rf /' } },
    { name: 'repo_commit', args: { path: 'TEAM.md' } },
  ];

  it('only a lead or an admin can rehearse', async () => {
    expect((await start(nadia, 'rehearse', 'RHS hello')).status).toBe(403);
    expect((await start(lena, 'rehearse', 'RHS hello')).status).toBe(403);
  });

  it('every write the model tries is held or refused, badged "not really done", and logged; nothing leaves the sandbox', async () => {
    const messagesBefore = (await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.messages`))).rows[0]!.n;
    const pagesBefore = (await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.page_docs`))).rows[0]!.n;
    const proposalsBefore = (await proposalsOf()).length;
    scripts.rehearse = [{ calls: WRITES.slice(0, 4) }, { calls: WRITES.slice(4) }, { text: 'I did all of it.' }];
    const created = await start(omar, 'rehearse', 'RHS where are the release steps?');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    id = created.body.session.id;
    const s = await settled(omar, id);
    expect(s.status, s.message ?? '').toBe('ready');

    const steps = of(s, 'step');
    expect(steps).toHaveLength(WRITES.length);
    // exactly what the broker did with each: the writes the bot could reach are held and badged, a name that was not offered never reaches the broker
    expect(steps.map((x) => [x.tool, x.outcome, x.badge])).toEqual([
      ['messages.post', 'held', 'not really done'],
      ['messages.post', 'refused', null],
      ['pages.write', 'held', 'not really done'],
      ['answer.post', 'held', 'not really done'],
      ['memory_write', 'refused', null],
      ['test.write', 'held', 'not really done'],
      ['shell_exec', 'refused', null],
      ['repo_commit', 'refused', null],
    ]);
    expect(of(s, 'reply')[0]).toMatchObject({ rehearsal: true });
    expect(s.usage.label).toBe('rehearsal');

    // the world is unchanged
    expect((await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.messages`))).rows[0]!.n).toBe(messagesBefore);
    expect((await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.page_docs`))).rows[0]!.n).toBe(pagesBefore);
    expect((await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.messages WHERE body LIKE 'HOSTILE%'`))).rows[0]!.n).toBe('0');
    expect((await proposalsOf()).length).toBe(proposalsBefore);

    // the broker logged the held calls on a run that was a rehearsal, and the run ended with the turn
    const runs = await w.system((tx) => tx.query<{ id: string; rehearsal: boolean; status: string }>(`SELECT id, rehearsal, status FROM app.bot_runs WHERE rehearsal ORDER BY started_at DESC LIMIT 1`));
    expect(runs.rows[0]).toMatchObject({ rehearsal: true });
    // a turn that replied ends its run as done
    expect(runs.rows[0]!.status).toBe('done');
    const lines = await w.system((tx) => tx.query<{ capability: string }>(`SELECT capability FROM app.rehearsal_intercepts WHERE run_id = $1`, [runs.rows[0]!.id]));
    expect(lines.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines.rows)).not.toContain('HOSTILE');

    // the spend is labelled as a rehearsal and carries the bot
    const spend = await w.system((tx) => tx.query<{ bot_id: string | null; purpose: string | null }>(`SELECT bot_id, purpose FROM app.llm_spend WHERE session_id = $1`, [`rehearsal:${id}`]));
    expect(spend.rows.length).toBe(3);
    expect(s.usage.calls).toBe(3);
    expect(spend.rows.every((r) => r.bot_id !== null)).toBe(true);
    expect(spend.rows.every((r) => r.purpose === 'rehearsal')).toBe(true);
  });

  it('a rehearsal is no real run: it is not counted among the bot\'s runs', async () => {
    const count = await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.bot_runs WHERE NOT rehearsal AND bot_id = (SELECT id FROM app.bots WHERE slug = 'rehearsed')`));
    expect(count.rows[0]!.n).toBe('0');
  });

  it('a rehearsal answer can be carried into Build as a correction (read by the server from the person\'s own session)', async () => {
    const reply = of((await read(omar, id)).body.session, 'reply')[0]!;
    scripts.build = [{ text: 'Noted.' }];
    const b = await start(omar, 'build');
    expect(b.status).toBe(201);
    const sent = await say(omar, b.body.session.id, 'This answer was wrong.', { sessionId: id, entryId: reply.id });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(of(sent.body.session, 'person')[0]!.about?.excerpt).toContain('I did all of it.');
    await settled(omar, b.body.session.id);
    // someone else's rehearsal, or an entry that is not a reply, cannot be named
    const other = await say(omar, b.body.session.id, 'And this.', { sessionId: id, entryId: 'e1' });
    expect(other.status).toBe(400);
    expect((await say(nadia, b.body.session.id, 'x', { sessionId: id, entryId: reply.id })).status).toBe(404);
    await end(omar, b.body.session.id);
    await end(omar, id);
  });
});

describe('Live: questions about real runs, scoped to what the asker may see', () => {
  it('counts the asker\'s own conversations and the team\'s automatic runs, not someone else\'s conversation', async () => {
    await w.system(async (tx) => {
      const bot = (await tx.query<{ id: string; team_id: string }>(`SELECT id, team_id FROM app.bots WHERE slug = 'rehearsed'`)).rows[0]!;
      const add = (trigger: string, asker: string | null) =>
        tx.query(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, ended_at) VALUES ($1, $2, $3, $4, $5, 'done', now())`,
          [omar.workspaceId, bot.id, bot.team_id, trigger, asker],
        );
      await add('conversation', omar.actorId);
      await add('conversation', nadia.actorId);
      await add('conversation', nadia.actorId);
      await add('routine', null);
    });
    scripts.live = [{ calls: [{ name: 'run_stats', args: { days: 7 } }] }, { text: 'You can see 2 runs.' }];
    seen.live.length = 0;
    const created = await start(omar, 'live', 'How has the bot been doing this week?');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const s = await settled(omar, created.body.session.id);
    expect(s.status, s.message ?? '').toBe('ready');
    expect(of(s, 'step')[0]).toMatchObject({ tool: 'run_stats', outcome: 'read' });
    const answer = JSON.parse(toolAnswers('live')[0]!) as { total: number };
    // omar's conversation and the routine; nadia's two conversations are hers alone
    expect(answer.total).toBe(2);
    // a tool Live was not given is refused
    scripts.live = [{ calls: [{ name: 'propose_bot_change', args: { botMd: BOT_MD } }] }, { text: 'No.' }];
    await say(omar, created.body.session.id, 'Change the bot.');
    const s2 = await settled(omar, created.body.session.id);
    expect(of(s2, 'step').at(-1)).toMatchObject({ outcome: 'refused' });
    await end(omar, created.body.session.id);
  });
});

describe('limits and the door', () => {
  it('a guest cannot start one; a bot that does not exist is a 404; an empty or unknown request is a 400', async () => {
    expect((await start(lena, 'build', 'hello')).status).toBe(403);
    expect((await start(omar, 'build', 'hello', 'no-such-bot')).status).toBe(404);
    expect((await w.call(omar, 'POST', base(), { mode: 'sideways' })).status).toBe(400);
    expect((await w.call(omar, 'POST', base(), { mode: 'build', extra: 1 })).status).toBe(400);
  });

  it('a person has at most three open at once, and ending one makes room', async () => {
    scripts.build = [];
    const open: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await start(nadia, 'build', `Open conversation ${String(i)} for the limit.`);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      open.push(r.body.session.id);
    }
    expect((await start(nadia, 'build', 'One too many.')).status).toBe(409);
    for (const sid of open) await settled(nadia, sid);
    expect((await end(nadia, open[0]!)).body.session.status).toBe('ended');
    const again = await start(nadia, 'build', 'There is room now.');
    expect(again.status).toBe(201);
    await settled(nadia, again.body.session.id);
    for (const sid of [...open.slice(1), again.body.session.id]) await end(nadia, sid);
  });

  it('takes 30 messages and then asks for a new conversation', async () => {
    const created = await start(omar, 'build');
    const sid = created.body.session.id;
    await w.system((tx) => tx.query(`UPDATE app.workshop_sessions SET message_count = 30 WHERE id = $1`, [sid]));
    const r = await say(omar, sid, 'one more');
    expect(r.status).toBe(409);
    await end(omar, sid);
  });

  it('a message while the helper is still working is refused, and ending a working one cancels it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scripts.build = [{ text: 'late' }];
    const created = await start(omar, 'build');
    const sid = created.body.session.id;
    await w.system((tx) => tx.query(`UPDATE app.workshop_sessions SET status = 'working', turn = 7 WHERE id = $1`, [sid]));
    expect((await say(omar, sid, 'while working')).status).toBe(409);
    expect((await end(omar, sid)).body.session.status).toBe('cancelled');
    release();
    await gate;
  });

  it('a conversation that has written nothing for ten minutes is stuck: the next read turns it into a failure', async () => {
    const created = await start(omar, 'build');
    const sid = created.body.session.id;
    await w.system((tx) => tx.query(`UPDATE app.workshop_sessions SET status = 'working', turn = 3, updated_at = now() - interval '11 minutes' WHERE id = $1`, [sid]));
    const s = (await read(omar, sid)).body.session;
    expect(s.status).toBe('failed');
    expect(s.message).toMatch(/stopped answering/);
  });
});

describe('filing: one proposal per file, nothing half-filed, and an ended conversation still shows what it filed', () => {
  const botFile = (name: string): string => BOT_MD.replace('name: Rehearsed', `name: ${name}`);
  const makeBot = async (slug: string, name: string, extra: Array<{ op: 'put'; path: string; content: string }> = []): Promise<void> => {
    const made = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: botFile(name) }, ...extra], `Bot ${slug} for the filing tests`);
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    await vi.waitFor(async () => expect((await w.call(omar, 'GET', `/api/teams/engineering/bots/${slug}`)).status).toBe(200), { timeout: 30_000, interval: 250 });
  };
  const openOn = async (path: string): Promise<number> => Number((await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.proposals WHERE path LIKE $1 AND status = 'open'`, [path]))).rows[0]!.n);
  const settleBot = async (slug: string, id: string, wanted: string[] = ['ready', 'failed']): Promise<WorkshopSession> => {
    let last: WorkshopSession | undefined;
    await vi.waitFor(
      async () => {
        last = (await w.call<{ session: WorkshopSession }>(omar, 'GET', `${base(slug)}/${id}`)).body.session;
        expect(wanted).toContain(last.status);
      },
      { timeout: 60_000, interval: 250 },
    );
    return last as WorkshopSession;
  };

  it('two conversations filing a lesson on the same file at the same moment: one is filed, the other is told one is already waiting', async () => {
    await makeBot('racer', 'Racer');
    seen.build.length = 0;
    const a = await start(omar, 'build', '[RACE] [FIRST] Please record this lesson.', 'racer');
    const b = await start(omar, 'build', '[RACE] [SECOND] Please record this lesson.', 'racer');
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const sa = await settleBot('racer', a.body.session.id);
    const sb = await settleBot('racer', b.body.session.id);
    expect(raceArrived).toBeGreaterThanOrEqual(RACE_PEOPLE);
    // the proposals service would have taken both; the Workshop's lock lets exactly one in
    expect(await openOn('bots/racer/lessons.md')).toBe(1);
    const filed = [sa, sb].map((s) => of(s, 'proposal').filter((p) => p.path === 'bots/racer/lessons.md').length);
    expect(filed.sort()).toEqual([0, 1]);
    const loser = [sa, sb].find((s) => of(s, 'proposal').length === 0)!;
    expect(of(loser, 'step').find((x) => x.tool === 'record_correction')).toMatchObject({ outcome: 'refused' });
    expect(toolAnswers('build').join('\n')).toContain('proposal waiting for a person');
    await end(omar, a.body.session.id);
    await end(omar, b.body.session.id);
  });

  it('a batch that fails half way files nothing and shows no proposal in the conversation', async () => {
    // a lessons file so long that one more lesson is over the size a proposal may have: the rule (BOT.md) is filed first, then the lesson is refused
    let lessons = '# Lessons for bulky\n\nCorrections from the team, collected by the Workshop.\n\n';
    for (let i = 0; lessons.length < 259_000; i += 1) lessons += `- 2026-01-02: Note ${String(i).padStart(3, '0')} ${'filler '.repeat(370)}\n`;
    // a proposal may hold 262144 characters: this file is a few characters under it, so any new lesson is over
    lessons += `- 2026-01-02: ${'x'.repeat(262_135 - lessons.length - 15)}\n`;
    await makeBot('bulky', 'Bulky', [{ op: 'put', path: 'bots/bulky/lessons.md', content: lessons }]);
    const lesson = 'Always give the link to the release checklist page when someone asks where the steps are.';
    scripts.build = [{ calls: [{ name: 'record_correction', args: { corrections: [{ lesson, question: 'Where are the steps?', mustMention: ['checklist'], rule: lesson }] } }] }, { text: 'It did not work.' }];
    const created = await start(omar, 'build', 'It forgot the link. Please make that a rule.', 'bulky');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const s = await settleBot('bulky', created.body.session.id);
    expect(of(s, 'step').find((x) => x.tool === 'record_correction')).toMatchObject({ outcome: 'failed' });
    expect(of(s, 'proposal')).toHaveLength(0);
    expect(await openOn('bots/bulky/%')).toBe(0);
    await end(omar, created.body.session.id);
  });

  it('ending a conversation while the helper is working: a proposal the helper files meanwhile still shows in the transcript', async () => {
    await makeBot('ender', 'Ender');
    // earlier tests left a few of the person's conversations open: the limit of three open at once is not what this one is about
    await w.system((tx) => tx.query(`UPDATE app.workshop_sessions SET status = 'ended' WHERE owner_id = $1 AND status IN ('ready', 'failed')`, [omar.actorId]));
    const created = await start(omar, 'build', '[GATE] Please record this lesson.', 'ender');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.session.id;
    await gateReached;
    const ended = await w.call<{ session: WorkshopSession }>(omar, 'POST', `${base('ender')}/${id}/end`, {});
    expect(ended.body.session.status).toBe('cancelled');
    gateOpen();
    await vi.waitFor(
      async () => {
        const s = (await w.call<{ session: WorkshopSession }>(omar, 'GET', `${base('ender')}/${id}`)).body.session;
        expect(s.status).toBe('cancelled');
        // nothing the helper filed is hidden from the person: the proposals that exist are the ones the transcript names
        expect(of(s, 'proposal').length).toBe(await openOn('bots/ender/%'));
        expect(of(s, 'proposal').length).toBeGreaterThan(0);
      },
      { timeout: 30_000, interval: 300 },
    );
  });
});

describe('Rehearse: the sandbox holds what it does not know, and a failed turn is a failed run', () => {
  const SANDBOX_BOT = BOT_MD.replace('name: Rehearsed', 'name: Sandboxed').replace('native: [messages.post, messages.search, answer.post, pages.write]', 'native: [messages.search, hello.greet, answer.post]');
  let sandboxed = '';
  const settleRehearsal = async (id: string): Promise<WorkshopSession> => {
    let last: WorkshopSession | undefined;
    await vi.waitFor(
      async () => {
        last = (await w.call<{ session: WorkshopSession }>(omar, 'GET', `${base('sandboxed')}/${id}`)).body.session;
        expect(['ready', 'failed']).toContain(last.status);
      },
      { timeout: 60_000, interval: 250 },
    );
    return last as WorkshopSession;
  };
  const lastRun = async () => (await w.system((tx) => tx.query<{ id: string; status: string }>(`SELECT id, status FROM app.bot_runs WHERE rehearsal AND bot_id = $1 ORDER BY started_at DESC LIMIT 1`, [sandboxed]))).rows[0]!;

  it('a capability the catalog has no entry for is a write by default, so the sandbox holds it; a read that a person must approve is held too and files no approval card', async () => {
    const made = await w.commit(omar, 'engineering', [{ op: 'put', path: 'bots/sandboxed/BOT.md', content: SANDBOX_BOT }], 'A bot for the sandbox tests');
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    await vi.waitFor(async () => expect((await w.call(omar, 'GET', '/api/teams/engineering/bots/sandboxed')).status).toBe(200), { timeout: 30_000, interval: 250 });
    sandboxed = (await w.system((tx) => tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE slug = 'sandboxed'`))).rows[0]!.id;
    const grants = await w.system((tx) => tx.query<{ capability: string }>(`SELECT g.capability FROM app.capability_grants g JOIN app.actors a ON a.id = g.actor_id WHERE a.ref_id = $1`, [sandboxed]));
    expect(grants.rows.map((r) => r.capability).sort()).toEqual(['answer.post', 'hello.greet', 'messages.search']);
    // a person must approve the bot's searches
    await w.system((tx) => tx.query(`UPDATE app.capability_grants SET needs_approval = true WHERE capability = 'messages.search' AND actor_id = (SELECT id FROM app.actors WHERE ref_id = $1)`, [sandboxed]));

    const approvalsBefore = Number((await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.approvals`))).rows[0]!.n);
    scripts.rehearse = [
      { calls: [{ name: 'hello_greet', args: { note: 'HOSTILE-GREETING' } }, { name: 'messages_search', args: { query: 'release' } }] },
      { text: 'Done.' },
    ];
    const created = await start(omar, 'rehearse', 'RHS look it up and write it down', 'sandboxed');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const s = await settleRehearsal(created.body.session.id);
    expect(s.status, s.message ?? '').toBe('ready');
    expect(of(s, 'step').map((x) => [x.tool, x.outcome, x.badge])).toEqual([
      ['hello.greet', 'held', 'not really done'],
      ['messages.search', 'held', 'not really done'],
    ]);
    // nothing was written, no card waits for anybody, and the line for the search says it would have waited
    expect(Number((await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.approvals`))).rows[0]!.n)).toBe(approvalsBefore);
    const run = await lastRun();
    const lines = await w.system((tx) => tx.query<{ capability: string; would_wait: boolean }>(`SELECT capability, would_wait FROM app.rehearsal_intercepts WHERE run_id = $1 ORDER BY seq`, [run.id]));
    expect(lines.rows).toEqual([
      { capability: 'hello.greet', would_wait: false },
      { capability: 'messages.search', would_wait: true },
    ]);
    expect(run.status).toBe('done');
    await end(omar, created.body.session.id);
  });

  it('a turn the model could not finish closes the sandbox run as failed, not done', async () => {
    scripts.rehearse = [{ fail: true }, { fail: true }, { fail: true }];
    const created = await start(omar, 'rehearse', 'RHS hello?', 'sandboxed');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const s = await settleRehearsal(created.body.session.id);
    expect(of(s, 'reply')).toHaveLength(0);
    const run = await lastRun();
    expect(run.status).toBe('failed');
    await end(omar, created.body.session.id);
  });
});
