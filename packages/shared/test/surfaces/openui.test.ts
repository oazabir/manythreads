import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { expectLinear } from '../../../test-utils/src/linear.ts';
import {
  SURFACE_MAX_DEPTH,
  SURFACE_MAX_RENDER_NODES,
  SURFACE_REGISTRY,
  SURFACE_SOURCE_MAX,
  createSurfaceRegistry,
  createSurfaceStreamState,
  defineSurfaceComponent,
  endSurface,
  feedSurface,
  parseSurface,
  resolveSurface,
  type SurfaceNode,
  type SurfaceTree,
} from '../../src/index.ts';

// The checker between a bot's OpenUI Lang text and the screen (PLAN P9-02, P9-03): every part drawn is a registered name with props that passed its schema.

const SALES = ['root = Stack([title, body], "large")', 'title = Heading("Sales this week", 1)', 'body = Text("Up four percent.", "muted")', ''].join('\n');

/** A compact view of a node: `Name(child, child)`, `!code(id)` for a rejection, `~id` for a part still to come. */
function show(n: SurfaceNode | null): string {
  if (n === null) return '-';
  if (n.kind === 'pending') return `~${n.id}`;
  if (n.kind === 'rejected') return `!${n.code}(${n.id})`;
  return n.children.length === 0 ? n.name : `${n.name}(${n.children.map(show).join(', ')})`;
}

const stream = (chunks: string[], end = true): SurfaceTree => {
  let s = createSurfaceStreamState();
  for (const c of chunks) s = feedSurface(s, c);
  return resolveSurface(end ? endSurface(s) : s, SURFACE_REGISTRY);
};
const chunked = (text: string, size: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

describe('reading a whole surface', () => {
  it('draws a tree of registered parts with the props their schemas produced', () => {
    const tree = parseSurface(SALES, SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Stack(Heading, Text)');
    expect(tree.problems).toEqual([]);
    expect(tree.complete).toBe(true);
    const root = tree.root!;
    expect(root.kind === 'component' && root.props).toEqual({ gap: 'large' });
    const kids = root.kind === 'component' ? root.children : [];
    expect(kids[0]!.kind === 'component' && kids[0]!.props).toEqual({ text: 'Sales this week', level: 1 });
    expect(kids[1]!.kind === 'component' && kids[1]!.props).toEqual({ text: 'Up four percent.', tone: 'muted' });
  });

  it('takes parts written inline, null for a skipped value, and a single child that is not in a list', () => {
    const tree = parseSurface('root = Stack(Heading("One", null))\n', SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Stack(Heading)');
    const inline = parseSurface('root = Stack([Heading("A", 2), Text("b")], null)\n', SURFACE_REGISTRY);
    expect(show(inline.root)).toBe('Stack(Heading, Text)');
    expect(inline.root!.kind === 'component' && inline.root!.children.map((c) => c.id)).toEqual(['root.0', 'root.1']);
  });

  it('reads a statement over several lines, a trailing comma, and escapes in a text', () => {
    const tree = parseSurface('root = Stack([\n  a,\n  b,\n])\na = Text("line\\none \\"quoted\\" \\u00e9")\nb = Text("x")\n', SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Stack(Text, Text)');
    const a = tree.root!.kind === 'component' ? tree.root!.children[0]! : null;
    expect(a?.kind === 'component' && a.props['text']).toBe('line\none "quoted" \u00e9');
  });

  it('ignores a code fence around the text and blank lines', () => {
    const tree = parseSurface('```openui\n\nroot = Text("hi")\n\n```\n', SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Text');
    expect(tree.problems).toEqual([]);
  });

  it('lets a value be shared through the name of a plain statement', () => {
    const reg = createSurfaceRegistry([defineSurfaceComponent({ name: 'Bars', summary: 'x', args: ['values'], props: z.object({ values: z.array(z.number()).max(10) }) })]);
    const tree = parseSurface('root = Bars(data)\ndata = [1, 2.5, -3e2]\n', reg);
    expect(tree.root!.kind === 'component' && tree.root!.props).toEqual({ values: [1, 2.5, -300] });
    const bad = parseSurface('root = Bars(data)\ndata = ["a"]\n', reg);
    expect(show(bad.root)).toBe('!invalid_props(root)');
  });
});

describe('what is refused, and what is kept around it', () => {
  it('an unregistered name is a rejection card, never a part; its neighbours stay', () => {
    const tree = parseSurface('root = Stack([a, b, c])\na = Text("before")\nb = Chart3D([1, 2])\nc = Text("after")\n', SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Stack(Text, !unknown_component(b), Text)');
    expect(tree.problems).toEqual([{ code: 'unknown_component', id: 'b', message: '"Chart3D" is not a part this app can draw' }]);
  });

  it('names every object has are not parts', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'Object']) {
      const tree = parseSurface(`root = ${name}("x")\n`, SURFACE_REGISTRY);
      expect(show(tree.root), name).toBe('!unknown_component(root)');
    }
  });

  it('props that do not fit are refused with a plain reason', () => {
    const tree = parseSurface('root = Stack([a, b, c, d])\na = Heading("ok", 1)\nb = Heading("bad level", 9)\nc = Heading(42)\nd = Text("fine")\n', SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Stack(Heading, !invalid_props(b), !invalid_props(c), Text)');
    const b = tree.problems.find((p) => p.id === 'b')!;
    expect(b.message).toMatch(/^Heading was given values it cannot use: "level"/);
    expect(tree.problems.find((p) => p.id === 'c')!.message).toMatch(/"text"/);
  });

  it('a missing required value, too many values, and a part used as a value are refused', () => {
    expect(show(parseSurface('root = Heading()\n', SURFACE_REGISTRY).root)).toBe('!invalid_props(root)');
    expect(show(parseSurface('root = Text("a", "muted", 1, 2)\n', SURFACE_REGISTRY).root)).toBe('!invalid_props(root)');
    expect(show(parseSurface('root = Heading(Text("x"))\n', SURFACE_REGISTRY).root)).toBe('!invalid_props(root)');
  });

  it('something that is not a part cannot be a child, or the root', () => {
    expect(show(parseSurface('root = Stack(["text", 3, x])\nx = [1]\n', SURFACE_REGISTRY).root)).toBe('Stack(!invalid_props(root.0), !invalid_props(root.1), !invalid_props(x))');
    expect(show(parseSurface('root = "hello"\n', SURFACE_REGISTRY).root)).toBe('!invalid_props(root)');
  });

  it('a line that is not a statement is a syntax problem and the rest still draws', () => {
    const tree = parseSurface('root = Stack([a, b])\nthis is not a statement\na = Text("kept")\nb = Heading("Broken", \nc = Text("also kept")\n', SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Stack(Text, !syntax(b))');
    expect(tree.problems.map((p) => p.code).sort()).toEqual(['syntax', 'syntax']);
  });

  it('a forgotten closing bracket does not swallow the statements after it', () => {
    const tree = parseSurface('root = Stack([a, b]\na = Text("one")\nb = Text("two")\n', SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('!syntax(root)');
    // the statements after the broken one are still read, and a surface whose root works beside them draws
    const ok = parseSurface('root = Stack([a, b])\na = Text("one"\nb = Text("two")\n', SURFACE_REGISTRY);
    expect(show(ok.root)).toBe('Stack(!syntax(a), Text)');
  });

  it('a text with a raw new line in it ends at the line and the rest is kept', () => {
    const tree = parseSurface('root = Stack([a, b])\na = Text("one\nb = Text("two")\n', SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Stack(!syntax(a), Text)');
  });

  it('a statement used but never written is refused at the end, and waits while text is coming', () => {
    expect(show(parseSurface('root = Stack([a, ghost])\na = Text("x")\n', SURFACE_REGISTRY).root)).toBe('Stack(Text, !unresolved_ref(ghost))');
    expect(show(stream(['root = Stack([a, ghost])\na = Text("x")\n'], false).root)).toBe('Stack(Text, ~ghost)');
  });

  it('no root at the end is a problem; before the end it is only not there yet', () => {
    const none = parseSurface('a = Text("x")\n', SURFACE_REGISTRY);
    expect(none.root).toBeNull();
    expect(none.problems).toEqual([{ code: 'unresolved_ref', id: 'root', message: 'There is no "root" statement, so there is nothing to draw' }]);
    expect(stream(['a = Text("x")\n'], false).problems).toEqual([]);
  });

  it('a name written twice keeps the first', () => {
    const tree = parseSurface('root = Text("first")\nroot = Text("second")\n', SURFACE_REGISTRY);
    expect(tree.root!.kind === 'component' && tree.root!.props['text']).toBe('first');
    expect(tree.problems.map((p) => p.code)).toEqual(['duplicate']);
  });

  it('a loop is a rejection, not a hang', () => {
    const tree = parseSurface('root = Stack([a])\na = Stack([b])\nb = Stack([a])\n', SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Stack(Stack(Stack(!cycle(a))))');
    const self = parseSurface('root = Stack([root])\n', SURFACE_REGISTRY);
    expect(show(self.root)).toBe('Stack(!cycle(root))');
    const reg = createSurfaceRegistry([defineSurfaceComponent({ name: 'Bars', summary: 'x', args: ['values'], props: z.object({ values: z.array(z.unknown()) }) })]);
    expect(show(parseSurface('root = Bars(x)\nx = [x]\n', reg).root)).toBe('!cycle(root)');
  });

  it('a tree deeper than the limit is cut there, and the cut is a rejection', () => {
    const depth = SURFACE_MAX_DEPTH + 8;
    const lines = ['root = Stack([s1])'];
    for (let i = 1; i < depth; i++) lines.push(`s${i} = Stack([s${i + 1}])`);
    lines.push(`s${depth} = Text("deep")`);
    const tree = parseSurface(`${lines.join('\n')}\n`, SURFACE_REGISTRY);
    expect(show(tree.root)).toContain('!too_deep(');
    expect(tree.problems.some((p) => p.code === 'too_deep')).toBe(true);
  });

  it('names that expand into one another cannot blow up the screen', () => {
    // 5 lists of 20 references each: 20^5 = 3.2 million parts if every reference were followed
    const lines = ['root = Stack([a0])'];
    const refs = (n: string): string => `[${Array.from({ length: 20 }, () => n).join(', ')}]`;
    for (let i = 0; i < 5; i++) lines.push(`a${i} = Stack(${refs(`a${i + 1}`)})`);
    lines.push('a5 = Text("leaf")');
    const t0 = performance.now();
    const tree = parseSurface(`${lines.join('\n')}\n`, SURFACE_REGISTRY);
    expect(performance.now() - t0).toBeLessThan(2000);
    const count = (n: SurfaceNode | null): number => (n === null ? 0 : 1 + (n.kind === 'component' ? n.children.reduce((a, c) => a + count(c), 0) : 0));
    expect(count(tree.root)).toBeLessThanOrEqual(SURFACE_MAX_RENDER_NODES + 20);
    expect(tree.problems.some((p) => p.code === 'too_large')).toBe(true);
  });

  it('a name used as a value cannot blow up either', () => {
    const reg = createSurfaceRegistry([defineSurfaceComponent({ name: 'Bars', summary: 'x', args: ['values'], props: z.object({ values: z.array(z.unknown()) }) })]);
    const lines = ['root = Bars(l0)'];
    for (let i = 0; i < 12; i++) lines.push(`l${i} = [l${i + 1}, l${i + 1}, l${i + 1}, l${i + 1}]`);
    lines.push('l12 = [1]');
    const t0 = performance.now();
    const tree = parseSurface(`${lines.join('\n')}\n`, reg);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(show(tree.root)).toBe('!too_large(root)');
  });

  it('a prop that is too large is refused', () => {
    const tree = parseSurface(`root = Text("${'x'.repeat(30_000)}")\n`, SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('!too_large(root)');
  });

  it('an object key that could change what every object has is a syntax problem and changes nothing', () => {
    const tree = parseSurface('root = Text("x", {"__proto__": {"polluted": true}})\n', SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('!syntax(root)');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('text over the size limit drops the rest and says so', () => {
    const filler = `x = Text("${'y'.repeat(50)}")\n`;
    const text = `root = Text("fine")\n${filler.repeat(Math.ceil(SURFACE_SOURCE_MAX / filler.length) + 10)}`;
    const tree = parseSurface(text, SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Text');
    expect(tree.problems.some((p) => p.code === 'too_large' && p.id === null)).toBe(true);
  });

  it('more statements than the limit drops the rest', () => {
    const text = `root = Text("fine")\n${Array.from({ length: 600 }, (_, i) => `n${i} = Text("x")`).join('\n')}\n`;
    const tree = parseSurface(text, SURFACE_REGISTRY);
    expect(show(tree.root)).toBe('Text');
    expect(tree.problems.some((p) => p.code === 'too_large')).toBe(true);
  });
});

describe('drawing while the text is still arriving', () => {
  it('shows what has arrived and a placeholder for what has not', () => {
    let s = createSurfaceStreamState();
    s = feedSurface(s, 'root = Stack([title, body])\n');
    expect(show(resolveSurface(s, SURFACE_REGISTRY).root)).toBe('Stack(~title, ~body)');
    s = feedSurface(s, 'title = Heading("Sales");\n'.replace(';', ''));
    expect(show(resolveSurface(s, SURFACE_REGISTRY).root)).toBe('Stack(Heading, ~body)');
    s = feedSurface(s, 'body = Text("Up');
    expect(show(resolveSurface(s, SURFACE_REGISTRY).root)).toBe('Stack(Heading, ~body)');
    s = feedSurface(s, ' four percent.")\n');
    const done = resolveSurface(s, SURFACE_REGISTRY);
    expect(show(done.root)).toBe('Stack(Heading, Text)');
    expect(done.complete).toBe(false);
    expect(resolveSurface(endSurface(s), SURFACE_REGISTRY).complete).toBe(true);
  });

  it('the last statement needs no new line once the text ends', () => {
    expect(show(stream(['root = Text("no newline at the end")']).root)).toBe('Text');
  });

  it('a half written statement is never drawn from its first part', () => {
    expect(resolveSurface(feedSurface(createSurfaceStreamState(), 'root = Stack([a, b'), SURFACE_REGISTRY).root).toBeNull();
    expect(stream(['root = Stack([a, b']).root!.kind).toBe('rejected');
  });

  it('a surface is the same however the text is cut up', () => {
    const text = `${SALES}extra = Text("not used")\nbad = Nope(1)\n`;
    const whole = parseSurface(text, SURFACE_REGISTRY);
    for (const size of [1, 2, 3, 5, 7, 13, 64]) expect(stream(chunked(text, size)), `chunks of ${size}`).toEqual(whole);
  });

  it('the same holds for text with broken statements in it', () => {
    const text = 'root = Stack([a, b, c])\na = Text("one"\nb = Text("two")\nnonsense\nc = Heading("three", 99)\nd = [1,\n2]\n';
    const whole = parseSurface(text, SURFACE_REGISTRY);
    for (const size of [1, 2, 3, 4, 9, 16]) expect(stream(chunked(text, size)), `chunks of ${size}`).toEqual(whole);
  });

  it('a statement is held at a line end inside brackets until the next line shows whether it belongs', () => {
    let s = feedSurface(createSurfaceStreamState(), 'root = Stack([a,\n');
    expect(s.statements.length).toBe(0);
    s = feedSurface(s, '  b])\n');
    expect(s.statements.length).toBe(1);
    s = feedSurface(s, 'a = Text("x")\nb = Text("y")\n');
    expect(show(resolveSurface(s, SURFACE_REGISTRY).root)).toBe('Stack(Text, Text)');
  });
});

describe('hostile input', () => {
  const run = (input: string): unknown => parseSurface(input, SURFACE_REGISTRY);
  const cases: Record<string, (n: number) => string> = {
    'open brackets': (n) => `root = ${'['.repeat(n)}`,
    'open calls': (n) => `root = ${'Stack('.repeat(n)}`,
    'open quotes': (n) => `root = Text(${'"'.repeat(n)}`,
    'many lines of nothing': (n) => `${'\n'.repeat(n)}root = Text("x")`,
    'long name': (n) => `${'a'.repeat(n)} = Text("x")`,
    'long text': (n) => `root = Text("${'\\n'.repeat(n)}")`,
    'many statements': (n) => `root = Text("x")\n${'a = Text("y")\n'.repeat(n)}`,
    'many unclosed lines': (n) => `root = Stack([\n${'  a,\n'.repeat(n)}`,
    'lone closers': (n) => `root = ${')]}'.repeat(n)}`,
    'many numbers': (n) => `root = Stack([${'1,'.repeat(n)}])`,
    'many keys': (n) => `root = Text("x", {${'"k": 1,'.repeat(n)}})`,
    'dashes': (n) => `root = Text(${'-'.repeat(n)})`,
  };
  for (const [name, build] of Object.entries(cases)) {
    it(`${name} is read in linear time`, () => {
      expectLinear(build, run, { n: 10_000, label: name, ceilingMs: 1500 });
    });
  }
  it('text fed one character at a time is read in linear time', () => {
    const text = `root = Stack([${'a,'.repeat(2000)}])\n${'a = Text("x")\n'.repeat(100)}`;
    expectLinear(
      (n) => text.slice(0, n),
      (input) => stream(chunked(input, 1)),
      { n: 3000, label: 'one character at a time', ceilingMs: 1500 },
    );
  });
});
