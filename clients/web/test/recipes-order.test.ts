import { RecipeCard, type RecipeCategory } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { POPULAR_RECIPES, byPopularity, onShelf } from '../src/screens/recipes/words';

// The recipe gallery's order (PLAN P21-18): the popular recipes first, in the list's own order, then every other one by name.

const card = (id: string, name: string, category: RecipeCategory = 'rhythm'): RecipeCard =>
  RecipeCard.parse({
    id,
    name,
    summary: 'Does a useful thing.',
    category,
    categoryLabel: 'Team rhythm',
    schedule: { cron: '0 8 * * mon-fri', label: 'Weekdays at 08:00 UTC' },
    channels: [],
    needs: [],
    bot: { slug: `${id}-bot`, name, kind: 'agent', runtime: 'hermes' },
    abilities: [],
    outputPage: `pages/recipes/${id}.md`,
    evals: { cases: 1, minScore: 0.9 },
    paths: [`bots/${id}-bot/BOT.md`, `bots/${id}-bot/evals/${id}.yaml`, `routines/${id}.yaml`],
    state: 'available',
    openProposals: 0,
    scheduled: false,
  });

describe('the popular recipes list', () => {
  it('names the eight the planner chose, in order', () => {
    expect(POPULAR_RECIPES).toEqual(['daily-standup', 'weekly-digest', 'request-intake', 'bug-triage', 'release-notes', 'meeting-prep', 'follow-up-chaser', 'incident-watch']);
  });
});

describe('byPopularity', () => {
  const names: Record<string, string> = { 'okr-check-in': 'OKR check-in', 'retro-prep': 'Retro prep', 'decision-log': 'Decision log', 'bug-triage': 'Bug triage', 'daily-standup': 'Daily standup', 'incident-watch': 'Incident watch' };
  const cards = Object.entries(names).map(([id, name]) => card(id, name));

  it('puts the popular ones first in list order, then the rest by name', () => {
    expect(byPopularity(cards).map((c) => c.id)).toEqual(['daily-standup', 'bug-triage', 'incident-watch', 'decision-log', 'okr-check-in', 'retro-prep']);
  });

  it('does not change the list it is given', () => {
    const before = cards.map((c) => c.id);
    byPopularity(cards);
    expect(cards.map((c) => c.id)).toEqual(before);
  });

  it('keeps the server order for two recipes with the same name outside the list', () => {
    expect(byPopularity([card('b-two', 'Same'), card('a-one', 'Same')]).map((c) => c.id)).toEqual(['b-two', 'a-one']);
  });

  it('is empty for no recipes', () => {
    expect(byPopularity([])).toEqual([]);
  });
});

describe('onShelf keeps the order inside a shelf', () => {
  const cards = [card('okr-check-in', 'OKR check-in', 'people'), card('weekly-digest', 'Weekly digest', 'rhythm'), card('daily-standup', 'Daily standup', 'rhythm'), card('retro-prep', 'Retro prep', 'rhythm')];

  it('orders "all" and one shelf the same way', () => {
    expect(onShelf(cards, 'all').map((c) => c.id)).toEqual(['daily-standup', 'weekly-digest', 'okr-check-in', 'retro-prep']);
    expect(onShelf(cards, 'rhythm').map((c) => c.id)).toEqual(['daily-standup', 'weekly-digest', 'retro-prep']);
  });
});
