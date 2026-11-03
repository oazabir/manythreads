import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SURFACE_REGISTRY } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { CHART_H, CHART_W, chartShape, classifyDiff, fitText, formatValue } from '../src/surfaces/draw';
import { SurfaceHostContext, type SurfaceHost } from '../src/surfaces/host';
import { Surface } from '../src/surfaces/Surface';
import { SURFACE_VIEWS, SurfaceActionsContext, type SurfaceActions } from '../src/surfaces/views';

// The primitives and the manythreads parts (PLAN P9-05): what each one draws, that nothing a bot writes becomes markup, an address or an image, and that a
// part whose values are refused is a card in its place.

const CAN_SEND: SurfaceActions = { send: () => Promise.resolve(), answered: new Set(), busy: false };
const html = (source: string, host?: SurfaceHost, actions?: SurfaceActions): string => {
  let el: ReactElement = createElement(Surface, { source, ended: true });
  if (host) el = createElement(SurfaceHostContext.Provider, { value: host }, el);
  if (actions) el = createElement(SurfaceActionsContext.Provider, { value: actions }, el);
  return renderToStaticMarkup(el);
};
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const PAYLOAD = '<img src=x onerror=alert(1)><script>boom()</script>';
const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;boom()&lt;/script&gt;';

describe('every registered part has a drawing', () => {
  it('SURFACE_VIEWS and the registry list the same names', () => {
    expect([...SURFACE_VIEWS.keys()].sort()).toEqual(SURFACE_REGISTRY.names());
  });
});

describe('layout and small parts', () => {
  it('Row, Grid, Divider, Badge, Callout, List', () => {
    const out = html(
      [
        'root = Stack([r, g, d, c, l, l2])',
        'r = Row([b1, b2], "small", "between")',
        'b1 = Badge("Open", "good")',
        'b2 = Badge("Late", "bad")',
        'g = Grid([b1, b2], 3)',
        'd = Divider()',
        'c = Callout("Check this", "warn", "Heads up")',
        'l = List(["one", "two"])',
        'l2 = List(["first", "second"], true)',
        '',
      ].join('\n'),
    );
    expect(out).toContain('sf-row sf-gap-small sf-align-between');
    expect(out).toContain('sf-grid sf-cols-3 sf-gap-medium');
    expect(out).toContain('sf-badge sf-tint-good');
    expect(out).toContain('sf-badge sf-tint-bad');
    expect(out).toContain('<hr class="sf-divider"/>');
    expect(out).toContain('sf-callout sf-tint-warn');
    expect(out).toContain('>Heads up<');
    expect(out).toContain('<ul class="sf-list">');
    expect(out).toContain('<ol class="sf-list">');
    expect(out).not.toContain('surface-rejection');
  });

  it('Stat draws the label, the figure and the change', () => {
    const out = html('root = Stat("Revenue", 4200, "+4%", "good")\n');
    expect(out).toContain('>Revenue<');
    expect(out).toContain('>4200<');
    expect(out).toContain('sf-stat-delta sf-ink-good">+4%<');
  });
});

describe('Table', () => {
  it('draws headers and cells, empty for null', () => {
    const out = html('root = Table(["Name", "Qty"], [["Pens", 4], ["Ink", null], ["Paper"]], "Stock")\n');
    expect(count(out, '<th scope="col">')).toBe(2);
    expect(count(out, '<tr>')).toBe(4);
    expect(out).toContain('<caption>Stock</caption>');
    expect(out).toContain('<td>Pens</td><td>4</td>');
    expect(out).toContain('<td>Ink</td><td></td>');
    expect(out).toContain('<td>Paper</td><td></td>');
    expect(out).toContain('class="sf-table-wrap"');
  });
  it('draws text in a cell as text', () => {
    const out = html(`root = Table(["a"], [["${PAYLOAD}"]])\n`);
    expect(out).toContain(ESCAPED);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
  });
  it('a row wider than the columns is a card, not a table', () => {
    const out = html('root = Table(["a"], [["x", "y"]])\n');
    expect(out).toContain('data-code="invalid_props"');
    expect(out).not.toContain('<table');
  });
});

describe('Chart', () => {
  it('draws bars with a table of the same numbers', () => {
    const out = html('root = Chart("bar", ["Mon", "Tue", "Wed"], [3, 5, -2], "Visits", "k")\n');
    expect(out).toContain('<svg');
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="Visits: 3 values. The same numbers are in the table below."');
    expect(count(out, 'class="sf-chart-bar"')).toBe(3);
    expect(out).toContain('<details class="sf-chart-data">');
    expect(out).toContain('<td>Mon</td><td>3</td>');
    expect(out).toContain('<td>Wed</td><td>-2</td>');
    expect(out).toContain('Value (k)');
  });
  it('draws a line with one dot for each number', () => {
    const out = html('root = Chart("line", ["a", "b"], [1, 2])\n');
    expect(count(out, 'class="sf-chart-dot"')).toBe(2);
    expect(out).toContain('<polyline class="sf-chart-line" points="');
    expect(out).not.toContain('sf-chart-bar');
  });
  it('a label with markup is text everywhere it appears', () => {
    const out = html(`root = Chart("bar", ["${PAYLOAD}"], [1])\n`);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
  });
  it('count mismatch and bad numbers are cards', () => {
    expect(html('root = Chart("bar", ["a", "b"], [1])\n')).toContain('data-code="invalid_props"');
    expect(html('root = Chart("bar", ["a"], ["1"])\n')).toContain('data-code="invalid_props"');
  });
  it('chartShape keeps every number inside the box, with zero on its own line', () => {
    const s = chartShape([10, 0, -10, 5]);
    for (const b of s.bars) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(CHART_W);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(CHART_H);
    }
    expect(s.bars[0]!.y + s.bars[0]!.h).toBeCloseTo(s.zeroY, 1);
    expect(s.bars[2]!.y).toBeCloseTo(s.zeroY, 1);
    expect(s.bars[0]!.h).toBeGreaterThan(s.bars[3]!.h);
    expect(chartShape([0, 0]).bars.every((b) => Number.isFinite(b.y) && Number.isFinite(b.h))).toBe(true);
    expect(chartShape([1e12, -1e12]).dots.every((d) => Number.isFinite(d.y))).toBe(true);
  });
});

describe('Code', () => {
  it('draws the text exactly, as text', () => {
    const out = html(`root = Code("${PAYLOAD}", "html")\n`);
    expect(out).toContain('<pre class="sf-code"');
    expect(out).toContain('data-language="html"');
    expect(out).toContain(ESCAPED);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
  });
});

describe('Button (P9-04) beside the other parts', () => {
  it('is drawn but cannot be pressed until the page lends a way to send', () => {
    const out = html('root = Button("Approve", "primary")\n');
    expect(out).toContain('data-testid="surface-button"');
    expect(out).toContain('disabled=""');
  });
  it('can be pressed when the page lends send, and the label is text', () => {
    expect(html('root = Button("Approve")\n', undefined, CAN_SEND)).not.toContain('disabled');
    const out = html(`root = Button("${PAYLOAD}")\n`, undefined, CAN_SEND);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});

describe('the manythreads parts', () => {
  it('without a lookup they draw a plain chip from the label, and no address', () => {
    const out = html(
      [
        'root = Stack([e, p, c, a])',
        'e = EntityCard("task", "t-1", "Fix the login", "Due Friday")',
        'p = PersonChip("u-1", "Sam")',
        'c = ChannelLink("ch-1", "general")',
        'a = ApprovalCard("ap-1", "Send the mail", "To: sam")',
        '',
      ].join('\n'),
    );
    expect(out).toContain('data-entity-type="task"');
    expect(out).toContain('>Fix the login<');
    expect(out).toContain('>Due Friday<');
    expect(out).toContain('sf-chip sf-chip-person');
    expect(out).toContain('>Sam<');
    expect(out).toContain('sf-chip sf-chip-channel');
    expect(out).toContain('># general<');
    expect(out).toContain('>Send the mail<');
    expect(out).toContain('A person decides this in the approvals list.');
    expect(out).toContain('data-resolved="false"');
    expect(out).not.toContain('href=');
    expect(out).not.toContain('src=');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('<img');
  });

  it('with a lookup they show what the viewer may see, not the bot label', () => {
    const host: SurfaceHost = {
      personName: (id) => (id === 'u-1' ? 'Samira Khan' : null),
      channelName: (id) => (id === 'ch-1' ? 'ops' : null),
      openChannel: () => undefined,
      entity: (type, id) => (type === 'task' && id === 't-1' ? { label: 'Real title', summary: 'Real summary' } : null),
      approvalStatus: (id) => (id === 'ap-1' ? 'approved' : null),
    };
    const out = html(
      [
        'root = Stack([e, p, c, a, hidden])',
        'e = EntityCard("task", "t-1", "Bot title", "Bot summary")',
        'p = PersonChip("u-1", "Bot name")',
        'c = ChannelLink("ch-1", "bot channel")',
        'a = ApprovalCard("ap-1", "Send the mail")',
        'hidden = PersonChip("u-9", "Label only")',
        '',
      ].join('\n'),
      host,
    );
    expect(out).toContain('>Real title<');
    expect(out).toContain('>Real summary<');
    expect(out).not.toContain('Bot title');
    expect(out).not.toContain('Bot summary');
    expect(out).toContain('>Samira Khan<');
    expect(out).not.toContain('Bot name');
    expect(out).toContain('<button type="button" class="sf-chip sf-chip-channel sf-chip-link"');
    expect(out).toContain('># ops<');
    expect(out).toContain('>Approved<');
    expect(out).toContain('This was decided in the approvals list.');
    // an id the viewer may not see falls back to the label, never to anything else
    expect(out).toContain('>Label only<');
  });

  it('a channel is a link only when the page can open it', () => {
    const out = html('root = ChannelLink("ch-1", "general")\n', { channelName: () => 'general' });
    expect(out).not.toContain('<button');
  });

  it('ApprovalCard never draws a way to decide', () => {
    const out = html('root = ApprovalCard("ap-1", "Delete everything")\n', { approvalStatus: () => 'waiting' }, CAN_SEND);
    expect(out).toContain('Waiting for a person');
    expect(out).not.toContain('<button');
  });

  it('labels and summaries are text; an id that is an address is refused', () => {
    const out = html(`root = Stack([a, b, c])\na = PersonChip("u-1", "${PAYLOAD}")\nb = EntityCard("task", "t", "${PAYLOAD}", "${PAYLOAD}")\nc = ChannelLink("http://evil.example/x.png", "x")\n`);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('evil.example/x.png"');
    expect(count(out, 'data-testid="surface-rejection"')).toBe(1);
    expect(out).toContain('data-code="invalid_props"');
  });
});

describe('DiffView', () => {
  const DIFF = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ' keep', '-removed', '+added', '--dashes', '++plus'].join('\\n');

  it('classifies the headers, hunk, added, removed and context lines', () => {
    const lines = classifyDiff(DIFF.replaceAll('\\n', '\n'));
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'del', 'add']);
  });
  it('a second file starts again from its header, and a trailing newline adds no line', () => {
    const lines = classifyDiff('@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n+c\n');
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'add', 'meta', 'meta', 'meta', 'hunk', 'add']);
    expect(classifyDiff('a\r\n+b').map((l) => l.text)).toEqual(['a', '+b']);
  });
  it('draws each line with its colour class, and keeps the plus and minus signs', () => {
    const out = html(`root = DiffView("${DIFF}", "x.ts")\n`);
    expect(out).toContain('class="sf-diff-line sf-diff-add">+added<');
    expect(out).toContain('class="sf-diff-line sf-diff-del">-removed<');
    expect(out).toContain('class="sf-diff-line sf-diff-hunk">@@ -1,3 +1,3 @@<');
    expect(out).toContain('class="sf-diff-line sf-diff-ctx"> keep<');
    expect(out).toContain('class="sf-diff-line sf-diff-meta">+++ b/x.ts<');
    expect(out).toContain('>x.ts<');
    expect(out).toContain('+2 -2');
  });
  it('markup in a line is text', () => {
    const out = html(`root = DiffView("@@ -1 +1 @@\\n-${PAYLOAD}\\n+${PAYLOAD}")\n`);
    expect(out).toContain(`-${ESCAPED}`);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
  });
  it('a diff over the caps is a card, and the rest of the screen stays', () => {
    const big = Array.from({ length: 401 }, () => '+a').join('\\n');
    const out = html(`root = Stack([a, b])\na = DiffView("${big}")\nb = Text("still here")\n`);
    expect(out).toContain('data-code="invalid_props"');
    expect(out).toContain('>still here<');
    expect(out).not.toContain('sf-diff-body');
  });
});

// ---- polish found on the live site: numerals, a table that scrolls, labelled bars ----

const CSS = readFileSync(new URL('../src/styles/surfaces.css', import.meta.url), 'utf8');
/** The declarations of the one rule whose selector is exactly `selector`. */
const rule = (selector: string): string => {
  const at = CSS.split('\n').findIndex((l) => l === `${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const body: string[] = [];
  for (const l of CSS.split('\n').slice(at + 1)) {
    if (l === '}') break;
    body.push(l.trim());
  }
  return body.join(' ');
};

describe('List shows numerals when ordered, bullets when not', () => {
  it('draws <ol> for an ordered list and <ul> for the other, each with its own marker style', () => {
    const out = html('root = Stack([a, b])\na = List(["one", "two"])\nb = List(["first", "second"], true)\n');
    expect(out).toContain('<ul class="sf-list">');
    expect(out).toContain('<ol class="sf-list">');
    expect(rule('ol.sf-list')).toContain('list-style-type: decimal');
    expect(rule('ul.sf-list')).toContain('list-style-type: disc');
    expect(rule('.sf-list')).not.toContain('list-style: none');
    expect(rule('.sf-li')).toContain('display: list-item');
  });
});

describe('Table keeps its columns readable and scrolls inside its own box', () => {
  it('scrolls sideways in the wrapper, gives cells a minimum width and never breaks a word anywhere', () => {
    expect(rule('.sf-table-wrap')).toContain('overflow-x: auto');
    const cells = rule('.sf-table td');
    expect(cells).toMatch(/min-width: \d+ch/);
    expect(cells).not.toContain('overflow-wrap: anywhere');
    expect(cells).not.toContain('word-break: break-all');
  });
});

describe('Chart bars carry their names and numbers as text', () => {
  it('writes the value for each bar and the name under it, in the drawing', () => {
    const out = html('root = Chart("bar", ["Mon", "Tue", "Wed"], [3, 5, -2], "Visits", "k")\n');
    expect(count(out, 'data-testid="surface-chart-mark"')).toBe(3);
    expect(out).toMatch(/<text class="sf-chart-label" x="[\d.]+" y="[\d.]+">Tue<\/text>/);
    expect(out).toMatch(/<text class="sf-chart-value" x="[\d.]+" y="[\d.]+">5<\/text>/);
    expect(out).toMatch(/<text class="sf-chart-value" x="[\d.]+" y="[\d.]+">-2<\/text>/);
    expect(out).toContain('<details class="sf-chart-data">');
    expect(out).toContain('Show the numbers');
  });
  it('a line chart is labelled the same way', () => {
    const out = html('root = Chart("line", ["a", "b"], [1, 2])\n');
    expect(out).toContain('class="sf-chart-label"');
    expect(out).toContain('class="sf-chart-value"');
  });
  it('a name with markup stays text', () => {
    const out = html(`root = Chart("bar", ["${PAYLOAD}"], [1])\n`);
    expect(out).not.toContain('<img');
    expect(out).toContain('class="sf-chart-label"');
  });
  it('writes a value above a rise and below a fall, names along the bottom, inside the box', () => {
    const s = chartShape([10, -10, 4]);
    expect(s.marks[0]!.valueY).toBeLessThan(s.bars[0]!.y);
    expect(s.marks[1]!.valueY).toBeGreaterThan(s.bars[1]!.y + s.bars[1]!.h);
    for (const m of s.marks) {
      expect(m.valueY).toBeGreaterThan(0);
      expect(m.valueY).toBeLessThan(s.labelY);
    }
    expect(s.labelY).toBeLessThanOrEqual(CHART_H);
    expect(s.bars[1]!.y + s.bars[1]!.h).toBeLessThan(s.labelY - 9);
  });
  it('fits a name to its slot and leaves it out when there is no room', () => {
    expect(fitText('Mon', 100)).toBe('Mon');
    expect(fitText('A very long category name', 30)).toBe('A ver…');
    expect(fitText('Mon', 8)).toBe('');
    expect(formatValue(1234567.891)).toBe('1,234,567.89');
    expect(formatValue(-2)).toBe('-2');
  });
  it('many bars drop the names that cannot fit but keep the numbers in the table', () => {
    const labels = Array.from({ length: 40 }, (_, i) => `Item ${String(i)}`);
    const out = html(`root = Chart("bar", ${JSON.stringify(labels)}, ${JSON.stringify(labels.map((_, i) => i))})\n`);
    expect(count(out, 'class="sf-chart-label"')).toBe(0);
    expect(out).toContain('<td>Item 39</td><td>39</td>');
  });
});
