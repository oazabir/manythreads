import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '../src/components/PageHeader';
import { crumbsFor } from '../src/shell/breadcrumb';

describe('PageHeader', () => {
  it('draws one h1 with its description and actions', () => {
    const html = renderToStaticMarkup(createElement(PageHeader, { title: 'Boards', description: 'Cards', actions: createElement('button', null, 'New') }));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('ph-desc');
    expect(html).toContain('ph-actions');
  });
  it('omits the description and actions when none are given', () => {
    const html = renderToStaticMarkup(createElement(PageHeader, { title: 'Boards', compact: true }));
    expect(html).not.toContain('ph-desc');
    expect(html).not.toContain('ph-actions');
    expect(html).toContain('ph compact');
  });
});

describe('crumbsFor', () => {
  it('names the team and the section', () => {
    expect(crumbsFor('/t/eng/boards', 'Engineering').map((c) => c.label)).toEqual(['Engineering', 'Boards']);
  });
  it('adds the item and links the section', () => {
    const c = crumbsFor('/t/eng/bots/brain', 'Engineering', 'Brain');
    expect(c.map((x) => x.label)).toEqual(['Engineering', 'Bots', 'Brain']);
    expect(c[1]?.to).toBe('/t/eng/bots');
  });
  it('never reads Home over Agents or Projects', () => {
    for (const p of ['/t/eng/agents', '/t/eng/projects']) expect(crumbsFor(p, 'Engineering').map((c) => c.label)).not.toContain('Home');
  });
  it('gives no team crumb without a team', () => {
    expect(crumbsFor('/settings/account', null)).toEqual([]);
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

describe('one h1 per page', () => {
  it('only PageHeader and the full-page frames draw an h1 under screens (migrated screens)', () => {
    const allowed = new Set<string>();
    const offenders = files(join(__dirname, '../src/screens')).filter((p) => /<h1[\s>]/.test(readFileSync(p, 'utf8')) && !allowed.has(p));
    // screens not yet moved to PageHeader are listed here; the list must only shrink
    expect(offenders.map((p) => p.split('/src/')[1]).sort()).toEqual(PENDING.slice().sort());
  });
});

const PENDING: string[] = ['screens/conversations/ConversationView.tsx'];

/**
 * Route screens that do not import PageHeader themselves, and why. The list must only shrink.
 * ConversationView draws its own h1 inside a list pane (it registers it with OwnsPageTitle); the rest
 * have no heading of their own (a redirect, a guard, or the shell's fallback h1 names a channel or DM).
 */
const PENDING_ROUTE_FILES: Record<string, string> = {
  'screens/conversations/ConversationView.tsx': 'owns its h1 and registers it with OwnsPageTitle',
  'screens/ChannelView.tsx': 'the shell h1 carries the channel name',
  'screens/AdminOnly.tsx': 'a route guard, draws no heading',
  'screens/account/AccountIndex.tsx': 'a redirect to the right Account page, draws no heading',
};
/** Files whose heading comes from a shared module they import instead of PageHeader. */
const HEADING_MODULES = ['components/PageHeader', 'components/frames', './UsageReport'];

/** Every screen module that App.tsx routes to (its `./screens/...` imports). */
const ROUTE_FILES: string[] = [...new Set([...readFileSync(join(__dirname, '../src/App.tsx'), 'utf8').matchAll(/'\.\/(screens\/[^']+)'/g)].map((m) => `${m[1]}.tsx`))].sort();

describe('every routed screen has a page header', () => {
  it('finds the routed screens', () => {
    expect(ROUTE_FILES.length).toBeGreaterThan(30);
    for (const f of ROUTE_FILES) expect(() => statSync(join(__dirname, '../src', f)), f).not.toThrow();
  });
  it('each ROUTE_FILES entry imports PageHeader (or a frame / report that draws it) or is on the documented PENDING list', () => {
    const missing = ROUTE_FILES.filter((f) => {
      if (f in PENDING_ROUTE_FILES) return false;
      const src = readFileSync(join(__dirname, '../src', f), 'utf8');
      return !HEADING_MODULES.some((m) => src.includes(`${m}'`));
    });
    expect(missing).toEqual([]);
  });
  it('the PENDING list only names routed files that really lack a header import', () => {
    for (const f of Object.keys(PENDING_ROUTE_FILES)) {
      expect(ROUTE_FILES, f).toContain(f);
      const src = readFileSync(join(__dirname, '../src', f), 'utf8');
      expect(HEADING_MODULES.some((m) => src.includes(`${m}'`)), `${f} now has a header: remove it from the list`).toBe(false);
    }
  });
});
