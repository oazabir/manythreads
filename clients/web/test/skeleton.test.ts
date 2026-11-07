import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../src/components/EmptyState';
import { SkeletonMessages, SkeletonRows } from '../src/components/Skeleton';
import { ApprovalsIcon } from '../src/shell/icons';

const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Skeleton', () => {
  it('rows are a busy status region with a label and no readable text', () => {
    const html = renderToStaticMarkup(createElement(SkeletonRows, { rows: 3, label: 'Loading approvals' }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading approvals"');
    expect(html.match(/class="sk-row"/g)).toHaveLength(3);
    expect(html).not.toContain('Loading…');
  });

  it('rows draw an avatar only when asked, and always at least one row', () => {
    expect(renderToStaticMarkup(createElement(SkeletonRows, { rows: 2 }))).not.toContain('sk-av');
    const html = renderToStaticMarkup(createElement(SkeletonRows, { rows: 0, avatar: true }));
    expect(html.match(/class="sk-row"/g)).toHaveLength(1);
    expect(html).toContain('sk-av');
  });

  it('messages are a busy status region with their own label', () => {
    const html = renderToStaticMarkup(createElement(SkeletonMessages, { count: 3 }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading messages"');
    expect(html.match(/class="sk-msg"/g)).toHaveLength(3);
  });

  it('the bars of a stack differ in width but are the same on every render', () => {
    const a = renderToStaticMarkup(createElement(SkeletonRows, { rows: 5 }));
    expect(a).toBe(renderToStaticMarkup(createElement(SkeletonRows, { rows: 5 })));
    expect(new Set(a.match(/width:\d+%/g)).size).toBeGreaterThan(3);
  });
});

describe('EmptyState', () => {
  it('draws the icon, the title, the help and one button', () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { icon: ApprovalsIcon, title: 'Nothing waiting', testId: 'x', action: { label: 'See what was decided', onClick: () => undefined } }, 'Requests show up here.'),
    );
    expect(html).toContain('data-testid="x"');
    expect(html).toContain('es-icon');
    expect(html).toContain('<svg');
    expect(html).toContain('Nothing waiting');
    expect(html).toContain('Requests show up here.');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('See what was decided');
  });

  it('has no action when none is given', () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { icon: ApprovalsIcon, title: 'Nothing' }));
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });
});

describe('motion.css', () => {
  const css = src('../src/styles/motion.css');

  it('is loaded after states.css and every other style file', () => {
    const main = src('../src/main.tsx');
    const imports = [...main.matchAll(/import '\.\/styles\/([\w-]+)\.css';/g)].map((m) => m[1]);
    expect(imports.at(-1)).toBe('motion');
    expect(imports.indexOf('motion')).toBeGreaterThan(imports.indexOf('states'));
  });

  it('runs every animation only for people who have not asked for reduced motion', () => {
    // strip the keyframes, then every `animation` must sit inside the no-preference block
    const withoutKeyframes = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    const outside = withoutKeyframes.replace(/@media \(prefers-reduced-motion: no-preference\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    expect(outside).not.toMatch(/animation|transition/);
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
  });

  it('adds animation only: no colour, size or position of its own besides the glow start colour', () => {
    const declared = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
    const allowed = new Set(['animation', 'opacity', 'translate', 'background-color']);
    expect(declared.filter((d) => !allowed.has(d!))).toEqual([]);
  });
});
