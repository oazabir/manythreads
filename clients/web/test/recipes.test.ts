import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { InstallRecipeResponse, ListRecipesResponse, RecipeCard } from '@manythreads/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport, type TransportRequest } from '../src/api/client';
import { fetchRecipes, installRecipe } from '../src/screens/recipes/api';
import { Filed, GateNote, RecipeFacts, RecipeTile, StatePill } from '../src/screens/recipes/parts';
import { RECIPES_TOPIC, checksLine, filedLine, fileRole, installGate, needsLine, onShelf, shelfFrom, shelves, stateLook } from '../src/screens/recipes/words';
import { teamSwitchPath, viewTitle } from '../src/shell/nav';

// The recipe gallery (PLAN P18-01): the calls reach the routes the workshop plugin mounts, the plain words and rules read as a person expects, and the parts draw the
// facts a person must see before installing (and never let a bot-written string become markup).

const card = (over: Partial<RecipeCard> = {}): RecipeCard =>
  RecipeCard.parse({
    id: 'bug-triage',
    name: 'Bug triage',
    summary: 'Each morning sorts new bug reports into cards.',
    category: 'engineering',
    categoryLabel: 'Engineering',
    schedule: { cron: '0 8 * * mon-fri', label: 'Weekdays at 08:00 UTC' },
    channels: ['#bugs'],
    needs: ['A channel called #bugs where bugs are reported'],
    bot: { slug: 'bug-triager', name: 'Bug triager', kind: 'agent', runtime: 'hermes' },
    abilities: ['post messages', 'write pages'],
    outputPage: 'pages/recipes/bug-triage.md',
    evals: { cases: 4, minScore: 0.9 },
    paths: ['bots/bug-triager/BOT.md', 'bots/bug-triager/evals/bug-triager.yaml', 'routines/bug-triage.yaml'],
    state: 'available',
    openProposals: 0,
    scheduled: false,
    ...over,
  });

const inRouter = (el: ReactElement): string => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const PROPOSAL = (n: number): string => `00000000-0000-7000-8000-00000000a00${String(n)}`;

describe('the recipe calls reach the routes the plugin mounts', () => {
  let seen: TransportRequest[] = [];
  beforeEach(() => {
    seen = [];
  });

  it('lists with GET and installs with POST and an empty body', async () => {
    setTransport(async (req) => {
      seen.push(req);
      if (req.method === 'GET') return { status: 200, body: ListRecipesResponse.parse({ recipes: [card()], canInstall: true }) };
      return {
        status: 201,
        body: InstallRecipeResponse.parse({
          recipe: card({ state: 'waiting', openProposals: 3 }),
          proposals: [1, 2, 3].map((n) => ({ id: PROPOSAL(n), path: card().paths[n - 1], checksOk: true })),
        }),
      };
    });
    const list = await fetchRecipes('marketing');
    expect(list.recipes).toHaveLength(1);
    const done = await installRecipe('marketing', 'bug-triage');
    expect(done.proposals).toHaveLength(3);
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /api/teams/marketing/recipes', 'POST /api/teams/marketing/recipes/bug-triage/install']);
    expect(JSON.parse(seen[1]?.body ?? 'null')).toEqual({});
  });

  it('shows the server wording of a refusal as it comes', async () => {
    setTransport(async () => ({ status: 409, body: { error: { code: 'conflict', message: '"Bug triage" is already waiting for approval (3 proposals on the Proposals page). Deal with those first.' } } }));
    await expect(installRecipe('marketing', 'bug-triage')).rejects.toThrow('already waiting for approval');
  });
});

describe('where a recipe stands', () => {
  it('says ready, waiting, installed with the schedule off, and running', () => {
    expect(stateLook(card()).label).toBe('Ready to add');
    expect(stateLook(card({ state: 'waiting', openProposals: 3 }))).toMatchObject({ label: 'Waiting for approval', hint: '3 proposals wait for a team lead or a workspace admin.' });
    expect(stateLook(card({ state: 'waiting', openProposals: 1 })).hint).toBe('1 proposal waits for a team lead or a workspace admin.');
    expect(stateLook(card({ state: 'installed', scheduled: false })).label).toBe('Installed, schedule off');
    expect(stateLook(card({ state: 'installed', scheduled: true })).label).toBe('Installed and running');
  });

  it('puts the state in words, not only a colour', () => {
    const out = renderToStaticMarkup(createElement(StatePill, { card: card({ state: 'installed' }) }));
    expect(out).toContain('Installed, schedule off');
    expect(out).toContain('data-state="installed"');
  });
});

describe('what a card says it needs', () => {
  it('names the first need and counts the rest', () => {
    expect(needsLine(card())).toBe('Needs: A channel called #bugs where bugs are reported');
    expect(needsLine(card({ needs: ['A', 'B', 'C'] }))).toBe('Needs: A (and 2 more)');
    expect(needsLine(card({ needs: [] }))).toBe('Needs nothing set up first.');
  });
});

describe('the shelves', () => {
  const cards = [card(), card({ id: 'standup', category: 'rhythm' }), card({ id: 'digest', category: 'rhythm' })];

  it('lists All and only the shelves that hold a recipe, in the gallery order', () => {
    expect(shelves(cards).map((s) => `${s.id}:${String(s.count)}`)).toEqual(['all:3', 'rhythm:2', 'engineering:1']);
    expect(shelves([])).toEqual([{ id: 'all', label: 'All', count: 0 }]);
  });

  it('filters by shelf and falls back to All for a shelf nobody knows', () => {
    expect(onShelf(cards, 'rhythm').map((c) => c.id)).toEqual(['standup', 'digest']);
    expect(onShelf(cards, 'all')).toHaveLength(3);
    expect(shelfFrom('rhythm')).toBe('rhythm');
    expect(shelfFrom('nonsense')).toBe('all');
    expect(shelfFrom(null)).toBe('all');
  });
});

describe('who may press Install', () => {
  const lead = { guest: false, canApply: true };
  it('allows a lead or admin on an available recipe', () => {
    expect(installGate(lead, card(), true)).toEqual({ allowed: true, reason: null });
  });

  it('gives a plain reason to everyone else', () => {
    expect(installGate({ guest: false, canApply: false }, card(), true).reason).toBe('Only a team lead or a workspace admin can add a recipe. Ask one of them.');
    expect(installGate({ guest: true, canApply: false }, card(), true).reason).toContain('Guests cannot');
    expect(installGate(lead, card(), false).reason).toContain('archived');
  });

  it('refuses a recipe that is already installed or waiting, even for a lead', () => {
    expect(installGate(lead, card({ state: 'installed' }), true)).toMatchObject({ allowed: false, reason: expect.stringContaining('Bug triager') as string });
    expect(installGate(lead, card({ state: 'waiting' }), true).allowed).toBe(false);
  });
});

describe('the plain words', () => {
  it('names the three files an install proposes', () => {
    expect(card().paths.map(fileRole)).toEqual(['The bot', 'Its check scenarios', 'Its routine (the job it repeats)']);
  });

  it('turns the pass mark into a percentage and counts scenarios', () => {
    expect(checksLine(card())).toBe('4 scenarios check it before it is trusted (pass mark 90%).');
    expect(checksLine(card({ evals: { cases: 1, minScore: 0.5 } }))).toContain('1 scenario checks it');
  });

  it('says who approves what was filed', () => {
    expect(filedLine(3)).toBe('3 proposals are filed. Nothing is added to the team until a team lead or workspace admin approves them.');
    expect(filedLine(1)).toContain('1 proposal is filed');
  });
});

describe('the parts', () => {
  it('draws a card as one button with the name, the line, the need and the state', () => {
    const out = inRouter(createElement(RecipeTile, { card: card(), onOpen: () => undefined }));
    expect(out).toContain('<button type="button" class="rg-card"');
    expect(out).toContain('Bug triage');
    expect(out).toContain('Each morning sorts new bug reports into cards.');
    expect(out).toContain('Needs: A channel called #bugs');
    expect(out).toContain('Ready to add');
    expect(out).toContain('aria-label="Bug triage: Ready to add. Open the details."');
  });

  it('draws the facts: schedule, needs, abilities, result page, checks and the three files', () => {
    const out = inRouter(createElement(RecipeFacts, { card: card() }));
    for (const text of ['Weekdays at 08:00 UTC', '0 8 * * mon-fri', 'A channel called #bugs where bugs are reported', 'post messages', 'pages/recipes/bug-triage.md', '4 scenarios check it', 'bots/bug-triager/BOT.md', 'routines/bug-triage.yaml', 'Uses a model to read and write.']) {
      expect(out).toContain(text);
    }
    expect(out).toContain('does not start the schedule');
  });

  it('says a rules bot calls no model', () => {
    const out = inRouter(createElement(RecipeFacts, { card: card({ bot: { slug: 'r', name: 'R', kind: 'automation', runtime: 'rules' } }) }));
    expect(out).toContain('no model is called');
  });

  it('never turns recipe text into markup', () => {
    const out = inRouter(createElement(RecipeTile, { card: card({ name: '<img src=x onerror=alert(1)>' }), onOpen: () => undefined }));
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('shows the reason an install is off, and nothing when it is on', () => {
    expect(renderToStaticMarkup(createElement(GateNote, { gate: { allowed: false, reason: 'Ask a lead.' }, id: 'why' }))).toContain('id="why"');
    expect(renderToStaticMarkup(createElement(GateNote, { gate: { allowed: true, reason: null }, id: 'why' }))).toBe('');
  });

  it('links each filed proposal to its page and flags a failed check', () => {
    const result = InstallRecipeResponse.parse({
      recipe: card({ state: 'waiting', openProposals: 3 }),
      proposals: [
        { id: PROPOSAL(1), path: 'bots/bug-triager/BOT.md', checksOk: true },
        { id: PROPOSAL(2), path: 'bots/bug-triager/evals/bug-triager.yaml', checksOk: false },
        { id: PROPOSAL(3), path: 'routines/bug-triage.yaml', checksOk: true },
      ],
    });
    const out = inRouter(createElement(Filed, { slug: 'marketing', result }));
    expect(out).toContain(`href="/t/marketing/proposals/${PROPOSAL(1)}"`);
    expect(out).toContain(`href="/t/marketing/proposals/${PROPOSAL(3)}"`);
    expect(out).toContain('3 proposals are filed');
    expect(out).toContain('a check failed, open it to see why');
    expect(out).toContain('href="/t/marketing/jobs"');
  });
});

describe('the shell knows the screen', () => {
  it('titles it and keeps it when switching teams', () => {
    expect(viewTitle('/t/marketing/recipes')).toBe('Recipes');
    expect(teamSwitchPath('/t/marketing/recipes', 'sales')).toBe('/t/sales/recipes');
  });
  it('the top bar title is not said twice', () => {
    expect(RECIPES_TOPIC).not.toBe(viewTitle('/t/marketing/recipes'));
    expect(RECIPES_TOPIC.toLowerCase()).not.toContain('recipes');
  });
});
