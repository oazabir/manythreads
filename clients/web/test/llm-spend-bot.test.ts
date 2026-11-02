import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LlmSpendSummary } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { BotCell } from '../src/screens/admin/llm/Spend';

// The by-bot table of Workspace > LLM > Spend names the bot and its team when the server could, and keeps the short id otherwise (the whole id is always the hover title).

const ID = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const html = (name: string | null, team: string | null): string => renderToStaticMarkup(createElement(BotCell, { id: ID, name, team }));

describe('a bot in the spend table', () => {
  it('shows the name and the team, with the whole id as the title', () => {
    const out = html('Brain', 'Engineering');
    expect(out).toContain('Brain');
    expect(out).toContain('Engineering');
    expect(out).toContain(`title="${ID}"`);
    expect(out).not.toContain('0192a1b2…');
  });
  it('shows the name alone when the team is not known', () => {
    const out = html('Brain', null);
    expect(out).toContain('Brain');
    expect(out).not.toContain('·');
  });
  it('falls back to the short id, still titled with the whole id, when the bot cannot be named', () => {
    const out = html(null, null);
    expect(out).toContain('0192a1b2…');
    expect(out).toContain(`title="${ID}"`);
  });
});

describe('the spend summary a page receives', () => {
  const base = { since: '2026-11-01T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z', totalUsd: 0, calls: 1, promptTokens: 1, completionTokens: 1, byTeam: [] };
  it('carries the bot and team names, null when there are none', () => {
    const named = LlmSpendSummary.parse({ ...base, byBot: [{ botId: ID, botName: 'Brain', teamName: 'Engineering', spentUsd: 0, calls: 1 }, { botId: null, botName: null, teamName: null, spentUsd: 0, calls: 1 }] });
    expect(named.byBot[0]).toMatchObject({ botName: 'Brain', teamName: 'Engineering' });
    expect(named.byBot[1]).toMatchObject({ botId: null, botName: null });
  });
});
