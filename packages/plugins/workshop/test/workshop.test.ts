import type { ProposalDetail, SetupSession } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { startFakeLlm, type FakeLlm } from '../../../../tools/fake-llm/src/server.ts';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// P7-02, P7-03, P7-04 (server): "Add a bot" through the real server, a real database and a model stand-in that answers with the tool calls a test scripts.
// What it proves: the helper's session runs as a detached job; the platform grades what the helper lists and asks one batched list of questions; propose_config refuses what is looser than
// the team's defaults and files proposals as the person; nothing is applied until Approve; describe_self shows only this team's things and no secret; a session is its owner's alone.

const { omar, nadia, lena } = personas;
vi.setConfig({ testTimeout: 120_000 });

/** `wait`: the model stand-in does not answer until this promise is settled (to cancel or look while the helper is in a model call). */
type Scripted = { name: string; args: unknown; wait?: Promise<unknown> };
type Answer = { status: number; body: unknown };
/** The next model answers, in order: each is one tool call (what the helper would choose). */
let script: Scripted[] = [];
/** Every request the model stand-in got: the conversation the helper saw. */
const seen: Array<Array<{ role: string; content: string }>> = [];
let w: RepoWorld;
let fake: FakeLlm;
const saved = { url: process.env['MANYTHREADS_LITELLM_URL'], key: process.env['MANYTHREADS_LITELLM_MASTER_KEY'] };

const toolCall = (s: Scripted): Answer => ({
  status: 200,
  body: {
    id: 'chatcmpl-setup',
    model: 'smart',
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${seen.length}`, type: 'function', function: { name: s.name, arguments: JSON.stringify(s.args) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  },
});

beforeAll(async () => {
  fake = await startFakeLlm({
    masterKey: 'sk-fake',
    completion: async ({ messages }) => {
      seen.push(messages);
      const next = script.shift();
      if (next?.wait) await next.wait;
      return next ? toolCall(next) : 'I am done.';
    },
  });
  process.env['MANYTHREADS_LITELLM_URL'] = fake.url;
  process.env['MANYTHREADS_LITELLM_MASTER_KEY'] = 'sk-fake';
  w = await createRepoWorld();
  const created = await w.call<{ provider: { id: string } }>(omar, 'POST', '/api/workspace/llm/providers', { name: 'OpenAI', kind: 'openai', apiKey: 'sk-provider-secret-7777' });
  const bound = await w.call(omar, 'PUT', '/api/workspace/llm/aliases/smart', { providerId: created.body.provider.id, model: 'gpt-4o', fallbacks: [] });
  expect(bound.status).toBe(200);
  // a save is pushed to the proxy a moment later: move it into the past instead of waiting
  await w.system(async (tx) => {
    await tx.query(`UPDATE app.llm_aliases SET updated_at = updated_at - interval '1 minute'`);
    await tx.query(`UPDATE app.llm_providers SET updated_at = updated_at - interval '1 minute'`);
  });
}, 180_000);

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

type Who = typeof omar;
const base = (team = 'engineering') => `/api/teams/${team}/setup/sessions`;
const start = (who: Who, brief: string, team = 'engineering') => w.call<{ session: SetupSession; error?: { message: string } }>(who, 'POST', base(team), { brief });
const read = (who: Who, id: string, team = 'engineering') => w.call<{ session: SetupSession }>(who, 'GET', `${base(team)}/${id}`);
const settled = async (who: Who, id: string, until: SetupSession['status'][] = ['asking', 'proposed', 'failed', 'cancelled'], team = 'engineering'): Promise<SetupSession> => {
  let last: SetupSession | undefined;
  await vi.waitFor(
    async () => {
      last = (await read(who, id, team)).body.session;
      expect(until).toContain(last.status);
    },
    { timeout: 60_000, interval: 250 },
  );
  return last as SetupSession;
};
/** Waits until no job of this session is queued or running: whatever the job was going to do, it has done. */
const jobsIdle = (id: string) =>
  vi.waitFor(
    async () => {
      const r = await w.system((tx) =>
        tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.jobs WHERE queue = 'workshop.setup' AND payload->>'sessionId' = $1 AND state IN ('ready', 'running')`, [id]),
      );
      expect(Number(r.rows[0]?.n)).toBe(0);
    },
    { timeout: 60_000, interval: 100 },
  );
const blobOf = async (path: string) => {
  const res = await w.call<{ content: string }>(omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`);
  return res.status === 200 ? res.body.content : null;
};
const proposalsOf = async (): Promise<Array<{ path: string; status: string }>> => {
  const res = await w.system((tx) => tx.query<{ path: string; status: string }>(`SELECT path, status FROM app.proposals ORDER BY created_at`));
  return res.rows;
};

const botMd = (name: string, extra = '') => `---
schema: 1
name: ${name}
role: Answers questions about the release checklist.
kind: agent
runtime: hermes
model:
  aliases: [smart]
triggers:
  - type: mention
capabilities:
  native: [messages.post]
${extra}---

You answer questions about the release checklist. If you do not know, say so and ask a person.
`;
const REQ = {
  post: { id: 'post', text: 'Answer in channels', kind: 'capability', name: 'messages.post' },
  mail: { id: 'mail', text: 'Read the support mailbox', kind: 'connection', name: 'mailbox' },
  tone: { id: 'tone', text: 'Friendly but short', kind: 'other' },
};

describe('the whole flow: brief, grades, one batch of questions, answers, a proposal that waits for Approve', () => {
  let sessionId = '';

  it('starts working, looks at the team, grades what it lists and asks every gap in one list', async () => {
    script = [
      { name: 'describe_self', args: {} },
      { name: 'ask_clarification', args: { summary: 'A release checklist helper.', requirements: [REQ.post, REQ.mail, REQ.tone] } },
    ];
    // something that exists only in another team, made before the helper looks
    const made = await w.call(personas.tariq, 'POST', '/api/teams/marketing/channels', { name: 'campaign-war-room' });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const created = await start(nadia, 'A bot that answers questions about our release checklist and reads the support mailbox.');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.session.status).toBe('working');
    sessionId = created.body.session.id;

    const asking = await settled(nadia, sessionId);
    expect(asking.status).toBe('asking');
    expect(Object.fromEntries(asking.requirements.map((r) => [r.id, r.grade]))).toEqual({ post: 'covered', mail: 'missing', tone: 'unclear' });
    // one question for each gap, none for what is covered, all in one batch
    expect(asking.questions.map((q) => q.requirementId)).toEqual(['mail', 'tone']);
    expect(asking.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(asking.inventory?.team.slug).toBe('engineering');
    expect(await proposalsOf()).toEqual([]);
  });

  it('describe_self showed this team only, and no secret, address or key', async () => {
    const shown = seen.at(-1)!.find((m) => m.role === 'tool' && m.content.includes('"inventory"'));
    expect(shown, 'the helper read the inventory').toBeDefined();
    const text = shown!.content;
    const inventory = (JSON.parse(text) as { inventory: { team: { slug: string }; channels: Array<{ name: string }>; bots: Array<{ slug: string }> } }).inventory;
    expect(inventory.team.slug).toBe('engineering');

    // what exists only in other teams must not be in it: Marketing gets a channel of its own
    const other = await w.system((tx) =>
      tx.query<{ name: string }>(`SELECT c.name FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug <> 'engineering' AND c.name NOT IN (SELECT name FROM app.channels WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering'))`),
    );
    expect(other.rows.length).toBeGreaterThan(0);
    for (const row of other.rows) expect(inventory.channels.map((c) => c.name)).not.toContain(row.name);
    const otherBots = await w.system((tx) => tx.query<{ slug: string }>(`SELECT b.slug FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug <> 'engineering'`));
    for (const row of otherBots.rows) expect(inventory.bots.map((b) => b.slug)).not.toContain(row.slug);

    expect(text).not.toContain('sk-provider-secret');
    expect(text).not.toContain('sk-fake');
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/api[_-]?key|secret|password|token/i);
  });

  it('is nobody else\'s to read, answer or cancel', async () => {
    expect((await read(omar, sessionId)).status).toBe(404);
    expect((await w.call(omar, 'POST', `${base()}/${sessionId}/answers`, { answers: [{ questionId: 'q1', text: 'x' }] })).status).toBe(404);
    expect((await w.call(omar, 'POST', `${base()}/${sessionId}/cancel`, {})).status).toBe(404);
  });

  it('needs an answer to every question', async () => {
    const part = await w.call<{ error: { message: string } }>(nadia, 'POST', `${base()}/${sessionId}/answers`, { answers: [{ questionId: 'q1', text: 'Leave it out' }] });
    expect(part.status).toBe(400);
    const wrong = await w.call(nadia, 'POST', `${base()}/${sessionId}/answers`, { answers: [{ questionId: 'q1', text: 'a' }, { questionId: 'q9', text: 'b' }] });
    expect(wrong.status).toBe(400);
    expect((await read(nadia, sessionId)).body.session.status).toBe('asking');
  });

  it('refuses a looser bot, tells the helper why, and files nothing; then files the proposal when the helper fixes it', async () => {
    script = [
      // a shell the team has not allowed: refused
      { name: 'propose_config', args: { slug: 'release-helper', name: 'Release helper', botMd: botMd('Release helper').replace('  native: [messages.post]', '  native: [messages.post]\n  runtime: [shell]'), requirements: [REQ.post, REQ.mail, REQ.tone] } },
      // fixed: no shell
      { name: 'propose_config', args: { slug: 'release-helper', name: 'Release helper', summary: 'Answers release checklist questions.', botMd: botMd('Release helper'), requirements: [REQ.post, REQ.mail, REQ.tone] } },
    ];
    const answered = await w.call<{ session: SetupSession }>(nadia, 'POST', `${base()}/${sessionId}/answers`, {
      answers: [{ questionId: 'q1', text: 'Leave the mailbox out for now' }, { questionId: 'q2', text: 'Short answers' }],
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.session.status).toBe('working');

    const done = await settled(nadia, sessionId);
    expect(done.status, done.message ?? '').toBe('proposed');
    // the helper heard the refusal in words that name the problem
    const refusal = seen.flat().find((m) => m.role === 'tool' && m.content.includes('is refused'));
    expect(refusal?.content).toMatch(/shell/);
    // exactly one proposal was filed, and it is the bot; it waits
    expect(done.proposals.map((p) => [p.path, p.role])).toEqual([['bots/release-helper/BOT.md', 'bot']]);
    expect(await proposalsOf()).toEqual([{ path: 'bots/release-helper/BOT.md', status: 'open' }]);
    expect(done.limits.join(' ')).toMatch(/mailbox/);
  });

  it('applied nothing: no file, no bot, until a person with the right approves', async () => {
    expect(await blobOf('bots/release-helper/BOT.md')).toBeNull();
    expect((await w.call(omar, 'GET', '/api/teams/engineering/bots/release-helper')).status).toBe(404);
    const done = (await read(nadia, sessionId)).body.session;
    const proposalId = done.proposals[0]!.proposalId;
    // the author is the person, not the helper and not a bot
    const detail = await w.call<{ proposal: ProposalDetail }>(omar, 'GET', `/api/teams/engineering/proposals/${proposalId}`);
    expect(detail.body.proposal.proposal.authorId).toBe(nadia.actorId);
    // a member cannot approve their own; an admin can, and then the bot exists
    expect((await w.call(nadia, 'POST', `/api/teams/engineering/proposals/${proposalId}/approve`, {})).status).toBe(403);
    const approved = await w.call(omar, 'POST', `/api/teams/engineering/proposals/${proposalId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await blobOf('bots/release-helper/BOT.md')).toContain('Release helper');
  });
});

describe('what a member may not ask for', () => {
  it('a name that is taken and a runner the team may not use are each refused', async () => {
    // the bot the first flow created is on the roster once the loader has read it
    await vi.waitFor(async () => expect((await w.call(omar, 'GET', '/api/teams/engineering/bots/release-helper')).status).toBe(200), { timeout: 30_000, interval: 250 });
    script = [
      { name: 'ask_clarification', args: { requirements: [REQ.post] } },
      { name: 'propose_config', args: { slug: 'release-helper', name: 'Again', botMd: botMd('Again') } },
      { name: 'propose_config', args: { slug: 'on-a-box', name: 'On a box', botMd: botMd('On a box', 'placement:\n  runs_on: private-gpu-box\n') } },
      { name: 'ask_clarification', args: { requirements: [REQ.tone] } },
    ];
    const before = (await proposalsOf()).length;
    const mark = seen.length;
    const created = await start(nadia, 'Try things the team does not allow.');
    expect(created.status).toBe(201);
    const s = await settled(nadia, created.body.session.id, ['asking', 'proposed', 'failed']);
    const told = seen.slice(mark).flat().filter((m) => m.role === 'tool' && m.content.includes('"refusals"')).map((m) => m.content);
    expect(told.join('\n')).toMatch(/already has a bot called/);
    expect(told.join('\n')).toMatch(/runs_on|runner/i);
    expect(await proposalsOf()).toHaveLength(before);
    expect(['asking', 'failed']).toContain(s.status);
    // leave nothing open: the next tests count a person's open conversations
    await w.call(nadia, 'POST', `${base()}/${created.body.session.id}/cancel`, {});
    await jobsIdle(created.body.session.id);
  });
});

describe('the door', () => {
  it('a guest cannot start one, and a brief that is too short is refused', async () => {
    expect((await start(lena, 'A bot for the release checklist.')).status).toBe(403);
    expect((await w.call(nadia, 'POST', base(), { brief: 'x' })).status).toBe(400);
    expect((await w.call(nadia, 'POST', base(), { brief: 'A real brief for a bot', extra: 1 })).status).toBe(400);
  });

  it('can be cancelled, and a cancelled one stays cancelled', async () => {
    script = [{ name: 'describe_self', args: {} }];
    const created = await start(omar, 'A bot that does something I will cancel.');
    expect(created.status).toBe(201);
    const cancelled = await w.call<{ session: SetupSession }>(omar, 'POST', `${base()}/${created.body.session.id}/cancel`, {});
    expect(cancelled.body.session.status).toBe('cancelled');
    // the queued job has run to its end (it found the session cancelled and did nothing), and the session is still cancelled
    await jobsIdle(created.body.session.id);
    expect((await read(omar, created.body.session.id)).body.session.status).toBe('cancelled');
  });

  it('a person has at most three open at once', async () => {
    script = [];
    const open: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      script.push({ name: 'ask_clarification', args: { requirements: [REQ.tone] } });
    }
    for (let i = 0; i < 3; i += 1) {
      const r = await start(nadia, `Open conversation number ${i} for the limit.`);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      open.push(r.body.session.id);
    }
    const fourth = await start(nadia, 'One conversation too many here.');
    expect(fourth.status).toBe(409);
    for (const id of open) {
      await w.call(nadia, 'POST', `${base()}/${id}/cancel`, {});
      await jobsIdle(id);
    }
  });
});

describe('a hostile helper cannot skip the questions or launder a gap', () => {
  it('a proposal before any grading is refused; a gap listed again as something covered stays in the limits', async () => {
    const before = (await proposalsOf()).length;
    const mark = seen.length;
    script = [
      { name: 'propose_config', args: { slug: 'sneaky', name: 'Sneaky', botMd: botMd('Sneaky'), requirements: [REQ.post] } },
      { name: 'ask_clarification', args: { requirements: [REQ.post, REQ.mail, REQ.tone] } },
    ];
    const created = await start(nadia, 'A bot that skips the questions and calls its gaps covered.');
    expect(created.status).toBe(201);
    const asking = await settled(nadia, created.body.session.id);
    expect(asking.status, asking.message ?? '').toBe('asking');
    expect(seen.slice(mark).flat().some((m) => m.role === 'tool' && m.content.includes('Call ask_clarification first'))).toBe(true);
    expect(await proposalsOf()).toHaveLength(before);
    expect(asking.questions.map((q) => q.requirementId)).toEqual(['mail', 'tone']);

    // after the answers the helper lists the same ids again, now as things that look covered
    script = [
      {
        name: 'propose_config',
        args: {
          slug: 'sneaky',
          name: 'Sneaky',
          botMd: botMd('Sneaky'),
          requirements: [
            { id: 'mail', text: 'Read the support mailbox', kind: 'trigger', name: 'mention' },
            { id: 'tone', text: 'Friendly but short', kind: 'trigger', name: 'conversation' },
          ],
        },
      },
    ];
    const answered = await w.call<{ session: SetupSession }>(nadia, 'POST', `${base()}/${created.body.session.id}/answers`, {
      answers: [{ questionId: 'q1', text: 'Leave it out' }, { questionId: 'q2', text: 'Short' }],
    });
    expect(answered.status).toBe(200);
    const done = await settled(nadia, created.body.session.id);
    expect(done.status, `${done.message ?? ''} ${(seen.at(-1) ?? []).filter((m) => m.role === 'tool').at(-1)?.content ?? ''}`).toBe('proposed');
    // the platform's grades of the first listing stand; the new entries were added next to them under their own ids
    const byId = Object.fromEntries(done.requirements.map((r) => [r.id, `${r.kind}:${r.grade}`]));
    expect(byId['mail']).toBe('connection:missing');
    expect(byId['tone']).toBe('other:unclear');
    expect(done.limits.join(' ')).toMatch(/mailbox/);
    expect(done.limits.join(' ')).toMatch(/Friendly/);
    await w.call(omar, 'POST', `/api/teams/engineering/proposals/${done.proposals[0]!.proposalId}/reject`, {});
  });
});

describe('the files that come with a bot: a skill and a TEAM.md change', () => {
  it('an admin gets three proposals (bot, skill, team file); each is applied only by Approve, and the defaults are untouched', async () => {
    const team = await blobOf('TEAM.md');
    expect(team).not.toBeNull();
    const changed = `${team}\n## Release helper\n\nThe release helper answers questions about the checklist.\n`;
    script = [
      { name: 'ask_clarification', args: { requirements: [REQ.post] } },
      {
        name: 'propose_config',
        args: {
          slug: 'checklist-bot',
          name: 'Checklist bot',
          summary: 'Answers checklist questions with a starter skill.',
          botMd: botMd('Checklist bot', 'skills:\n  - triage\n'),
          skills: [{ slug: 'triage', text: '# Triage\n\nRead the question, find the step, answer in one sentence.\n' }],
          teamMd: changed,
        },
      },
    ];
    const created = await start(omar, 'A checklist bot with a starter skill and a note in the team file.');
    const done = await settled(omar, created.body.session.id);
    expect(done.status, done.message ?? '').toBe('proposed');
    expect(done.proposals.map((p) => [p.role, p.path])).toEqual([
      ['bot', 'bots/checklist-bot/BOT.md'],
      ['skill', 'skills/triage/SKILL.md'],
      ['team', 'TEAM.md'],
    ]);
    // nothing is in the repo yet
    expect(await blobOf('skills/triage/SKILL.md')).toBeNull();
    expect(await blobOf('TEAM.md')).toBe(team);
    // Approve the skill and the team file (the bot is left waiting)
    for (const role of ['skill', 'team'] as const) {
      const ref = done.proposals.find((p) => p.role === role)!;
      const ok = await w.call(omar, 'POST', `/api/teams/engineering/proposals/${ref.proposalId}/approve`, {});
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    }
    expect(await blobOf('skills/triage/SKILL.md')).toContain('# Triage');
    expect(await blobOf('TEAM.md')).toBe(changed);
    expect((await w.call(omar, 'GET', '/api/teams/engineering/bots/checklist-bot')).status).toBe(404);
    await w.call(omar, 'POST', `/api/teams/engineering/proposals/${done.proposals[0]!.proposalId}/reject`, {});
  });

  it('a member may not change TEAM.md through the helper, and a change that touches the defaults is refused even for an admin', async () => {
    const mark = seen.length;
    const team = (await blobOf('TEAM.md')) as string;
    const loosened = team.replace('defaults:', 'defaults:\n  botRuntime: [shell]');
    expect(loosened).not.toBe(team);
    script = [
      { name: 'ask_clarification', args: { requirements: [REQ.post] } },
      { name: 'propose_config', args: { slug: 'tm-member', name: 'Tm member', botMd: botMd('Tm member'), teamMd: `${team}\nmore\n` } },
    ];
    const member = await start(nadia, 'A bot that also wants a change in the team file.');
    await settled(nadia, member.body.session.id, ['asking', 'proposed', 'failed']);
    script = [
      { name: 'ask_clarification', args: { requirements: [REQ.post] } },
      { name: 'propose_config', args: { slug: 'tm-admin', name: 'Tm admin', botMd: botMd('Tm admin'), teamMd: loosened } },
    ];
    const admin = await start(omar, 'A bot that wants the team to allow a shell.');
    await settled(omar, admin.body.session.id, ['asking', 'proposed', 'failed']);
    const told = seen.slice(mark).flat().filter((m) => m.role === 'tool' && m.content.includes('"refusals"')).map((m) => m.content).join('\n');
    expect(told).toMatch(/Only a team lead or an admin may change TEAM\.md/);
    expect(told).toMatch(/cannot change which tools/);
    expect((await proposalsOf()).filter((p) => p.path.startsWith('bots/tm-'))).toEqual([]);
  });
});

describe('one proposal for one file', () => {
  it('a skill listed twice is refused, and a bot name that already has an open proposal is refused', async () => {
    const mark = seen.length;
    script = [
      { name: 'ask_clarification', args: { requirements: [REQ.post] } },
      { name: 'propose_config', args: { slug: 'dup-bot', name: 'Dup bot', botMd: botMd('Dup bot', 'skills:\n  - one\n'), skills: [{ slug: 'one', text: 'a' }, { slug: 'one', text: 'b' }] } },
      { name: 'propose_config', args: { slug: 'dup-bot', name: 'Dup bot', botMd: botMd('Dup bot') } },
    ];
    const first = await start(omar, 'The first of two bots with one name.');
    const firstDone = await settled(omar, first.body.session.id);
    expect(firstDone.status, firstDone.message ?? '').toBe('proposed');
    expect(firstDone.proposals).toHaveLength(1);
    expect(seen.slice(mark).flat().some((m) => m.role === 'tool' && m.content.includes('listed twice'))).toBe(true);

    const mark2 = seen.length;
    script = [
      { name: 'ask_clarification', args: { requirements: [REQ.post] } },
      { name: 'propose_config', args: { slug: 'dup-bot', name: 'Dup bot again', botMd: botMd('Dup bot again') } },
    ];
    const second = await start(omar, 'The second bot that wants the same name.');
    await settled(omar, second.body.session.id, ['asking', 'proposed', 'failed']);
    const told = seen.slice(mark2).flat().filter((m) => m.role === 'tool' && m.content.includes('"refusals"')).map((m) => m.content).join('\n');
    expect(told).toMatch(/bots\/dup-bot\/BOT\.md is already waiting/);
    expect((await proposalsOf()).filter((p) => p.path === 'bots/dup-bot/BOT.md')).toHaveLength(1);
    await w.call(omar, 'POST', `/api/teams/engineering/proposals/${firstDone.proposals[0]!.proposalId}/reject`, {});
  });
});

describe('a failure while filing leaves nothing behind', () => {
  it('a skill the proposals plugin refuses takes the bot proposal back with it; the fixed call then files exactly one', async () => {
    const before = (await proposalsOf()).length;
    const mark = seen.length;
    script = [
      { name: 'ask_clarification', args: { requirements: [REQ.post] } },
      // a NUL byte passes the helper's own checks and is refused by the proposals plugin, after the bot's proposal was made in the same transaction
      { name: 'propose_config', args: { slug: 'atomic-bot', name: 'Atomic bot', botMd: botMd('Atomic bot', 'skills:\n  - bad\n'), skills: [{ slug: 'bad', text: 'a\u0000b' }] } },
      { name: 'propose_config', args: { slug: 'atomic-bot', name: 'Atomic bot', botMd: botMd('Atomic bot') } },
    ];
    const created = await start(omar, 'A bot whose first filing fails half way through.');
    const done = await settled(omar, created.body.session.id);
    expect(done.status, done.message ?? '').toBe('proposed');
    const tools = seen.slice(mark).flat().filter((m) => m.role === 'tool').map((m) => m.content);
    expect(tools.some((t) => /did not work|NUL|text only/.test(t))).toBe(true);
    // exactly one new proposal: the second, fixed call. (Had the first left its bot proposal, the second would have been refused as a second proposal for the file.)
    expect(await proposalsOf()).toHaveLength(before + 1);
    expect(done.proposals.map((p) => p.path)).toEqual(['bots/atomic-bot/BOT.md']);
    await w.call(omar, 'POST', `/api/teams/engineering/proposals/${done.proposals[0]!.proposalId}/reject`, {});
  });
});

describe('cancel while the helper is in a model call', () => {
  it('a question that comes back after the cancel is dropped, and a proposal that comes back after it is never filed', async () => {
    // 1. asking
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = (await proposalsOf()).length;
    script = [{ name: 'ask_clarification', args: { requirements: [REQ.mail] }, wait: gate }];
    let calls = seen.length;
    const asked = await start(omar, 'Cancel me while the model is still thinking.');
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(calls), { timeout: 30_000, interval: 50 });
    expect((await w.call<{ session: SetupSession }>(omar, 'POST', `${base()}/${asked.body.session.id}/cancel`, {})).body.session.status).toBe('cancelled');
    release();
    await jobsIdle(asked.body.session.id);
    const afterAsk = (await read(omar, asked.body.session.id)).body.session;
    expect(afterAsk.status).toBe('cancelled');
    expect(afterAsk.questions).toEqual([]);

    // 2. proposing
    let release2!: () => void;
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    script = [
      { name: 'ask_clarification', args: { requirements: [REQ.post] } },
      { name: 'propose_config', args: { slug: 'late-bot', name: 'Late bot', botMd: botMd('Late bot') }, wait: gate2 },
    ];
    calls = seen.length;
    const proposing = await start(omar, 'Cancel me just before the proposal is filed.');
    // the second model call is the one that waits
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(calls + 2), { timeout: 30_000, interval: 50 });
    await w.call(omar, 'POST', `${base()}/${proposing.body.session.id}/cancel`, {});
    release2();
    await jobsIdle(proposing.body.session.id);
    const afterPropose = (await read(omar, proposing.body.session.id)).body.session;
    expect(afterPropose.status).toBe('cancelled');
    expect(afterPropose.proposals).toEqual([]);
    expect(await proposalsOf()).toHaveLength(before);
  });
});

describe('two answers at once', () => {
  it('one wins and the other is told the conversation is not waiting (409)', async () => {
    script = [{ name: 'ask_clarification', args: { requirements: [REQ.tone] } }];
    const created = await start(omar, 'A bot with one open question that two tabs answer.');
    const asking = await settled(omar, created.body.session.id);
    expect(asking.status).toBe('asking');
    script = [];
    const answer = () => w.call(omar, 'POST', `${base()}/${created.body.session.id}/answers`, { answers: [{ questionId: 'q1', text: 'Short answers' }] });
    const results = await Promise.all([answer(), answer()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await w.call(omar, 'POST', `${base()}/${created.body.session.id}/cancel`, {});
    await jobsIdle(created.body.session.id);
  });
});

describe('open conversations', () => {
  it('six starts at the same moment let exactly three through', async () => {
    script = Array.from({ length: 6 }, () => ({ name: 'ask_clarification', args: { requirements: [REQ.tone] } }));
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => start(personas.priya, `Parallel conversation number ${String(i)} to test the limit.`)));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([201, 201, 201, 409, 409, 409]);
    for (const r of results) {
      if (r.status === 201) {
        await w.call(personas.priya, 'POST', `${base()}/${r.body.session.id}/cancel`, {});
        await jobsIdle(r.body.session.id);
      }
    }
  });

  it('a conversation the helper never finished is turned into a plain failure after ten minutes, and does not count against the limit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    script = [{ name: 'ask_clarification', args: { requirements: [REQ.tone] }, wait: gate }];
    const calls = seen.length;
    const stuck = await start(nadia, 'A conversation whose helper never comes back.');
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(calls), { timeout: 30_000, interval: 50 });
    // not stuck yet: ten minutes have not passed
    expect((await read(nadia, stuck.body.session.id)).body.session.status).toBe('working');
    await w.system((tx) => tx.query(`UPDATE app.setup_sessions SET updated_at = now() - interval '11 minutes' WHERE id = $1`, [stuck.body.session.id]));
    const swept = (await read(nadia, stuck.body.session.id)).body.session;
    expect(swept.status).toBe('failed');
    expect(swept.message).toMatch(/stopped answering/);
    // the dead helper's late answer changes nothing
    release();
    await jobsIdle(stuck.body.session.id);
    expect((await read(nadia, stuck.body.session.id)).body.session.status).toBe('failed');
  });
});

describe('Try again after a failure', () => {
  const retry = (who: Who, id: string) => w.call<{ session: SetupSession; error?: { message: string } }>(who, 'POST', `${base()}/${id}/retry`, {});
  const ROLE = 'Reads new pull request posts in #dev and replies: with a first review';

  it('runs the last round again from the stored answers, in the same conversation, and the proposal stores the role exactly', async () => {
    script = [
      { name: 'describe_self', args: {} },
      { name: 'ask_clarification', args: { requirements: [REQ.post, REQ.mail, REQ.tone] } },
    ];
    const created = await start(nadia, 'A bot that reads the pull request posts in the dev channel and replies.');
    const id = created.body.session.id;
    const asking = await settled(nadia, id);
    expect(asking.status).toBe('asking');

    // not failed yet: nothing to try again
    expect((await retry(nadia, id)).status).toBe(409);

    // the answers go in, and the model has nothing scripted: the helper gives up with a plain sentence
    script = [];
    await w.call(nadia, 'POST', `${base()}/${id}/answers`, { answers: [{ questionId: 'q1', text: 'Skip email' }, { questionId: 'q2', text: 'Short answers' }] });
    const failed = await settled(nadia, id);
    expect(failed.status).toBe('failed');
    expect(failed.answers).toHaveLength(2);
    await jobsIdle(id);

    // only its owner may try again; nobody else learns the conversation exists (a guest is stopped at the door)
    expect((await retry(lena, id)).status).toBe(403);
    expect((await retry(omar, id)).status).toBe(404);

    // the model can answer now
    script = [{ name: 'propose_config', args: { slug: 'dev-reviewer', name: 'Dev reviewer', role: ROLE, botMd: botMd('Dev reviewer'), requirements: [REQ.post, REQ.mail, REQ.tone] } }];
    const again = await retry(nadia, id);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.session.id).toBe(id);
    expect(again.body.session.status).toBe('working');
    expect(again.body.session.message).toBeNull();

    const done = await settled(nadia, id);
    expect(done.status, done.message ?? '').toBe('proposed');
    // nothing was asked a second time and the answers are the ones the person gave
    expect(done.answers.map((a) => a.answer)).toEqual(['Skip email', 'Short answers']);
    expect(done.limits.every((l) => l.startsWith('You decided'))).toBe(true);
    expect(done.limits.join(' ')).toContain('Skip email');
    // a conversation that finished cannot be tried again
    expect((await retry(nadia, id)).status).toBe(409);

    // the helper's calls are named on the Spend page by what they were for
    const lines = await w.system((tx) => tx.query<{ purpose: string | null; bot_id: string | null }>(`SELECT purpose, bot_id FROM app.llm_spend WHERE session_id = $1`, [id]));
    expect(lines.rows.length).toBeGreaterThan(2);
    expect(lines.rows.every((r) => r.purpose === 'setup' && r.bot_id === null)).toBe(true);

    // the role is stored as proposed, `#` and `: ` included, once the bot is approved
    const proposalId = done.proposals[0]!.proposalId;
    expect((await w.call(omar, 'POST', `/api/teams/engineering/proposals/${proposalId}/approve`, {})).status).toBe(200);
    const stored = (await blobOf('bots/dev-reviewer/BOT.md')) ?? '';
    const front = parseYaml(stored.split('---')[1] as string) as { role?: string; name?: string };
    expect(front.role).toBe(ROLE);
    expect(front.name).toBe('Dev reviewer');
  });

  it('a conversation that keeps stopping can be tried again three times, then the person is told to start a new one', async () => {
    script = [{ name: 'describe_self', args: {} }, { name: 'ask_clarification', args: { requirements: [REQ.tone] } }];
    const created = await start(personas.tariq, 'A bot for marketing that cannot get an answer from the model.', 'marketing');
    const id = created.body.session.id;
    await settled(personas.tariq, id, ['asking'], 'marketing');
    script = [];
    await w.call(personas.tariq, 'POST', `${base('marketing')}/${id}/answers`, { answers: [{ questionId: 'q1', text: 'ok' }] });
    await settled(personas.tariq, id, ['failed'], 'marketing');
    await jobsIdle(id);
    const again = () => w.call<{ session: SetupSession; error?: { message: string } }>(personas.tariq, 'POST', `${base('marketing')}/${id}/retry`, {});
    for (let i = 1; i <= 3; i += 1) {
      const r = await again();
      expect(r.status, `try ${String(i)}: ${JSON.stringify(r.body)}`).toBe(200);
      await settled(personas.tariq, id, ['failed'], 'marketing');
      await jobsIdle(id);
    }
    const fourth = await again();
    expect(fourth.status).toBe(409);
    expect(fourth.body.error?.message).toMatch(/tried again 3 times/);
    expect(fourth.body.error?.message).toMatch(/Start a new one/);
    const row = await w.system((tx) => tx.query<{ status: string; retries: number }>('SELECT status, retries FROM app.setup_sessions WHERE id = $1', [id]));
    expect(row.rows[0]).toEqual({ status: 'failed', retries: 3 });
  });

  it('refuses a retry when the person already has three open conversations', async () => {
    script = [{ name: 'describe_self', args: {} }, { name: 'ask_clarification', args: { requirements: [REQ.tone] } }];
    const first = await start(personas.tariq, 'A bot for marketing whose helper will fail soon.', 'marketing');
    await settled(personas.tariq, first.body.session.id, ['asking'], 'marketing');
    await w.call(personas.tariq, 'POST', `${base('marketing')}/${first.body.session.id}/answers`, { answers: [{ questionId: 'q1', text: 'ok' }] });
    script = [];
    expect((await settled(personas.tariq, first.body.session.id, ['failed'], 'marketing')).status).toBe('failed');
    await jobsIdle(first.body.session.id);
    // three more open ones: the failed one cannot come back to life past the limit
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    script = Array.from({ length: 6 }, () => ({ name: 'describe_self', args: {}, wait: gate }));
    const open: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const made = await start(personas.tariq, `Another conversation number ${String(i)} that stays open.`, 'marketing');
      expect(made.status).toBe(201);
      open.push(made.body.session.id);
    }
    const refused = await w.call<{ error: { message: string } }>(personas.tariq, 'POST', `${base('marketing')}/${first.body.session.id}/retry`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/already have/);
    // the failed conversation is still there and still failed
    expect((await w.call<{ session: SetupSession }>(personas.tariq, 'GET', `${base('marketing')}/${first.body.session.id}`)).body.session.status).toBe('failed');
    // let the waiting model calls go and stop the conversations
    release();
    script = [];
    for (const id of open) await w.call(personas.tariq, 'POST', `${base('marketing')}/${id}/cancel`, {});
    for (const id of open) await jobsIdle(id);
  });
});

describe('a team whose defaults cannot be read', () => {
  it('gets no proposal from the helper, and the helper is told why', async () => {
    const broken = '---\nname: Marketing\ndefaults:\n  guardPreset: lax\n---\n\n# Marketing\n';
    const wrote = await w.commitRaw(omar, 'marketing', [{ op: 'put', path: 'TEAM.md', content: broken }], 'break the defaults');
    expect(wrote.status, JSON.stringify(wrote.body)).toBeLessThan(300);
    const before = (await proposalsOf()).length;
    const mark = seen.length;
    script = [
      { name: 'describe_self', args: {} },
      { name: 'ask_clarification', args: { requirements: [REQ.post] } },
      { name: 'propose_config', args: { slug: 'mk-bot', name: 'Mk bot', botMd: botMd('Mk bot') } },
    ];
    const created = await start(personas.tariq, 'A bot for a team whose team file has a typo in it.', 'marketing');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await settled(personas.tariq, created.body.session.id, ['asking', 'proposed', 'failed'], 'marketing');
    const told = seen.slice(mark).flat().filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
    expect(told).toMatch(/can't be read/);
    // describe_self showed the strictest values, never the loosest
    expect(told).toMatch(/"guardDefault":"air-gapped"/);
    expect(told).toMatch(/"runtimeAllowed":\[\]/);
    expect(await proposalsOf()).toHaveLength(before);
  });
});
