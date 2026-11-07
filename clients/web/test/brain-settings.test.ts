import { beforeEach, describe, expect, it } from 'vitest';
import type { BotSummary } from '@manythreads/shared';
import { setTransport, type Transport } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { loadBrain } from '../src/screens/admin/brain/BrainSettings';
import {
  CONSENT_DEFAULT,
  GUEST_RULE,
  NOT_EDITABLE,
  READ_RULES,
  RETIRED_TEAM_BRAINS,
  brainState,
  contextTeam,
  findWorkspaceBrain,
  modelLines,
  reachWords,
  runsOnWords,
  shortSha,
} from '../src/screens/admin/brain/brainWords';

/*
 * Settings → Workspace → Brain (P20-07). The page is read only and uses routes that exist: the team list, a team's bot roster (which carries the workspace Brain with
 * `scope: 'workspace'`), the runner list and the model names. The first part reads the plain words; the second runs the page's loader against the mock transport with
 * the roster answered by hand (the mock has no bot roster).
 */

const ID = (n: number): string => `00000000-0000-7000-8000-0000000c${n.toString(16).padStart(4, '0')}`;
const SHA = 'ab12cd34'.repeat(8);

const bot = (over: Partial<BotSummary> & Record<string, unknown> = {}): BotSummary =>
  ({
    id: ID(1), workspaceId: ID(2), teamId: ID(3), scope: 'workspace', slug: 'brain', name: 'Brain', role: 'The workspace’s memory.', avatar: null, kind: 'agent', runtime: 'hermes',
    visibility: 'workspace', definitionSha: SHA, status: 'active', placement: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    actorId: ID(4), mayTag: [], conversational: true, mentionable: true, invalid: null, ...over,
  }) as BotSummary;

describe('the words of the Brain page', () => {
  it('finds the workspace Brain, and not a team bot that is called brain', () => {
    expect(findWorkspaceBrain([bot({ scope: 'team' }), bot({ scope: 'workspace', slug: 'other' })])).toBeNull();
    expect(findWorkspaceBrain([bot({ scope: 'team' }), bot()])?.scope).toBe('workspace');
    expect(findWorkspaceBrain([])).toBeNull();
  });

  it('reads the roster through the first team that is not archived', () => {
    expect(contextTeam([{ archivedAt: '2026-01-01T00:00:00.000Z', n: 1 }, { archivedAt: null, n: 2 }, { archivedAt: null, n: 3 }])?.n).toBe(2);
    expect(contextTeam([{ archivedAt: '2026-01-01T00:00:00.000Z' }])).toBeNull();
    expect(contextTeam([])).toBeNull();
  });

  it('says whether the Brain is on, off or needs a fix, and why', () => {
    expect(brainState({ status: 'active', invalid: null })).toMatchObject({ tone: 'ok', label: 'On' });
    expect(brainState({ status: 'disabled', invalid: null })).toMatchObject({ tone: 'warn', label: 'Off' });
    const bad = brainState({ status: 'invalid', invalid: { fieldPath: 'model', message: 'unknown model name', at: '2026-11-01T00:00:00.000Z', definitionSha: SHA } });
    expect(bad).toMatchObject({ tone: 'alert', label: 'Needs a fix' });
    expect(bad.sentence).toContain('unknown model name');
    expect(bad.sentence).toMatch(/last one that worked/);
  });

  it('names the ways to ask it, and the short version of its definition', () => {
    expect(reachWords({ conversational: true, mentionable: true })).toEqual(['A one-to-one conversation in Chat', '@Brain in any channel']);
    expect(reachWords({ conversational: false, mentionable: true })).toEqual(['@Brain in any channel']);
    expect(reachWords({ conversational: false, mentionable: false })).toEqual([]);
    expect(shortSha(SHA)).toBe('ab12cd34');
  });

  it('says where it runs: a named runner, the default runner, or none', () => {
    const runners = [{ name: 'lab', isDefault: false }, { name: 'shared', isDefault: true }];
    expect(runsOnWords({ placement: { runs_on: 'lab' } }, runners)).toBe('The runner called lab.');
    expect(runsOnWords({ placement: null }, runners)).toMatch(/default, shared/);
    expect(runsOnWords({ placement: null }, [{ name: 'lab', isDefault: false }])).toMatch(/no default runner/);
    expect(runsOnWords({ placement: null }, null)).toMatch(/no default runner/);
  });

  it('shows what each model name it asks for is bound to, and null when the names could not be read', () => {
    expect(modelLines([{ alias: 'smart', model: 'anthropic/claude-sonnet-4' }])).toEqual([
      { name: 'smart', bound: 'anthropic/claude-sonnet-4' },
      { name: 'fast', bound: null },
    ]);
    expect(modelLines(null)).toBeNull();
  });

  it('states the reading rules as rules, not as switches', () => {
    expect(READ_RULES.map((r) => r.where)).toEqual(['In a team channel', 'In a private conversation or a direct message', 'In a routine or a webhook']);
    expect(READ_RULES[0]?.reads).toMatch(/Only that team/);
    expect(GUEST_RULE).toMatch(/guest/);
    expect(CONSENT_DEFAULT).toMatch(/until that person turns it off/);
    expect(RETIRED_TEAM_BRAINS).toMatch(/stay readable/);
    expect(NOT_EDITABLE).toMatch(/only shows/);
  });
});

describe('the page loader', () => {
  const answer = (bots: BotSummary[], over: Transport | null = null): Transport => {
    const mock = createMockTransport({ latencyMs: 0 });
    return async (req) => {
      if (over) {
        const r = await over(req);
        if (r) return r;
      }
      if (/\/api\/teams\/[^/]+\/bots$/.test(req.url)) return { status: 200, body: { bots } };
      return mock(req);
    };
  };
  beforeEach(() => setTransport(createMockTransport({ latencyMs: 0 })));

  it('reads the Brain from a team roster, with the runners and the model names', async () => {
    setTransport(answer([bot({ scope: 'team', slug: 'coder', name: 'Coder' }), bot()]));
    const got = await loadBrain();
    expect(got.state).toBe('ok');
    if (got.state !== 'ok') return;
    expect(got.brain.slug).toBe('brain');
    expect(got.runners).not.toBeNull();
    expect(modelLines(got.aliases)?.every((m) => m.bound !== null)).toBe(true);
  });

  it('says "not set up" when the roster has no workspace Brain', async () => {
    setTransport(answer([bot({ scope: 'team' })]));
    await expect(loadBrain()).resolves.toEqual({ state: 'no-brain' });
  });

  it('says "no team" when the workspace has no live team', async () => {
    setTransport(answer([], async (req) => (req.url.startsWith('/api/teams') && !req.url.includes('/bots') ? { status: 200, body: { teams: [] } } : (undefined as never))));
    await expect(loadBrain()).resolves.toEqual({ state: 'no-teams' });
  });

  it('keeps the page when the runner list or the model names cannot be read', async () => {
    setTransport(
      answer([bot()], async (req) =>
        req.url.startsWith('/api/admin/bot-runners') || req.url.startsWith('/api/workspace/llm/aliases') ? { status: 500, body: { error: { code: 'internal', message: 'down' } } } : (undefined as never),
      ),
    );
    const got = await loadBrain();
    expect(got).toMatchObject({ state: 'ok', runners: null, aliases: null });
  });
});
