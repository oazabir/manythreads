import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TEAM_TRUST_WORDS, conceptAt, isStaleConcept, rowNote } from '../src/screens/memory/conceptWords';
import { TrustIcon } from '../src/screens/memory/icons';

/*
 * The team's Concepts tab (PLAN P21-15): each row carries one trust icon, named in words a person would use; the small helpers decide what a
 * row says about a concept that is out of date or deprecated, and which concept a link names.
 */

const NOW = Date.parse('2026-11-07T12:00:00Z');
const concept = (over: Record<string, unknown> = {}) => ({ path: 'memory/a.md', status: 'stable', staleAfter: null, ...over }) as unknown as Parameters<typeof rowNote>[0] & { path: string };

describe('trust words', () => {
  it('names the three levels in plain words, never the stored value', () => {
    expect(TEAM_TRUST_WORDS).toEqual({ unverified: 'Not checked yet', 'machine-confirmed': 'Confirmed by a check', 'human-reviewed': 'Reviewed by a person' });
  });

  it('draws one icon per row that a screen reader hears as that sentence', () => {
    for (const tier of ['unverified', 'machine-confirmed', 'human-reviewed'] as const) {
      const html = renderToStaticMarkup(createElement(TrustIcon, { tier }));
      expect(html).toContain(`aria-label="${TEAM_TRUST_WORDS[tier]}"`);
      expect(html).toContain('role="img"');
      expect(html.match(/<svg/g)).toHaveLength(1);
    }
  });

  it('writes the words next to the icon in the preview pane', () => {
    const html = renderToStaticMarkup(createElement(TrustIcon, { tier: 'human-reviewed', withWords: true }));
    expect(html).toContain('Reviewed by a person');
    expect(html).not.toContain('role="img"');
  });
});

describe('concept helpers', () => {
  it('calls a concept stale only once its time has passed', () => {
    expect(isStaleConcept({ staleAfter: null }, NOW)).toBe(false);
    expect(isStaleConcept({ staleAfter: '2026-11-08T00:00:00Z' }, NOW)).toBe(false);
    expect(isStaleConcept({ staleAfter: '2026-11-06T00:00:00Z' }, NOW)).toBe(true);
  });

  it('adds a spoken note to a row only when something is unusual about it', () => {
    expect(rowNote(concept(), NOW)).toBe('');
    expect(rowNote(concept({ status: 'deprecated' }), NOW)).toBe('deprecated');
    expect(rowNote(concept({ staleAfter: '2026-01-01T00:00:00Z' }), NOW)).toBe('out of date');
    expect(rowNote(concept({ status: 'deprecated', staleAfter: '2026-01-01T00:00:00Z' }), NOW)).toBe('deprecated, out of date');
  });

  it('finds the concept a link names, and none for a path the list does not hold', () => {
    const list = [concept({ path: 'memory/a.md' }), concept({ path: 'memory/b.md' })] as unknown as Parameters<typeof conceptAt>[0];
    expect(conceptAt(list, 'memory/b.md')?.path).toBe('memory/b.md');
    expect(conceptAt(list, 'memory/gone.md')).toBeNull();
    expect(conceptAt(list, null)).toBeNull();
  });
});
