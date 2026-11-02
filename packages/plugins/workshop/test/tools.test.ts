import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { SETUP_MAX_ROUNDS, SetupInventory } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { helperView } from '../src/inventory.ts';
import { TOOL_ANSWER_MAX_CHARS, runTool, type SessionState, type ToolEnv } from '../src/tools.ts';
import { UNREADABLE_DEFAULTS_MESSAGE } from '../src/team-defaults.ts';
import { GOOD_BOT_MD, inventory } from './fixtures.ts';

// P7-02, P7-03: the four tools as the helper meets them, with a hostile model in mind: the tools are called with the arguments a model chose, against a stub of the platform (no database).
// The server tests (workshop.test.ts) run the same rules end to end; these pin the order of the steps and what the helper is told.

const TOOLS = ['describe_self', 'knowledge_search', 'ask_clarification', 'propose_config'] as const;

interface Stub {
  env: ToolEnv;
  invoked: Array<{ capability: string; input: Record<string, unknown> }>;
  /** Paths for which the stub says "an open proposal already exists". */
  waiting: string[];
  failWith?: { capability: string; message: string };
}

function stub(over: Partial<SessionState> = {}, inv = inventory()): Stub {
  const invoked: Stub['invoked'] = [];
  const s: Stub = { invoked, waiting: [], env: undefined as never };
  const tx = {
    query: (sql: string, args: unknown[] = []) => {
      if (sql.includes('FROM app.proposals')) return Promise.resolve({ rows: s.waiting.filter((p) => (args[1] as string[]).includes(p)).map((path) => ({ path })) });
      // the session row is still "working": the final write finds it
      return Promise.resolve({ rows: [{ id: 'row' }] });
    },
  } as unknown as PluginTx;
  const ctx = {
    runs: {
      invoke: (_tx: PluginTx, capability: string, input: Record<string, unknown>) => {
        invoked.push({ capability, input });
        if (s.failWith?.capability === capability) return Promise.resolve({ ok: false, message: s.failWith.message });
        return Promise.resolve({ ok: true, proposal: { id: `p${String(invoked.length)}`, path: String(input['path']), status: 'open', checks: [] } });
      },
      catalog: () => [],
    },
    providers: { get: () => undefined },
  } as unknown as PluginContext;
  const state: SessionState = {
    sessionId: 's1',
    brief: 'a bot',
    name: null,
    requirements: [],
    questions: [],
    answers: [],
    inventory: inv,
    proposals: [],
    limits: [],
    rounds: 0,
    message: null,
    defaultsUnreadable: false,
    ...over,
  };
  s.env = {
    ctx,
    team: { id: 't1', slug: 'engineering', name: 'Engineering', workspaceId: 'w1' },
    state,
    asker: (fn) => fn(tx),
    system: (fn) => fn(tx),
  };
  return s;
}

const call = (s: Stub, name: string, args: unknown) => runTool(s.env, TOOLS, name, JSON.stringify(args));
const REQ = {
  post: { id: 'post', text: 'Answer in channels', kind: 'capability', name: 'messages.post' },
  mail: { id: 'mail', text: 'Read the mailbox', kind: 'connection', name: 'mailbox' },
};
const proposal = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, name: 'Helper', botMd: GOOD_BOT_MD, ...extra });
const said = (r: { answer: Record<string, unknown> }): string => JSON.stringify(r.answer);

describe('propose_config before anything was graded', () => {
  it('is refused: nothing is filed until ask_clarification has graded the requirements, and requirements listed with the proposal do not count', async () => {
    const s = stub();
    const first = await call(s, 'propose_config', proposal('a-bot', { requirements: [REQ.post] }));
    expect(first.answer['ok']).toBe(false);
    expect(said(first)).toContain('Call ask_clarification first');
    expect(first.end).toBeUndefined();
    expect(s.invoked).toEqual([]);
    expect(s.env.state.requirements).toEqual([]);
    // the same after the helper tries again with a longer list
    const second = await call(s, 'propose_config', proposal('a-bot', { requirements: [REQ.post, REQ.mail] }));
    expect(said(second)).toContain('Call ask_clarification first');
    expect(s.invoked).toEqual([]);
  });

  it('is allowed after an ask_clarification that found no gap (the grading is recorded, there is nothing to ask)', async () => {
    const s = stub();
    const asked = await call(s, 'ask_clarification', { requirements: [REQ.post] });
    expect(asked.answer['ok']).toBe(false);
    expect(said(asked)).toContain('nothing to ask');
    expect(s.env.state.requirements.map((r) => r.grade)).toEqual(['covered']);
    const made = await call(s, 'propose_config', proposal('a-bot'));
    expect(made.answer['ok'], said(made)).toBe(true);
    expect(made.end).toBe('proposed');
    expect(s.invoked.map((i) => i.input['path'])).toEqual(['bots/a-bot/BOT.md']);
  });
});

describe('a hostile listing', () => {
  async function withGap(): Promise<Stub> {
    const s = stub();
    const asked = await call(s, 'ask_clarification', { requirements: [REQ.post, REQ.mail] });
    expect(asked.end).toBe('asking');
    expect(s.env.state.questions.map((q) => q.requirementId)).toEqual(['mail']);
    // the person answered that question
    s.env.state.answers = [{ questionId: 'q1', requirementId: 'mail', question: 'q', answer: 'Leave it out' }];
    return s;
  }

  it('cannot turn a gap into covered by listing the same id as something else: the gap stays and the new entry is its own', async () => {
    const s = await withGap();
    const made = await call(s, 'propose_config', proposal('a-bot', { requirements: [{ id: 'mail', text: 'Read the mailbox', kind: 'knowledge', name: 'manuals' }] }));
    // the new entry is covered, so nothing is open: the proposal goes through, and the old gap is still in the limits
    expect(made.answer['ok'], said(made)).toBe(true);
    const byId = Object.fromEntries(s.env.state.requirements.map((r) => [r.id, [r.kind, r.grade]]));
    expect(byId['mail']).toEqual(['connection', 'missing']);
    expect(Object.keys(byId)).toHaveLength(3);
    expect(s.env.state.limits.join(' ')).toContain('Read the mailbox');
  });

  it('cannot hide a gap by listing it again, and a new gap under an old id is asked about before anything is filed', async () => {
    const s = await withGap();
    const again = await call(s, 'propose_config', proposal('a-bot', { requirements: [{ id: 'mail', text: 'Something else', kind: 'other' }] }));
    expect(again.answer['ok']).toBe(false);
    expect(said(again)).toContain('not been asked');
    expect(s.invoked).toEqual([]);
    const ids = s.env.state.requirements.map((r) => r.id);
    expect(ids).toContain('mail');
    expect(ids.some((id) => id.startsWith('mail-'))).toBe(true);
  });

  it('cannot make the list grow without end', async () => {
    const s = stub();
    for (let round = 0; round < 3; round += 1) {
      const many = Array.from({ length: 20 }, (_, i) => ({ id: `r${String(round)}-${String(i)}`, text: 'x', kind: 'trigger', name: 'conversation' }));
      await call(s, 'ask_clarification', { requirements: many });
    }
    const more = await call(s, 'ask_clarification', { requirements: [{ id: 'one-more', text: 'x', kind: 'trigger', name: 'conversation' }] });
    expect(more.answer['ok']).toBe(false);
    expect(said(more)).toContain('more than 60 requirements');
    expect(s.env.state.requirements).toHaveLength(60);
  });
});

describe('one file, one proposal', () => {
  it('a skill listed twice is refused', async () => {
    const s = stub({ requirements: [{ ...REQ.post, kind: 'capability', grade: 'covered', reason: 'ok' }] });
    const refused = await call(s, 'propose_config', proposal('a-bot', { skills: [{ slug: 'triage', text: 'one' }, { slug: 'triage', text: 'two' }] }));
    expect(said(refused)).toContain('listed twice');
    expect(s.invoked).toEqual([]);
  });

  it('a bot or a skill that already has an open proposal is refused', async () => {
    const s = stub({ requirements: [{ ...REQ.post, kind: 'capability', grade: 'covered', reason: 'ok' }] });
    s.waiting = ['bots/a-bot/BOT.md', 'skills/triage/SKILL.md'];
    const refused = await call(s, 'propose_config', proposal('a-bot', { skills: [{ slug: 'triage', text: 'steps' }] }));
    expect(refused.answer['ok']).toBe(false);
    const text = said(refused);
    expect(text).toContain('bots/a-bot/BOT.md is already waiting');
    expect(text).toContain('skills/triage/SKILL.md is already waiting');
    expect(s.invoked).toEqual([]);
  });
});

describe('a team whose defaults cannot be read', () => {
  it('gets no proposal, with a plain sentence that names the TEAM.md block', async () => {
    const s = stub({ defaultsUnreadable: true, requirements: [{ ...REQ.post, kind: 'capability', grade: 'covered', reason: 'ok' }] });
    const refused = await call(s, 'propose_config', proposal('a-bot'));
    expect(refused.answer['ok']).toBe(false);
    expect(refused.answer['message']).toBe(UNREADABLE_DEFAULTS_MESSAGE);
    expect(s.invoked).toEqual([]);
  });
});

describe('a filing that fails half way', () => {
  it('leaves no file of the set behind: the bot proposal is made inside the same transaction as the skill that fails, and the failure is thrown through it', async () => {
    const s = stub({ requirements: [{ ...REQ.post, kind: 'capability', grade: 'covered', reason: 'ok' }] });
    s.failWith = { capability: 'proposals.propose', message: 'The skill could not be proposed.' };
    let committed = true;
    // a transaction that records whether its function threw (a throw is a rollback)
    s.env.asker = async (fn) => {
      try {
        return await fn({ query: () => Promise.resolve({ rows: [] }) } as unknown as PluginTx);
      } catch (err) {
        committed = false;
        throw err;
      }
    };
    const result = await call(s, 'propose_config', proposal('a-bot', { skills: [{ slug: 'triage', text: 'steps' }] }));
    expect(result.answer['ok']).toBe(false);
    expect(said(result)).toContain('could not be proposed');
    expect(result.end).toBeUndefined();
    expect(committed).toBe(false);
    expect(s.env.state.proposals).toEqual([]);
  });
});

describe('describe_self on a big team', () => {
  const big = (): SetupInventory =>
    SetupInventory.parse(
      inventory({
        bots: Array.from({ length: 100 }, (_, i) => ({ slug: `bot-number-${String(i)}`, name: `A bot with a fairly long name ${String(i)}`, role: 'Answers questions about a long list of things for the team', kind: 'agent', runtime: 'hermes', status: 'active' })),
        capabilities: Array.from({ length: 300 }, (_, i) => ({ name: `namespace${String(i % 20)}.some_long_verb_${String(i)}`, destructive: i % 7 === 0 })),
        channels: Array.from({ length: 100 }, (_, i) => ({ name: `channel-${String(i)}` })),
        runtimeAllowed: ['files', 'browser'],
        guardDefault: 'customer-facing',
      }),
    );

  it('keeps who is asking, what the team allows, the default guard and the triggers whole, and cuts only long lists, saying how many', () => {
    const view = helperView(big(), TOOL_ANSWER_MAX_CHARS - 2000);
    const text = JSON.stringify({ ok: true, ...view });
    expect(text.length).toBeLessThan(TOOL_ANSWER_MAX_CHARS);
    // valid JSON from end to end
    expect(() => JSON.parse(text)).not.toThrow();
    const inv = view.inventory as Record<string, unknown[] | Record<string, unknown>>;
    expect(inv['asker']).toMatchObject({ role: 'lead', canGrantDestructive: true });
    expect(inv['runtimeAllowed']).toEqual(['files', 'browser']);
    expect(inv['guardDefault']).toBe('customer-facing');
    expect((inv['triggers'] as unknown[]).length).toBe(7);
    // the policy fields are the first keys, before any list
    expect(Object.keys(inv).slice(0, 4)).toEqual(['asker', 'runtimeAllowed', 'guardDefault', 'triggers']);
    // something was cut, and the answer says what
    expect(Object.keys(view.omitted).length).toBeGreaterThan(0);
    for (const [name, n] of Object.entries(view.omitted)) expect((inv[name] as unknown[]).length + n).toBe(((big() as unknown as Record<string, unknown[]>)[name] as unknown[]).length);
    // the short lists that matter stay whole
    expect(inv['runners']).toHaveLength(1);
    expect(inv['models']).toHaveLength(2);
  });

  it('a 60-bot team is cut only where it must be, and a small one not at all', () => {
    const sixty = SetupInventory.parse(inventory({ bots: big().bots.slice(0, 60), capabilities: big().capabilities }));
    const view = helperView(sixty, TOOL_ANSWER_MAX_CHARS - 2000);
    expect(JSON.stringify({ ok: true, ...view }).length).toBeLessThan(TOOL_ANSWER_MAX_CHARS);
    expect((view.inventory['asker'] as { role: string }).role).toBe('lead');
    expect(helperView(SetupInventory.parse(inventory()), TOOL_ANSWER_MAX_CHARS - 2000).omitted).toEqual({});
  });
});

describe('unknown tools', () => {
  it('a name that is not one of the four is refused and nothing runs', async () => {
    const s = stub();
    const r = await runTool(s.env, TOOLS, 'files_delete', '{}');
    expect(r.answer['ok']).toBe(false);
    expect(s.invoked).toEqual([]);
  });
});

/** The front matter of the BOT.md the helper's proposal carried, as a YAML reader stores it. */
const frontOf = (s: Stub): Record<string, unknown> => {
  const content = String(s.invoked.find((i) => String(i.input['path']).endsWith('BOT.md'))?.input['content']);
  return parseYaml(content.split('---')[1] as string) as Record<string, unknown>;
};

describe('the role and the name are stored exactly as proposed (found live: "#dev" was read as a comment)', () => {
  const ready = (): Stub => stub({ requirements: [{ ...REQ.post, kind: 'capability', grade: 'covered', reason: 'ok' }] });
  it.each([
    'Reads new pull request posts in #dev and replies with a first review',
    'Answers: briefly, and says "I do not know" when unsure',
    '- first look, then reply',
    '* all channels',
    '> quoted start',
    '& more',
    '! urgent',
    '% done',
    '@team first',
    'Antwortet auf Fragen: überprüft 日本語 ✓ #wichtig',
  ])('keeps %j whole', async (role) => {
    const s = ready();
    const made = await call(s, 'propose_config', proposal('a-bot', { role, name: 'Name: with # and "quotes"' }));
    expect(made.answer['ok'], said(made)).toBe(true);
    const front = frontOf(s);
    expect(String(front['role']).replace(/\s+/g, ' ')).toBe(role.replace(/\s+/g, ' '));
    expect(front['name']).toBe('Name: with # and "quotes"');
  });

  it('refuses a role of more than one line, in plain words, and files nothing', async () => {
    const s = ready();
    const made = await call(s, 'propose_config', proposal('a-bot', { role: 'Line one\nline two' }));
    expect(made.answer['ok']).toBe(false);
    expect(said(made)).toContain('one line');
    expect(s.invoked).toEqual([]);
  });

  it('refuses, in plain words, a role line the model wrote unquoted when no role argument is given and the file would store it differently', async () => {
    const s = ready();
    const md = GOOD_BOT_MD.replace('role: Answers questions from the manuals.', 'role: Reads posts in #dev and replies');
    const made = await call(s, 'propose_config', proposal('a-bot', { botMd: md }));
    expect(made.answer['ok']).toBe(false);
    expect(said(made)).toMatch(/role/);
    expect(s.invoked).toEqual([]);
  });
});

describe('questions the helper words itself', () => {
  const GAPS = [REQ.post, REQ.mail];
  const bad = { requirementId: 'mail', question: 'There is no write access to the mailbox.', options: [] as string[] };

  it('are sent back once to be reworded; after that the platform\'s own plain question is used, so a stubborn model cannot hold the person up', async () => {
    const s = stub();
    const first = await call(s, 'ask_clarification', { requirements: GAPS, questions: [bad] });
    expect(first.answer['ok']).toBe(false);
    expect(first.end).toBeUndefined();
    expect(s.env.state.questions).toEqual([]);
    expect(said(first)).toContain('question mark');
    const second = await call(s, 'ask_clarification', { requirements: GAPS, questions: [bad] });
    expect(second.end).toBe('asking');
    const q = s.env.state.questions[0]!;
    expect(q.question).toContain('?');
    expect(q.options.length).toBeGreaterThan(0);
  });
  it('are used as worded when they are real questions with choices', async () => {
    const s = stub();
    const good = { requirementId: 'mail', question: 'Which mailbox should it read?', options: ['Support', 'Sales'] };
    const r = await call(s, 'ask_clarification', { requirements: GAPS, questions: [good] });
    expect(r.end).toBe('asking');
    expect(s.env.state.questions[0]).toMatchObject({ question: 'Which mailbox should it read?', options: ['Support', 'Sales'] });
  });
  it('are refused when they show an internal name', async () => {
    const s = stub();
    const r = await call(s, 'ask_clarification', { requirements: GAPS, questions: [{ requirementId: 'mail', question: 'Is no-write-access acceptable for messages.post?', options: ['Yes', 'No'] }] });
    expect(r.end).toBeUndefined();
    expect(said(r)).toContain('internal name');
  });
});

describe('what it will not be able to do, after the person answered', () => {
  it('says what they decided for a gap they answered, keeps the rest "Not settled", and the model cannot change which is which', async () => {
    const s = stub();
    const two = [REQ.mail, { id: 'tone', text: 'Friendly but short', kind: 'other' }];
    await call(s, 'ask_clarification', { requirements: two });
    expect(s.env.state.questions.map((q) => q.requirementId)).toEqual(['mail', 'tone']);
    // only the mailbox question was answered (the route records answers; here the stub does)
    s.env.state.answers = [{ questionId: 'q1', requirementId: 'mail', question: 'q', answer: 'Skip email, mention only' }];
    // the rounds of questions are used up, so the helper may go on with a gap still open; and a hostile model re-lists the tone need as covered: that changes nothing
    s.env.state.rounds = SETUP_MAX_ROUNDS;
    const made = await call(s, 'propose_config', proposal('a-bot', { requirements: [{ id: 'tone', text: 'Friendly but short', kind: 'trigger', name: 'conversation' }], role: 'Helps' }));
    expect(made.answer['ok'], said(made)).toBe(true);
    const limits = s.env.state.limits;
    expect(limits.find((l) => l.includes('Read the mailbox'))).toMatch(/^You decided: Skip email, mention only/);
    expect(limits.find((l) => l.includes('Friendly but short'))).toMatch(/^Not settled/);
  });
});
