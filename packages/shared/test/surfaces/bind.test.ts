import { describe, expect, it } from 'vitest';
import {
  SURFACE_BINDABLE_TOOLS,
  SURFACE_BIND_ARG,
  SURFACE_REGISTRY,
  applyBinding,
  bindableTool,
  checkSurfaceBind,
  defineSurfaceComponent,
  describeSurfaceBinding,
  describeSurfaceParts,
  parseSelector,
  parseSurface,
  selectValue,
  type SurfaceBind,
  type SurfaceNode,
} from '../../src/index.ts';
import { z } from 'zod';

// Data binding (PLAN P9-06): what a part may declare, what the checker refuses, how a selector reads an answer and how an answer fills a part through the part's own schema.

const def = (name: string) => SURFACE_REGISTRY.get(name)!;
const node = (line: string): SurfaceNode => parseSurface(`root = ${line}\n`, SURFACE_REGISTRY).root!;
const TABLE = (bind: string): string => `Table(["Title", "State"], [], "Cards", ${bind})`;
const okBind = (bind: string): SurfaceBind => {
  const n = node(TABLE(bind));
  expect(n, bind).toMatchObject({ kind: 'component', name: 'Table' });
  return (n as Extract<SurfaceNode, { kind: 'component' }>).bind!;
};
const refused = (line: string, why?: RegExp): void => {
  const n = node(line);
  expect(n, line).toMatchObject({ kind: 'rejected', code: 'invalid_props' });
  if (why) expect((n as { message: string }).message).toMatch(why);
};

describe('which parts can be bound', () => {
  it('Text, Stat, Table, Chart, List and Badge list the values a binding may fill, and `bind` is their last value', () => {
    expect(def('Text').bindable).toEqual(['text']);
    expect(def('Stat').bindable).toEqual(['value', 'delta']);
    expect(def('Table').bindable).toEqual(['columns', 'rows']);
    expect(def('Chart').bindable).toEqual(['labels', 'values']);
    expect(def('List').bindable).toEqual(['items']);
    expect(def('Badge').bindable).toEqual(['text']);
    for (const name of ['Text', 'Stat', 'Table', 'Chart', 'List', 'Badge']) expect(def(name).args.at(-1)).toBe(SURFACE_BIND_ARG);
  });
  it('the other parts take no binding and show no `bind` value', () => {
    for (const name of ['Stack', 'Row', 'Grid', 'Heading', 'Button', 'Callout', 'Code', 'Divider', 'EntityCard', 'PersonChip', 'ChannelLink', 'ApprovalCard', 'DiffView']) {
      expect(def(name).bindable, name).toEqual([]);
      expect(def(name).args, name).not.toContain(SURFACE_BIND_ARG);
    }
  });
  it('a definition that binds something that is not a value of the part, or twice, or uses the reserved name, is refused when defined', () => {
    const shape = { summary: 'x', props: z.strictObject({ a: z.string().optional() }), args: ['a'] as const };
    expect(() => defineSurfaceComponent({ name: 'X1', ...shape, bindable: ['nope'] })).toThrow();
    expect(() => defineSurfaceComponent({ name: 'X2', ...shape, bindable: ['a', 'a'] })).toThrow();
    expect(() => defineSurfaceComponent({ name: 'X3', summary: 'x', props: z.strictObject({ bind: z.string().optional() }), args: ['bind'] as const })).toThrow();
    expect(() => defineSurfaceComponent({ name: 'X4', ...shape, bindable: ['a'] })).not.toThrow();
  });
  it('the help for a bot names the parts that can be bound, the tools, the limits and the refresh rules', () => {
    const parts = describeSurfaceParts(SURFACE_REGISTRY);
    expect(parts).toMatch(/Can be bound to data/);
    const help = describeSurfaceBinding();
    for (const t of SURFACE_BINDABLE_TOOLS) expect(help).toContain(t.name);
    expect(help).toMatch(/refreshSeconds/);
    expect(help).toMatch(/10 to 3600/);
    expect(help).toMatch(/answered/);
    expect(help).toMatch(/no web addresses/);
  });
});

describe('the tools a screen may bind', () => {
  it('are a short list of reads that this repository names', () => {
    expect(SURFACE_BINDABLE_TOOLS.map((t) => t.name)).toEqual(['tasks.read', 'messages.search', 'files.search']);
    expect(bindableTool('tasks.read')).toBeDefined();
    for (const name of ['memory.recall', 'knowledge.search', 'inbox.read', 'tasks.create', 'surface.render', 'messages.post', '', 'tasks.']) expect(bindableTool(name), name).toBeUndefined();
  });
  it('take strict arguments: no team, bank or other field a tool takes for another purpose', () => {
    expect(bindableTool('tasks.read')!.args.safeParse({}).success).toBe(true);
    expect(bindableTool('tasks.read')!.args.safeParse({ teamId: 'x' }).success).toBe(false);
    expect(bindableTool('messages.search')!.args.safeParse({ query: 'a' }).success).toBe(false);
    expect(bindableTool('messages.search')!.args.safeParse({ query: 'cache', limit: 21 }).success).toBe(false);
    expect(bindableTool('messages.search')!.args.safeParse({ query: 'cache', limit: 5 }).success).toBe(true);
    expect(bindableTool('files.search')!.args.safeParse({ query: 'cache', channelId: 'x' }).success).toBe(false);
  });
});

describe('the checker and a declared binding', () => {
  it('keeps a good binding on the part, as the checker read it', () => {
    const b = okBind('{tool: "tasks.read", into: {rows: "tasks[].[title,state]"}, refreshSeconds: 30}');
    expect(b).toEqual({ tool: 'tasks.read', args: {}, into: { rows: 'tasks[].[title,state]' }, refreshSeconds: 30 });
    const full = okBind('{tool: "messages.search", args: {query: "cache decision", limit: 5}, into: {rows: "hits[].[snippet,createdAt]"}, refreshOn: ["answered"], limit: 10}');
    expect(full).toMatchObject({ tool: 'messages.search', args: { query: 'cache decision', limit: 5 }, refreshOn: ['answered'], limit: 10 });
    expect(full.refreshSeconds).toBeUndefined();
  });
  it('the written values stay as the placeholder on the part', () => {
    const n = node(TABLE('{tool: "tasks.read", into: {rows: "tasks[].title"}}'));
    expect(n).toMatchObject({ kind: 'component', props: { columns: ['Title', 'State'], rows: [], caption: 'Cards' } });
    expect((n as { props: Record<string, unknown> }).props).not.toHaveProperty('bind');
  });
  it('a part with no binding has no `bind` at all', () => {
    expect(node(TABLE('null'))).toMatchObject({ kind: 'component' });
    expect(node('Table(["A"], [])')).not.toHaveProperty('bind');
  });
  it('binds Stat, List, Text, Chart and Badge too', () => {
    expect(node('Stat("Cards", "none", null, null, {tool: "tasks.read", into: {value: "tasks.length"}})')).toMatchObject({ kind: 'component', bind: { tool: 'tasks.read' } });
    expect(node('List(["x"], false, {tool: "tasks.read", into: {items: "tasks[].title"}})')).toMatchObject({ kind: 'component', bind: { tool: 'tasks.read' } });
    expect(node('Text("x", null, {tool: "tasks.read", into: {text: "you"}})')).toMatchObject({ kind: 'component', bind: { tool: 'tasks.read' } });
    expect(node('Badge("x", null, {tool: "tasks.read", into: {text: "tasks.length"}})')).toMatchObject({ kind: 'component', bind: { tool: 'tasks.read' } });
    expect(node('Chart("bar", ["a"], [1], "T", null, {tool: "tasks.read", into: {labels: "tasks[].state", values: "tasks[].priority"}})')).toMatchObject({
      kind: 'component',
      bind: { tool: 'tasks.read' },
    });
  });

  it('refuses a tool a screen cannot bind, with the list of those it can', () => {
    refused(TABLE('{tool: "memory.recall", args: {query: "x"}, into: {rows: "facts[].text"}}'), /not a tool a screen can bind.*tasks\.read/);
    refused(TABLE('{tool: "tasks.create", args: {title: "x"}, into: {rows: "x"}}'), /not a tool a screen can bind/);
    refused(TABLE('{tool: "Tasks Read", into: {rows: "x"}}'), /tool name looks like/);
    refused(TABLE('{tool: "", into: {rows: "x"}}'), /tool name looks like/);
  });
  it('refuses arguments that do not fit the tool, name another field, or are not an object', () => {
    refused(TABLE('{tool: "tasks.read", args: {teamId: "engineering"}, into: {rows: "tasks[].title"}}'), /do not fit/);
    refused(TABLE('{tool: "tasks.read", args: {taskId: "not-a-uuid"}, into: {rows: "tasks[].title"}}'), /do not fit/);
    refused(TABLE('{tool: "messages.search", args: {}, into: {rows: "hits[].snippet"}}'), /do not fit/);
    refused(TABLE('{tool: "tasks.read", args: [1], into: {rows: "tasks[].title"}}'));
  });
  it('refuses an address in the arguments, however it is written', () => {
    for (const q of ['https://evil.example/x', 'see www.evil.example', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://a.b/c', 'mailto:a@b.c']) {
      refused(TABLE(`{tool: "messages.search", args: {query: ${JSON.stringify(q)}}, into: {rows: "hits[].snippet"}}`), /web address|do not fit/);
    }
  });
  it('refuses arguments that are too long or nest too deep', () => {
    refused(TABLE(`{tool: "messages.search", args: {query: ${JSON.stringify('a'.repeat(2100))}}, into: {rows: "hits[].snippet"}}`), /longer than 2000|do not fit/);
    refused(TABLE('{tool: "tasks.read", args: {a: {b: {c: {d: 1}}}}, into: {rows: "tasks[].title"}}'), /nest at most 3|do not fit/);
  });
  it('refuses a refresh outside 10 to 3600 seconds, a fraction, an unknown event, and a limit outside 1 to 100', () => {
    for (const r of ['5', '9', '0', '3601', '10.5', '"30"', '-1']) refused(TABLE(`{tool: "tasks.read", into: {rows: "tasks[].title"}, refreshSeconds: ${r}}`));
    expect(okBind('{tool: "tasks.read", into: {rows: "tasks[].title"}, refreshSeconds: 10}').refreshSeconds).toBe(10);
    expect(okBind('{tool: "tasks.read", into: {rows: "tasks[].title"}, refreshSeconds: 3600}').refreshSeconds).toBe(3600);
    refused(TABLE('{tool: "tasks.read", into: {rows: "tasks[].title"}, refreshOn: ["changed"]}'));
    refused(TABLE('{tool: "tasks.read", into: {rows: "tasks[].title"}, refreshOn: "answered"}'));
    refused(TABLE('{tool: "tasks.read", into: {rows: "tasks[].title"}, limit: 0}'));
    refused(TABLE('{tool: "tasks.read", into: {rows: "tasks[].title"}, limit: 101}'));
  });
  it('refuses an unknown key of the binding (a url, an interval in ms, a method)', () => {
    refused(TABLE('{tool: "tasks.read", into: {rows: "tasks[].title"}, url: "x"}'));
    refused(TABLE('{tool: "tasks.read", into: {rows: "tasks[].title"}, refreshMs: 1000}'));
  });
  it('refuses a value the part cannot fill from data, none, or too many', () => {
    refused(TABLE('{tool: "tasks.read", into: {caption: "you"}}'), /cannot fill "caption".*columns, rows/);
    refused('Stat("a", "b", null, null, {tool: "tasks.read", into: {label: "you"}})', /cannot fill "label"/);
    refused(TABLE('{tool: "tasks.read", into: {}}'), /1 to 4/);
    refused(TABLE('{tool: "tasks.read"}'));
    // a key that would reach the prototype never gets as far as the checker: the reader of the text refuses it
    expect(node(TABLE('{tool: "tasks.read", into: {rows: "tasks[].title", __proto__: "x"}}')).kind).toBe('rejected');
  });
  it('refuses a selector that is not plain names', () => {
    for (const s of ['', 'tasks[0]', 'tasks.constructor', '__proto__.x', 'a b', 'tasks[].a[].b', 'tasks.[a,b].c', 'x'.repeat(121), 'a.b.c.d.e.f.g.h.i', 'tasks[].[a;b]', '(1+1)', 'tasks..x']) {
      refused(TABLE(`{tool: "tasks.read", into: {rows: ${JSON.stringify(s)}}}`), /selector/);
    }
  });
  it('refuses a binding on a part that takes none, and one that is not an object', () => {
    refused('Heading("x", 2, {tool: "tasks.read", into: {text: "you"}})');
    refused('Button("x", null, {tool: "tasks.read", into: {label: "you"}})');
    refused(TABLE('"tasks.read"'));
    refused(TABLE('[1]'));
    refused(TABLE('3'));
  });
  it('says which part and value it is about', () => {
    refused(TABLE('{tool: "memory.recall", into: {rows: "x"}}'), /Table, "bind"/);
  });
  it('a refused binding replaces its own part only: the neighbours stay', () => {
    const t = parseSurface(
      ['root = Stack([a, b])', 'a = Text("fine")', 'b = Text("x", null, {tool: "memory.recall", into: {text: "x"}})', ''].join('\n'),
      SURFACE_REGISTRY,
    );
    const kids = (t.root as Extract<SurfaceNode, { kind: 'component' }>).children;
    expect(kids.map((k) => k.kind)).toEqual(['component', 'rejected']);
  });
  it('checkSurfaceBind alone answers with the binding or one sentence', () => {
    expect(checkSurfaceBind(def('Table'), { tool: 'tasks.read', into: { rows: 'tasks[].title' } })).toMatchObject({ ok: true });
    expect(checkSurfaceBind(def('Heading'), { tool: 'tasks.read', into: { text: 'you' } })).toMatchObject({ ok: false, message: 'Heading cannot be bound to data' });
  });
});

describe('selectors', () => {
  it('read names, indexes, lists and a row of fields', () => {
    const data = { you: 'Nadia (you)', tasks: [{ title: 'A', state: 'open', n: 1 }, { title: 'B', state: 'done', n: 2 }], name: 'abc' };
    const get = (sel: string) => {
      const p = parseSelector(sel);
      expect(p.ok, sel).toBe(true);
      return p.ok ? selectValue(data, p.steps) : null;
    };
    expect(get('you')).toEqual({ found: true, value: 'Nadia (you)' });
    expect(get('tasks.0.title')).toEqual({ found: true, value: 'A' });
    expect(get('tasks.length')).toEqual({ found: true, value: 2 });
    expect(get('name.length')).toEqual({ found: true, value: 3 });
    expect(get('tasks[].title')).toEqual({ found: true, value: ['A', 'B'] });
    expect(get('tasks[].[title,n]')).toEqual({ found: true, value: [['A', 1], ['B', 2]] });
    expect(get('tasks.9.title')).toEqual({ found: false });
    expect(get('nothing')).toEqual({ found: false });
    expect(get('you[]')).toEqual({ found: false });
  });
  it('an item without the field gives an empty cell, so a row with a gap is still a row', () => {
    const p = parseSelector('xs[].[a,b]');
    expect(p.ok && selectValue({ xs: [{ a: 1 }, { b: 'y' }, 5] }, p.steps)).toEqual({ found: true, value: [[1, null], [null, 'y'], null] });
  });
  it('a pick keeps only plain values: an object or a list in a field is empty', () => {
    const p = parseSelector('xs[].[a,b]');
    expect(p.ok && selectValue({ xs: [{ a: { deep: 1 }, b: [1] }] }, p.steps)).toEqual({ found: true, value: [[null, null]] });
  });
  it('never read what the answer does not own', () => {
    for (const bad of ['constructor', '__proto__', 'prototype', 'a.constructor.name']) expect(parseSelector(bad).ok, bad).toBe(false);
    const p = parseSelector('hasOwnProperty');
    expect(p.ok && selectValue({}, p.steps)).toEqual({ found: false });
    const q = parseSelector('a.toString');
    expect(q.ok && selectValue({ a: {} }, q.steps)).toEqual({ found: false });
  });
  it('count the parts and the lists', () => {
    expect(parseSelector('a.b.c.d.e.f.g.h').ok).toBe(true);
    expect(parseSelector('a.b.c.d.e.f.g.h.i').ok).toBe(false);
    expect(parseSelector('a[].b[]').ok).toBe(false);
    expect(parseSelector('a[].[x,y].z').ok).toBe(false);
    expect(parseSelector('a[].[x,y]').ok).toBe(true);
  });
});

describe('filling a part from an answer', () => {
  const bind = (into: Record<string, string>, more: Partial<SurfaceBind> = {}): SurfaceBind => ({ tool: 'tasks.read', args: {}, into, ...more });
  const answer = { tasks: [{ title: 'A', state: 'open' }, { title: 'B', state: 'done' }] };
  const written = { columns: ['Title', 'State'], rows: [], caption: 'Cards' };

  it('fills only the values the binding names, through the part’s own schema', () => {
    expect(applyBinding(def('Table'), written, bind({ rows: 'tasks[].[title,state]' }), answer)).toEqual({
      state: 'ok',
      props: { rows: [['A', 'open'], ['B', 'done']] },
    });
  });
  it('keeps the first `limit` items of a list', () => {
    expect(applyBinding(def('List'), { items: ['x'] }, bind({ items: 'tasks[].title' }, { limit: 1 }), answer)).toEqual({ state: 'ok', props: { items: ['A'] } });
  });
  it('is "nothing to show yet" for an empty list, null or empty text', () => {
    expect(applyBinding(def('Table'), written, bind({ rows: 'tasks[].[title,state]' }), { tasks: [] })).toEqual({ state: 'empty' });
    expect(applyBinding(def('Text'), { text: 'x' }, bind({ text: 'you' }), { you: '' })).toEqual({ state: 'empty' });
    expect(applyBinding(def('Text'), { text: 'x' }, bind({ text: 'you' }), { you: null })).toEqual({ state: 'empty' });
  });
  it('says so when the answer lacks what the part asks for', () => {
    expect(applyBinding(def('Text'), { text: 'x' }, bind({ text: 'nope' }), {})).toMatchObject({ state: 'error', code: 'missing' });
  });
  it('turns a number or true/false into text where the bot wrote text', () => {
    expect(applyBinding(def('Stat'), { label: 'Cards', value: 'none yet' }, bind({ value: 'tasks.length' }), answer)).toEqual({ state: 'ok', props: { value: '2' } });
    // where the bot wrote a number, a number stays a number
    expect(applyBinding(def('Stat'), { label: 'Cards', value: 0 }, bind({ value: 'tasks.length' }), answer)).toEqual({ state: 'ok', props: { value: 2 } });
  });
  it('a table cell that is not plain (a list, an object) is empty rather than a failure', () => {
    const r = applyBinding(def('Table'), written, bind({ rows: 'rows' }), { rows: [['a', { x: 1 }], ['b', ['y']]] });
    expect(r).toEqual({ state: 'ok', props: { rows: [['a', null], ['b', null]] } });
  });
  it('judges the result by the part’s caps and says it plainly, without echoing the values', () => {
    const many = { tasks: Array.from({ length: 60 }, (_, i) => ({ title: `secret-${i}`, state: 'open' })) };
    const r = applyBinding(def('Table'), written, bind({ rows: 'tasks[].[title,state]' }), many);
    expect(r.state).toBe('error');
    expect(JSON.stringify(r)).not.toContain('secret-');
    expect(applyBinding(def('Table'), written, bind({ rows: 'tasks[].[title,state]' }, { limit: 50 }), many)).toMatchObject({ state: 'ok' });
    // a row wider than the columns is the part's own refusal
    expect(applyBinding(def('Table'), written, bind({ rows: 'tasks[].[title,state,state]' }), answer)).toMatchObject({ state: 'error', code: 'shape' });
    // a chart needs one label for each number
    expect(applyBinding(def('Chart'), { kind: 'bar', labels: ['a'], values: [1] }, bind({ labels: 'tasks[].title', values: 'n' }), { ...answer, n: [1] })).toMatchObject({
      state: 'error',
      code: 'shape',
    });
  });
  it('refuses more than one part may carry', () => {
    const big = { text: 'x'.repeat(30_000) };
    const r = applyBinding(def('Text'), { text: 'x' }, bind({ text: 'text' }), big);
    expect(r).toMatchObject({ state: 'error' });
    expect(JSON.stringify(r)).not.toContain('xxxxxxxx');
  });
  it('never makes markup: text stays text for the page to draw as text', () => {
    const r = applyBinding(def('Text'), { text: 'x' }, bind({ text: 'you' }), { you: '<img src=x onerror=alert(1)>' });
    expect(r).toEqual({ state: 'ok', props: { text: '<img src=x onerror=alert(1)>' } });
  });
});
