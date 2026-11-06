import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { RECIPE_CATEGORIES, RecipeCard, type RecipeCategory } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { CategoryIcon, RecipeTile, StatePill } from '../src/screens/recipes/parts';
import { canOfferAdd, pillShown, stateLook } from '../src/screens/recipes/words';

// The recipe card (PLAN P21-18): no "Ready to add" pill on a recipe nobody has touched, a pill only when something has happened, and an Add button
// only on a recipe that can still be added.

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
    abilities: ['post messages'],
    outputPage: 'pages/recipes/bug-triage.md',
    evals: { cases: 4, minScore: 0.9 },
    paths: ['bots/bug-triager/BOT.md', 'bots/bug-triager/evals/bug-triager.yaml', 'routines/bug-triage.yaml'],
    state: 'available',
    openProposals: 0,
    scheduled: false,
    ...over,
  });

const tile = (c: RecipeCard): string => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(RecipeTile, { card: c, onOpen: () => undefined }) as ReactElement));

describe('which recipes carry a pill', () => {
  it('draws none for a recipe nobody has touched', () => {
    expect(pillShown(card())).toBe(false);
    expect(renderToStaticMarkup(createElement(StatePill, { card: card() }))).toBe('');
    expect(tile(card())).not.toContain('recipe-state');
    expect(tile(card())).not.toContain('Ready to add');
  });

  it('still describes the state in words for a screen reader', () => {
    expect(stateLook(card()).label).toBe('Ready to add');
  });

  it('draws a pill in words for waiting, installed with the schedule off, and running', () => {
    const waiting = card({ state: 'waiting', openProposals: 3 });
    const off = card({ state: 'installed', scheduled: false });
    const on = card({ state: 'installed', scheduled: true });
    for (const [c, label] of [[waiting, 'Waiting for approval'], [off, 'Installed, schedule off'], [on, 'Installed and running']] as const) {
      expect(pillShown(c)).toBe(true);
      expect(tile(c)).toContain('data-testid="recipe-state"');
      expect(tile(c)).toContain(label);
      expect(tile(c)).toContain(`aria-label="Bug triage: ${label}. Open the details."`);
    }
  });

  it('puts no stray mark before the words of a waiting recipe', () => {
    const html = tile(card({ state: 'waiting', openProposals: 1 }));
    expect(html).not.toContain('…');
    expect(html).not.toContain('rg-glyph');
  });
});

describe('the Add button', () => {
  it('is offered only on a recipe that can still be added', () => {
    expect(canOfferAdd(card())).toBe(true);
    expect(canOfferAdd(card({ state: 'waiting', openProposals: 1 }))).toBe(false);
    expect(canOfferAdd(card({ state: 'installed' }))).toBe(false);
  });

  it('is its own button beside the card (a button never sits inside a button) and names the recipe', () => {
    const out = tile(card());
    expect(out).toContain('data-testid="recipe-add"');
    expect(out).toContain('aria-label="Add Bug triage"');
    expect(out).toMatch(/<\/button><button[^>]*data-testid="recipe-add"/);
    expect(tile(card({ state: 'installed' }))).not.toContain('recipe-add');
  });
});

describe('the card footer and the shelf picture', () => {
  it('keeps the category and schedule in one element that carries the whole text as a title', () => {
    expect(tile(card())).toContain('<span class="rg-meta" title="Engineering · Weekdays at 08:00 UTC">Engineering · Weekdays at 08:00 UTC</span>');
  });

  it('has a picture for every shelf, hidden from screen readers', () => {
    for (const c of RECIPE_CATEGORIES) {
      const out = renderToStaticMarkup(createElement(CategoryIcon, { category: c.id as RecipeCategory }));
      expect(out).toContain(`data-category="${c.id}"`);
      expect(out).toContain('<svg');
      expect(out).toContain('aria-hidden="true"');
    }
  });
});
