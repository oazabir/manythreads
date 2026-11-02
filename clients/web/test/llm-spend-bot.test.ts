import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LlmSpendSummary } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { BotCell, purposeLabel } from '../src/screens/admin/llm/Spend';

// The by-bot table of Workspace > LLM > Spend names the bot and its team when the server could, says "Removed bot" for one that is gone (the whole id is only the hover title), and names the
// calls that belong to no bot by what they were for.

const ID = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const html = (name: string | null, team: string | null, rehearsal = false): string => renderToStaticMarkup(createElement(BotCell, { id: ID, name, team, rehearsal }));

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
  it('says "Removed bot" when the bot cannot be named, never a piece of its id; the whole id is only the hover title', () => {
    const out = html(null, null);
    expect(out).toContain('Removed bot');
    expect(out).not.toContain('0192a1b2…');
    expect(out.replace(`title="${ID}"`, '')).not.toContain('0192a1b2');
    expect(out).toContain(`title="${ID}"`);
  });
});

describe('a bot\u2019s rehearsals', () => {
  it('read as "Rehearsal of <bot>", apart from the row of the bot\u2019s real work', () => {
    const out = html('Brain', 'Engineering', true);
    expect(out).toContain('Rehearsal of Brain');
    expect(out).toContain('Engineering');
    expect(html('Brain', 'Engineering')).not.toContain('Rehearsal');
    expect(html(null, null, true)).toContain('Rehearsal of a removed bot');
  });
});

describe('a line with no bot', () => {
  it('is named by what the calls were for, in plain words', () => {
    expect(purposeLabel('setup')).toBe('Add a bot helper');
    expect(purposeLabel('workshop')).toBe('Workshop helper');
    expect(purposeLabel('alias-test')).toBe('Model test');
    expect(purposeLabel('rehearsal')).toBe('Rehearsal');
    expect(purposeLabel(null)).toBe('Not tied to a bot');
    expect(purposeLabel('something-new')).toBe('Other model calls');
  });
});

describe('the spend summary a page receives', () => {
  const base = { since: '2026-11-01T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z', totalUsd: 0, calls: 1, promptTokens: 1, completionTokens: 1, byTeam: [] };
  it('carries the bot and team names and the purpose of a bot-less line, null when there are none', () => {
    const named = LlmSpendSummary.parse({
      ...base,
      byBot: [
        { botId: ID, botName: 'Brain', teamName: 'Engineering', purpose: null, spentUsd: 0, calls: 1 },
        { botId: null, botName: null, teamName: null, purpose: 'setup', spentUsd: 0, calls: 1 },
        { botId: ID, botName: 'Brain', teamName: 'Engineering', purpose: 'rehearsal', spentUsd: 0, calls: 2 },
      ],
    });
    expect(named.byBot[0]).toMatchObject({ botName: 'Brain', teamName: 'Engineering' });
    expect(named.byBot[1]).toMatchObject({ botId: null, botName: null, purpose: 'setup' });
    expect(named.byBot[2]).toMatchObject({ botId: ID, purpose: 'rehearsal' });
  });
});
