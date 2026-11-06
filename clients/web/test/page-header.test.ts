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

const PENDING: string[] = ['screens/ThreadsInbox.tsx', 'screens/conversations/ConversationView.tsx'];
