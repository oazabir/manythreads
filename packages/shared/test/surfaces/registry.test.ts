import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SURFACE_COMPONENTS, SURFACE_REGISTRY, createSurfaceRegistry, defineSurfaceComponent } from '../../src/index.ts';

// The component registry (PLAN P9-02): a name and a Zod schema for each part, one list for the client and the server.

const ok = {
  name: 'Panel',
  summary: 'A box.',
  args: ['children', 'title'],
  children: 'children',
  props: z.object({ title: z.string().optional() }),
};

describe('defineSurfaceComponent', () => {
  it('accepts a well formed part', () => {
    const d = defineSurfaceComponent(ok);
    expect(d).toMatchObject({ name: 'Panel', args: ['children', 'title'], children: 'children' });
  });
  it('a part with no children has none', () => {
    expect(defineSurfaceComponent({ name: 'Note', summary: 'x', args: ['text'], props: z.object({ text: z.string() }) }).children).toBeNull();
  });
  it('refuses a bad name, a repeated or misspelled value, a slot that is not a value, and a prop with no position', () => {
    expect(() => defineSurfaceComponent({ ...ok, name: 'panel' })).toThrow(/PascalCase/);
    expect(() => defineSurfaceComponent({ ...ok, name: 'Pa-nel' })).toThrow(/PascalCase/);
    expect(() => defineSurfaceComponent({ ...ok, args: ['children', 'children'] })).toThrow(/twice/);
    expect(() => defineSurfaceComponent({ ...ok, args: ['children', 'Title'] })).toThrow(/camelCase/);
    expect(() => defineSurfaceComponent({ ...ok, children: 'kids' })).toThrow(/children slot/);
    expect(() => defineSurfaceComponent({ ...ok, args: ['children'] })).toThrow(/no position/);
    expect(() => defineSurfaceComponent({ ...ok, args: ['children', 'title', 'extra'] })).toThrow(/no schema/);
    expect(() => defineSurfaceComponent({ ...ok, props: z.object({ title: z.string().optional(), children: z.string() }) })).toThrow(/cannot also be a prop/);
  });
});

describe('createSurfaceRegistry', () => {
  it('finds a part by name and lists the names in order', () => {
    const r = createSurfaceRegistry([defineSurfaceComponent(ok), defineSurfaceComponent({ name: 'Note', summary: 'x', args: ['text'], props: z.object({ text: z.string() }) })]);
    expect(r.size).toBe(2);
    expect(r.names()).toEqual(['Note', 'Panel']);
    expect(r.has('Panel')).toBe(true);
    expect(r.get('Note')?.args).toEqual(['text']);
  });
  it('knows nothing it was not given, including names every object has', () => {
    const r = createSurfaceRegistry([defineSurfaceComponent(ok)]);
    for (const name of ['Nope', 'panel', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '']) {
      expect(r.has(name), name).toBe(false);
      expect(r.get(name), name).toBeUndefined();
    }
  });
  it('refuses a name registered twice', () => {
    expect(() => createSurfaceRegistry([defineSurfaceComponent(ok), defineSurfaceComponent(ok)])).toThrow(/twice/);
  });
});

describe('the registry the app uses', () => {
  it('lists the parts every client draws', () => {
    expect(SURFACE_REGISTRY.names()).toEqual(['Heading', 'Stack', 'Text']);
    expect(SURFACE_COMPONENTS.length).toBe(SURFACE_REGISTRY.size);
  });
  it('checks props with the part own schema', () => {
    const heading = SURFACE_REGISTRY.get('Heading')!;
    expect(heading.props.safeParse({ text: 'Hi', level: 2 }).success).toBe(true);
    expect(heading.props.safeParse({ text: 'Hi', level: 7 }).success).toBe(false);
    expect(heading.props.safeParse({ text: 42 }).success).toBe(false);
    expect(heading.props.safeParse({ text: '' }).success).toBe(false);
  });
});
