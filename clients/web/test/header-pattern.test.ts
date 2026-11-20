// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, useCallback, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PageHeader } from '../src/components/PageHeader';
import { THREAD_TOOL_ORDER, ThreadTools, threadTools, type ThreadToolKey } from '../src/channels/ThreadTools';
import { headerBackFor } from '../src/shell/headerBack';
import { HeaderActionsContext, HeaderTitleSlotContext, PageHeaderRegistry } from '../src/shell/topic';

/*
 * One header pattern (P34-06): a page's title is the one h1 of the screen and sits in the shell's band with the tools on the right, like a channel's;
 * a top-level screen has no trail (owner, 2026-11-19, reversing P21-12's breadcrumb; its one-h1 test stays in page-header.test.ts); the thread's
 * controls are one row of icon buttons.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** The shell's band as Shell.tsx draws it: the slot for a page's h1, the fallback title while no page header is mounted, the tools on the right. */
function Band({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [headers, setHeaders] = useState(0);
  const register = useCallback((d: 1 | -1) => setHeaders((n) => n + d), []);
  return createElement(
    PageHeaderRegistry.Provider,
    { value: register },
    createElement(
      HeaderTitleSlotContext.Provider,
      { value: slot },
      createElement(
        HeaderActionsContext.Provider,
        { value: actions },
        createElement(
          'header',
          { className: 'chead', 'data-testid': 'band' },
          createElement('div', { className: 'chead-place', ref: setSlot }),
          headers > 0 ? null : createElement('h1', { className: 'chead-title' }, 'Fallback'),
          createElement('div', { className: 'chead-tools' }, createElement('div', { className: 'chead-actions', ref: setActions })),
        ),
        createElement('section', { 'data-testid': 'content' }, children),
      ),
    ),
  );
}

const band = (): HTMLElement => document.querySelector('[data-testid="band"]') as HTMLElement;
const content = (): HTMLElement => document.querySelector('[data-testid="content"]') as HTMLElement;

describe('a page header inside the shell', () => {
  it('draws the page title as the one h1, in the band, in the channel header title style', () => {
    act(() => root.render(createElement(Band, null, createElement(PageHeader, { title: 'Search', description: 'Type in the search box.' }))));
    const h1s = document.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Search');
    expect(band().contains(h1s[0]!)).toBe(true);
    expect(h1s[0]?.className).toContain('chead-title');
    // the description stays on the page, under the band
    expect(content().querySelector('.ph-desc')?.textContent).toBe('Type in the search box.');
    expect(band().querySelector('.ph-desc')).toBeNull();
  });

  it('puts the actions in the band on a wide screen', () => {
    act(() => root.render(createElement(Band, null, createElement(PageHeader, { title: 'Files', actions: createElement('button', { type: 'button' }, 'Upload') }))));
    expect(band().querySelector('.chead-actions button')?.textContent).toBe('Upload');
    // nothing is left on the page: no empty header row
    expect(content().querySelector('header')).toBeNull();
  });

  it('keeps the actions on the page on a phone, so the band stays one row', () => {
    const was = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    try {
      act(() => root.render(createElement(Band, null, createElement(PageHeader, { title: 'Chat', actions: createElement('button', { type: 'button' }, 'Bot') }))));
      expect(band().querySelector('h1')?.textContent).toBe('Chat');
      expect(band().querySelector('.chead-actions button')).toBeNull();
      expect(content().querySelector('.ph-actions button')?.textContent).toBe('Bot');
    } finally {
      window.matchMedia = was;
    }
  });

  it('an inline header (a bot head with its avatar) stays where the screen draws it, still the one h1', () => {
    act(() => root.render(createElement(Band, null, createElement(PageHeader, { title: 'Brain', inline: true }))));
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(content().querySelector('h1')?.textContent).toBe('Brain');
    expect(band().querySelector('h1')).toBeNull();
  });

  it('outside the shell (settings and account frames) the header is drawn in place', () => {
    act(() => root.render(createElement(PageHeader, { title: 'Profile', description: 'How you appear.' })));
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('header.ph h1.ph-title')?.textContent).toBe('Profile');
  });

  it('the shell draws its fallback title again once the page header is gone', () => {
    act(() => root.render(createElement(Band, null, createElement(PageHeader, { title: 'Boards' }))));
    expect([...document.querySelectorAll('h1')].map((h) => h.textContent)).toEqual(['Boards']);
    act(() => root.render(createElement(Band, null, null)));
    expect([...document.querySelectorAll('h1')].map((h) => h.textContent)).toEqual(['Fallback']);
  });
});

describe('no trail on top-level screens', () => {
  const TOP = [
    '/t/eng/threads', '/t/eng/dms', '/t/eng/search', '/t/eng/chat', '/t/eng/activity', '/t/eng/files', '/t/eng/boards', '/t/eng/approvals', '/t/eng/bots',
    '/t/eng/projects', '/t/eng/proposals', '/t/eng/memory', '/t/eng/knowledge', '/t/eng/org', '/t/eng/jobs', '/t/eng/recipes', '/t/eng/agents', '/memory', '/files', '/',
  ];
  it('a top-level screen has no link back', () => {
    for (const p of TOP) expect(headerBackFor(p), p).toBeNull();
  });
  it('a screen inside a list keeps one link back to that list', () => {
    expect(headerBackFor('/t/eng/bots/brain')).toEqual({ label: 'Bots', to: '/t/eng/bots' });
    expect(headerBackFor('/t/eng/bots/brain/settings')).toEqual({ label: 'Bots', to: '/t/eng/bots' });
    expect(headerBackFor('/t/eng/bots/brain/chat')).toEqual({ label: 'Bots', to: '/t/eng/bots' });
    expect(headerBackFor('/t/eng/bots/new')).toEqual({ label: 'Bots', to: '/t/eng/bots' });
    expect(headerBackFor('/t/eng/chat/0194f0a0')).toEqual({ label: 'Bots', to: '/t/eng/bots' });
    expect(headerBackFor('/t/eng/proposals/p1')).toEqual({ label: 'Proposals', to: '/t/eng/proposals' });
    expect(headerBackFor('/t/eng/projects/p1')).toEqual({ label: 'Projects', to: '/t/eng/projects' });
  });
  it('the shell band draws no breadcrumb', () => {
    const src = readFileSync(join(__dirname, '../src/shell/Shell.tsx'), 'utf8');
    expect(src).not.toMatch(/Breadcrumb|className="crumbs"|crumbsFor/);
  });
});

describe('the thread pane controls', () => {
  it('the right panel: Follow and Open channel, then the panel\'s Expand and Close', () => {
    expect(threadTools({ variant: 'panel', canFollow: true, channelLink: true, channelInView: false })).toEqual(['follow', 'open-channel']);
    // beside its own channel, Open channel would go nowhere
    expect(threadTools({ variant: 'panel', canFollow: true, channelLink: true, channelInView: true })).toEqual(['follow']);
    // a thread in a direct message has no channel to open
    expect(threadTools({ variant: 'panel', canFollow: true, channelLink: false, channelInView: false })).toEqual(['follow']);
    const panel = readFileSync(join(__dirname, '../src/kernel/panel/RightPanel.tsx'), 'utf8');
    const row = panel.slice(panel.indexOf('className="panel-tools"'));
    const at = (s: string): number => row.indexOf(s);
    expect(at('panel-tools-own')).toBeGreaterThan(0);
    expect(at('panel-tools-own')).toBeLessThan(at('panel-expand'));
    expect(at('panel-expand')).toBeLessThan(at('panel-close'));
  });

  it('the Threads page: Follow, Open channel and Overview', () => {
    expect(threadTools({ variant: 'main', canFollow: true, channelLink: true, channelInView: false })).toEqual(['follow', 'open-channel', 'overview']);
    expect(threadTools({ variant: 'main', canFollow: false, channelLink: true, channelInView: true })).toEqual(['open-channel', 'overview']);
  });

  it('every control is an icon button with a label and a tooltip, in one order, never a bordered text button', () => {
    const all: ThreadToolKey[] = [...THREAD_TOOL_ORDER];
    act(() =>
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(ThreadTools, { tools: all, followed: true, busy: false, onFollow: () => undefined, channelHref: '/t/eng/c/dev?message=1', channelName: 'dev', railOpen: false, railId: 'r', onRail: () => undefined }),
        ),
      ),
    );
    const controls = [...host.querySelectorAll<HTMLElement>('button, a')];
    expect(controls.map((c) => c.getAttribute('aria-label'))).toEqual(['Follow thread', 'Open channel', 'Show overview']);
    for (const c of controls) {
      expect(c.classList.contains('icon-btn'), c.outerHTML).toBe(true);
      expect(c.classList.contains('btn'), c.outerHTML).toBe(false);
      expect(c.getAttribute('title')).toBeTruthy();
      expect(c.querySelector('svg')).not.toBeNull();
      expect(c.textContent).toBe('');
    }
    expect(controls[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(controls[2]?.getAttribute('aria-expanded')).toBe('false');
    expect(controls[2]?.getAttribute('data-testid')).toBe('rail-toggle');
  });
});

describe('the sidebar section headings', () => {
  it('a channel group and a section heading share one rule', () => {
    const css = readFileSync(join(__dirname, '../src/styles/shell.css'), 'utf8');
    const shared = /\.grp,\n\.sec \{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const prop of ['font-size', 'font-weight', 'color', 'padding', 'letter-spacing', 'text-transform']) expect(shared, prop).toContain(`${prop}:`);
    // and neither sets its own size, weight or colour after it
    for (const sel of ['.grp', '.sec']) {
      const own = new RegExp(`\\}\\n\\n\\${sel} \\{([^}]*)\\}`).exec(css)?.[1];
      expect(own, sel).toBeDefined();
      expect(own, sel).not.toMatch(/font-size|font-weight|\bcolor:|letter-spacing/);
    }
  });
});

describe('monospace is for code only', () => {
  it('the setup count, a thread row\'s channel and meta, and sizes and times in lists use the body font', () => {
    const rules: Array<[string, string]> = [
      ['onboarding.css', '.ob-card-title .cnt'], ['onboarding.css', '.ob-num'], ['channels.css', '.trow .ch'], ['channels.css', '.trow .meta'], ['files.css', '.frow .sz'],
      ['screens.css', '.bh .cnt'], ['screens.css', '.mono-list span'], ['later.css', '.lt-when'], ['scheduled.css', '.sch-when'], ['shell.css', '.panel-empty-id'],
    ];
    for (const [file, sel] of rules) {
      const css = readFileSync(join(__dirname, '../src/styles', file), 'utf8');
      const body = css.split('\n' + sel + ' {')[1]?.split('}')[0];
      expect(body, `${file} ${sel}`).toBeDefined();
      expect(body, `${file} ${sel}`).not.toContain('var(--mono)');
    }
  });
});
