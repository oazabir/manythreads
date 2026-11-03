import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { SURFACE_REGISTRY, createSurfaceRegistry, defineSurfaceComponent, parseSurface, resolveSurface } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { PartBoundary, Surface, SurfaceTreeView } from '../src/surfaces/Surface';
import { advanceSurfaceFeed } from '../src/surfaces/stream';
import { type SurfaceView } from '../src/surfaces/views';

// The surface renderer (PLAN P9-03): what is drawn for a text a bot wrote, while it arrives, and in place of a part that was refused.

const SALES = ['root = Stack([title, body], "large")', 'title = Heading("Sales this week", 1)', 'body = Text("Up four percent.", "muted")', ''].join('\n');

const html = (source: string, ended = true, extra: { registry?: Parameters<typeof Surface>[0]['registry']; views?: ReadonlyMap<string, SurfaceView> } = {}): string =>
  renderToStaticMarkup(createElement(Surface, { source, ended, ...extra }));
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('a finished surface', () => {
  it('draws every registered part with its props', () => {
    const out = html(SALES);
    expect(out).toContain('data-testid="surface"');
    expect(out).toContain('data-complete="true"');
    expect(out).toContain('sf-stack sf-gap-large');
    expect(out).toContain('role="heading"');
    expect(out).toContain('>Sales this week<');
    expect(out).toContain('sf-text sf-tone-muted');
    expect(out).toContain('>Up four percent.<');
    expect(out).not.toContain('surface-rejection');
    expect(out).not.toContain('surface-pending');
  });

  it('draws text as text, never as markup', () => {
    const out = html('root = Text("<img src=x onerror=alert(1)> <script>boom()</script> [a](javascript:x) **b**")\n');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('&lt;script&gt;boom()&lt;/script&gt;');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('<strong');
  });
});

describe('a part that was refused', () => {
  it('an unknown name becomes a card in its place, and the rest is drawn', () => {
    const out = html('root = Stack([a, b, c])\na = Text("before")\nb = Chart3D([1, 2])\nc = Text("after")\n');
    expect(count(out, 'data-testid="surface-rejection"')).toBe(1);
    expect(out).toContain('data-code="unknown_component"');
    expect(out).toContain('This part is not available');
    expect(out).toContain('&quot;Chart3D&quot; is not a part this app can draw');
    expect(out).toContain('>before<');
    expect(out).toContain('>after<');
    expect(out.indexOf('>before<')).toBeLessThan(out.indexOf('surface-rejection'));
    expect(out.indexOf('surface-rejection')).toBeLessThan(out.indexOf('>after<'));
  });

  it('props that do not fit become a card, and the value is not drawn', () => {
    const out = html('root = Stack([a, b])\na = Heading("Visible", 1)\nb = Heading("Hidden level", 9)\n');
    expect(out).toContain('data-code="invalid_props"');
    expect(out).toContain('This part has values it cannot use');
    expect(out).toContain('>Visible<');
    expect(out).not.toContain('>Hidden level<');
    expect(count(out, 'role="heading"')).toBe(1);
  });

  it('a wrong type and a missing value are refused the same way', () => {
    expect(html('root = Text(42)\n')).toContain('data-code="invalid_props"');
    expect(html('root = Heading()\n')).toContain('data-code="invalid_props"');
  });

  it('a card shows what the bot wrote about itself as text', () => {
    const out = html('root = <b onmouseover=x>bad</b>\n');
    expect(out).toContain('data-code="syntax"');
    expect(out).not.toContain('<b ');
    const named = html('root = Evil<script>("x")\n');
    expect(named).not.toContain('<script');
  });

  it('a part registered on the server that this client has no drawing for is a card, not a gap', () => {
    const registry = createSurfaceRegistry([defineSurfaceComponent({ name: 'Gauge', summary: 'x', args: ['value'], props: z.object({ value: z.number() }) })]);
    const out = html('root = Gauge(3)\n', true, { registry });
    expect(out).toContain('data-code="unknown_component"');
    expect(out).toContain('Gauge is not something this version of the app can draw yet');
  });

  it('a drawing that throws is caught at that part: the boundary answers with a card', () => {
    // React's server renderer does not run error boundaries, so the boundary is exercised through its two hooks: what it keeps after an error and what it draws then.
    const boundary = new PartBoundary({ children: null, label: 'Heading' });
    expect(boundary.state.failed).toBe(false);
    boundary.state = PartBoundary.getDerivedStateFromError();
    const out = renderToStaticMarkup(boundary.render() as ReactElement);
    expect(out).toContain('This part could not be drawn');
    expect(out).toContain('data-testid="surface-rejection"');
    expect(out).toContain('Heading');
  });

  it('a text with nothing to draw says so once it has ended', () => {
    const out = html('a = Text("not the root")\n');
    expect(out).toContain('data-code="unresolved_ref"');
    expect(out).toContain('There is no &quot;root&quot; statement');
  });
});

describe('a surface that is still arriving', () => {
  it('draws what has arrived and a placeholder for each part still to come', () => {
    const early = html('root = Stack([title, body])\ntitle = Heading("Sales", 1)\n', false);
    expect(early).toContain('data-complete="false"');
    expect(early).toContain('aria-busy="true"');
    expect(early).toContain('>Sales<');
    expect(count(early, 'data-testid="surface-pending"')).toBe(1);
    expect(early).not.toContain('surface-rejection');

    const done = html('root = Stack([title, body])\ntitle = Heading("Sales", 1)\nbody = Text("Ready.")\n', true);
    expect(done).toContain('>Ready.<');
    expect(done).not.toContain('surface-pending');
    expect(done).toContain('data-complete="true"');
  });

  it('draws nothing but a placeholder before the first statement, and never a half written part', () => {
    expect(html('', false)).toContain('surface-pending');
    const half = html('root = Stack([a])\na = Text("Up to he', false);
    expect(half).toContain('surface-pending');
    expect(half).not.toContain('Up to he');
  });

  it('a part that fails its check while the text arrives is a card straight away, and the parts after it still arrive', () => {
    const text = 'root = Stack([a, b, c])\na = Text("one")\nb = Nope(1)\n';
    const mid = html(text, false);
    expect(mid).toContain('data-code="unknown_component"');
    expect(mid).toContain('>one<');
    expect(count(mid, 'surface-pending')).toBe(1);
    const end = html(`${text}c = Text("three")\n`, true);
    expect(end).toContain('>three<');
    expect(end).not.toContain('surface-pending');
  });

  it('every way of cutting the text gives the same screen as the whole text', () => {
    const whole = html(SALES);
    for (const size of [1, 4, 11]) {
      let feed = null as ReturnType<typeof advanceSurfaceFeed> | null;
      for (let i = size; i < SALES.length + size; i += size) feed = advanceSurfaceFeed(feed, SALES.slice(0, Math.min(i, SALES.length)), i >= SALES.length);
      const out = renderToStaticMarkup(createElement(SurfaceTreeView, { tree: resolveSurface(feed!.state, SURFACE_REGISTRY) }));
      expect(out, `pieces of ${size}`).toBe(whole);
    }
  });
});

describe('reading only what is new', () => {
  it('goes on from the text it has seen, and starts again when the text is a different one', () => {
    const a = advanceSurfaceFeed(null, 'root = Text("one")\n', false);
    const b = advanceSurfaceFeed(a, 'root = Text("one")\nextra = Text("two")\n', false);
    expect(b.state.statements.length).toBe(2);
    expect(b.state.statements[0]).toBe(a.state.statements[0]);
    // the same text again changes nothing
    expect(advanceSurfaceFeed(b, b.fed, false)).toBe(b);
    // a patched surface: the text no longer goes on from the old one
    const c = advanceSurfaceFeed(b, 'root = Text("changed")\n', true);
    expect(c.state.statements.length).toBe(1);
    expect(parseSurface(c.fed, SURFACE_REGISTRY).root).toMatchObject({ kind: 'component', props: { text: 'changed' } });
  });

  it('closing the text turns the last statement into a part', () => {
    const open = advanceSurfaceFeed(null, 'root = Text("last")', false);
    expect(resolveSurface(open.state, SURFACE_REGISTRY).root).toBeNull();
    const closed = advanceSurfaceFeed(open, 'root = Text("last")', true);
    expect(resolveSurface(closed.state, SURFACE_REGISTRY).root).toMatchObject({ kind: 'component', name: 'Text' });
  });

  it('text that grows after it ended starts again instead of being lost', () => {
    const ended = advanceSurfaceFeed(null, 'root = Text("a")\n', true);
    const grown = advanceSurfaceFeed(ended, 'root = Text("a")\nmore = Text("b")\n', true);
    expect(grown.state.statements.length).toBe(2);
  });
});

describe('the node type is not smuggled in', () => {
  it('the tree view draws exactly the nodes it was given', () => {
    const tree = parseSurface('root = Text("x")\n', SURFACE_REGISTRY);
    const out: ReactNode = renderToStaticMarkup(createElement(SurfaceTreeView, { tree }));
    expect(out).toContain('>x<');
  });
});
