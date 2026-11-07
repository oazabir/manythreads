import type { BotRunHandle, PluginContext } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/catalog.ts';
import { confineRunWrite, spacesFor, withRunSpaces, type RunSpaces } from '../src/spaces.ts';

// P20-08 (D10): what a run may read, and how a tool call is fitted to it. The database half (the audience, the consent, the team list) is in
// bots/test/rls/personal-consents.test.ts; this file is the gateway's half, without a database.

const TEAM = '00000000-0000-7000-8000-0000000b0001';
const OTHER = '00000000-0000-7000-8000-0000000b0002';
const FOREIGN = '00000000-0000-7000-8000-0000000b0003';
const PERSON = '00000000-0000-7000-8000-0000000a0001';
const RUN = { runId: 'r', botId: 'b', botActorId: 'a', teamId: TEAM, workspaceId: 'w', trigger: 'conversation', askerActorId: 'x', expiresAt: '2030-01-01T00:00:00.000Z' } as unknown as BotRunHandle;

const dm: RunSpaces = { audience: 'personal', personId: PERSON, teamIds: [TEAM, OTHER], personalReason: null };
const channel: RunSpaces = { audience: 'team', personId: null, teamIds: [TEAM], personalReason: 'team_audience' };

const ctxWith = (rows: unknown[]): PluginContext =>
  ({ runs: { asReader: (_run: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({ query: () => Promise.resolve({ rows }) }) } }) as unknown as PluginContext;

describe('spacesFor', () => {
  it('reads the audience, the asker and the teams from the run context', async () => {
    const spaces = await spacesFor(
      ctxWith([{ audience: 'personal', asker_person_id: PERSON, personal_allowed: true, personal_reason: null, team_ids: [OTHER] }]),
      RUN,
    );
    expect(spaces).toEqual({ audience: 'personal', personId: PERSON, teamIds: [TEAM, OTHER], personalReason: null });
  });

  it('shuts Personal when the database says the asker or the bot has not allowed it, whatever the asker id', async () => {
    const spaces = await spacesFor(
      ctxWith([{ audience: 'personal', asker_person_id: PERSON, personal_allowed: false, personal_reason: 'declined', team_ids: [TEAM] }]),
      RUN,
    );
    expect(spaces).toMatchObject({ audience: 'personal', personId: null, personalReason: 'declined' });
  });

  it('falls back to the run\'s own team when the run has no context (it is over)', async () => {
    expect(await spacesFor(ctxWith([]), RUN)).toEqual({ audience: 'team', personId: null, teamIds: [TEAM], personalReason: 'team_audience' });
  });
});

describe('withRunSpaces', () => {
  it('defaults a search in a team context to the run\'s own team', () => {
    for (const tool of ['messages.search', 'files.search', 'knowledge.search']) {
      expect(withRunSpaces(tool, { query: 'refund' }, channel, TEAM)).toEqual({ ok: true, input: { query: 'refund', teamId: TEAM } });
    }
  });

  it('leaves a search in a private context open to every team the asker can read (their read policies bound it)', () => {
    expect(withRunSpaces('messages.search', { query: 'refund' }, dm, TEAM)).toEqual({ ok: true, input: { query: 'refund' } });
    expect(withRunSpaces('messages.search', { query: 'refund', teamId: OTHER }, dm, TEAM)).toMatchObject({ ok: true });
  });

  it('refuses a team the run may not read, in either context', () => {
    expect(withRunSpaces('files.search', { query: 'q', teamId: FOREIGN }, dm, TEAM)).toMatchObject({ ok: false, code: 'other_space' });
    expect(withRunSpaces('knowledge.search', { query: 'q', teamId: OTHER }, channel, TEAM)).toMatchObject({ ok: false, code: 'other_space' });
  });

  it('drops the keys that would name a space', () => {
    const out = withRunSpaces('knowledge.search', { query: 'q', space: `person:${PERSON}`, spaces: ['x'], personId: PERSON, ownerPersonId: PERSON }, channel, TEAM);
    expect(out).toEqual({ ok: true, input: { query: 'q', teamId: TEAM } });
  });

  it('keeps the team default of the tools that write a page or a proposal', () => {
    expect(withRunSpaces('pages.write', { path: 'a.md' }, dm, TEAM)).toEqual({ ok: true, input: { path: 'a.md', team: TEAM } });
    expect(withRunSpaces('proposals.propose', { team: 'eng' }, dm, TEAM)).toEqual({ ok: true, input: { team: 'eng' } });
  });

  it('does not touch a tool it knows nothing about, apart from the space keys', () => {
    expect(withRunSpaces('tasks.read', { teamId: FOREIGN, space: 'x' }, channel, TEAM)).toEqual({ ok: true, input: { teamId: FOREIGN } });
  });
});

describe('every read tool that takes a team goes through withRunSpaces', () => {
  it('lists the read tools with a teamId argument, so a new one has to be handled on purpose', () => {
    const withTeam = Object.values(TOOLS)
      .filter((t) => t.kind === 'read' && JSON.stringify(t.inputSchema).includes('"teamId"'))
      .map((t) => t.name)
      .sort();
    // each of these is fitted by withRunSpaces (TEAM_SCOPED_READS); a read tool added with a teamId argument fails here until it is
    expect(withTeam).toEqual(['files.search', 'messages.search']);
    for (const name of withTeam) {
      expect(withRunSpaces(name, { query: 'xx', teamId: FOREIGN }, channel, TEAM)).toMatchObject({ ok: false, code: 'other_space' });
    }
  });
});

// P20-R6: the workspace Brain has a seat in every team, so a write made as the bot must name a place of the run's own team. The database half is the same query a team
// would run; here the answers of the database are faked to prove which question is asked and what is done with the answer.
describe('confineRunWrite (the workspace Brain sits in every team)', () => {
  const CHANNEL = '00000000-0000-7000-8000-0000000c0001';
  const asked: Array<{ sql: string; params: unknown[] }> = [];
  const ctxFor = (scope: string | undefined, place: boolean): PluginContext =>
    ({
      runs: {
        asBot: (_run: unknown, fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            query: (sql: string, params: unknown[]) => {
              asked.push({ sql, params });
              if (sql.includes('SELECT scope')) return Promise.resolve({ rows: scope === undefined ? [] : [{ scope }] });
              return Promise.resolve({ rows: place ? [{ '?column?': 1 }] : [] });
            },
          }),
      },
    }) as unknown as PluginContext;

  it('lets the workspace Brain post in a channel of the run\'s team, and refuses a channel of another team', async () => {
    expect(await confineRunWrite(ctxFor('workspace', true), RUN, 'messages.post', { channelId: CHANNEL, body: 'x' })).toBeNull();
    expect(await confineRunWrite(ctxFor('workspace', false), RUN, 'messages.post', { channelId: CHANNEL, body: 'x' })).toMatchObject({ code: 'other_space' });
    expect(await confineRunWrite(ctxFor('workspace', false), RUN, 'messages.update', { channelId: CHANNEL, messageId: 'm', body: 'x' })).toMatchObject({ code: 'other_space' });
    // the question is about the run's own team
    expect(asked.some((q) => q.sql.includes('FROM app.channels') && q.params[1] === TEAM)).toBe(true);
  });

  it('lets the workspace Brain write a page or a proposal in the run\'s team only, by id or by slug', async () => {
    expect(await confineRunWrite(ctxFor('workspace', true), RUN, 'pages.write', { team: 'engineering', path: 'pages/a.md' })).toBeNull();
    expect(await confineRunWrite(ctxFor('workspace', false), RUN, 'pages.write', { team: 'marketing', path: 'pages/a.md' })).toMatchObject({ code: 'other_space' });
    expect(await confineRunWrite(ctxFor('workspace', false), RUN, 'proposals.propose', { team: OTHER, path: 'TEAM.md' })).toMatchObject({ code: 'other_space' });
  });

  it('asks nothing when no place is named (the run\'s own place is the default) and nothing of a team bot or another tool', async () => {
    asked.length = 0;
    expect(await confineRunWrite(ctxFor('workspace', false), RUN, 'messages.post', { body: 'x' })).toBeNull();
    expect(await confineRunWrite(ctxFor('workspace', false), RUN, 'pages.write', { path: 'pages/a.md' })).toBeNull();
    expect(await confineRunWrite(ctxFor('workspace', false), RUN, 'tasks.create', { team: 'marketing' })).toBeNull();
    expect(asked).toEqual([]);
    // a team bot is bounded by its one seat in the database already
    expect(await confineRunWrite(ctxFor('team', false), RUN, 'messages.post', { channelId: CHANNEL, body: 'x' })).toBeNull();
    expect(await confineRunWrite(ctxFor(undefined, false), RUN, 'pages.write', { team: 'marketing' })).toBeNull();
  });
});
