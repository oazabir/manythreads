import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PostSurfaceEventRequest,
  SURFACE_PATCH_MAX_STATEMENTS,
  SURFACE_REGISTRY,
  SurfaceEventToolInput,
  SurfaceRenderInput,
  SurfaceUpdateInput,
  checkSurfaceEvent,
  createSurfaceRegistry,
  defineSurfaceComponent,
  describeSurfaceParts,
  mergeSurfacePatch,
  parseSurface,
} from '../../src/index.ts';

// The pure part of the surface tools (PLAN P9-04): the three tools' arguments, a patch by name, and the one rule that judges an event a viewer sends back.

const SCREEN = ['root = Stack([title, go])', 'title = Heading("Deploy staging?", 2)', 'go = Button("Deploy", "primary")', ''].join('\n');

describe('tool arguments', () => {
  it('render takes a title and a source and nothing else (no channel, thread, bot or run)', () => {
    expect(SurfaceRenderInput.safeParse({ title: 'T', source: SCREEN }).success).toBe(true);
    expect(SurfaceRenderInput.safeParse({ title: 'T', source: SCREEN, channelId: crypto.randomUUID() }).success).toBe(false);
    expect(SurfaceRenderInput.safeParse({ title: 'two\nlines', source: SCREEN }).success).toBe(false);
    expect(SurfaceRenderInput.safeParse({ title: 'T', source: '' }).success).toBe(false);
    expect(SurfaceRenderInput.safeParse({ title: 'T' }).success).toBe(false);
    expect(SurfaceRenderInput.safeParse({ source: SCREEN }).success).toBe(false);
  });
  it('render can instead take a goal and the target channel, never both forms, never another target', () => {
    const goalId = crypto.randomUUID();
    expect(SurfaceRenderInput.safeParse({ goalId, target: 'channel' }).success).toBe(true);
    expect(SurfaceRenderInput.safeParse({ goalId }).success).toBe(false);
    expect(SurfaceRenderInput.safeParse({ target: 'channel' }).success).toBe(false);
    expect(SurfaceRenderInput.safeParse({ goalId, target: 'thread' }).success).toBe(false);
    expect(SurfaceRenderInput.safeParse({ goalId, target: 'channel', title: 'T', source: SCREEN }).success).toBe(false);
    expect(SurfaceRenderInput.safeParse({ goalId: 'not-an-id', target: 'channel' }).success).toBe(false);
    expect(SurfaceRenderInput.safeParse({ goalId, target: 'channel', channelId: crypto.randomUUID() }).success).toBe(false);
    // the schema the model reads stays one flat object
    expect(z.toJSONSchema(SurfaceRenderInput, { io: 'input' })).toMatchObject({ type: 'object', additionalProperties: false });
  });
  it('update names the screen and the patch; the version is optional and never a free number', () => {
    const id = crypto.randomUUID();
    expect(SurfaceUpdateInput.safeParse({ surfaceId: id, patch: 'a = Text("x")' }).success).toBe(true);
    expect(SurfaceUpdateInput.safeParse({ surfaceId: id, patch: 'a = Text("x")', baseVersion: 0 }).success).toBe(false);
    expect(SurfaceUpdateInput.safeParse({ surfaceId: id, patch: 'a = Text("x")', botId: id }).success).toBe(false);
  });
  it('event can narrow the question and cannot widen it', () => {
    expect(SurfaceEventToolInput.safeParse({}).success).toBe(true);
    expect(SurfaceEventToolInput.safeParse({ limit: 51 }).success).toBe(false);
    expect(SurfaceEventToolInput.safeParse({ channelId: crypto.randomUUID() }).success).toBe(false);
  });
  it('the request a page sends has no field for a tool, a channel or a person', () => {
    const base = { nodeId: 'go', name: 'press', version: 1, payload: {} };
    expect(PostSurfaceEventRequest.safeParse(base).success).toBe(true);
    for (const extra of [{ tool: 'messages.post' }, { channelId: crypto.randomUUID() }, { actorId: crypto.randomUUID() }, { call: { name: 'x' } }]) {
      expect(PostSurfaceEventRequest.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
  it('the description of the parts is built from the registry', () => {
    const text = describeSurfaceParts(SURFACE_REGISTRY);
    // a part only the platform draws (the Answer, P9-07) is not shown to a bot
    for (const name of SURFACE_REGISTRY.names()) {
      if (SURFACE_REGISTRY.get(name)!.platformOnly) expect(text).not.toContain(`${name}(`);
      else expect(text).toContain(`${name}(`);
    }
    expect(text).toContain('Events: press.');
  });
});

describe('mergeSurfacePatch', () => {
  it('replaces a part where it stands, adds a new one at the end and leaves the rest alone', () => {
    const r = mergeSurfacePatch(SCREEN, 'title = Heading("Deploy production?", 2)\nnote = Text("Careful")');
    expect(r).toMatchObject({ ok: true, changed: true, replaced: ['title'], added: ['note'] });
    if (!r.ok) return;
    expect(r.source.split('\n')).toEqual(['root = Stack([title, go])', 'title = Heading("Deploy production?", 2)', 'go = Button("Deploy", "primary")', 'note = Text("Careful")', '']);
  });
  it('is additive: a patch cannot remove a part', () => {
    const r = mergeSurfacePatch(SCREEN, 'title = Heading("x", 1)');
    expect(r.ok && r.source.includes('go = Button')).toBe(true);
  });
  it('says nothing changed when the patch repeats the screen', () => {
    expect(mergeSurfacePatch(SCREEN, 'go = Button("Deploy", "primary")')).toMatchObject({ ok: true, changed: false, replaced: [], added: [] });
  });
  it('refuses a patch that cannot be read, repeats a name, is empty or is too long', () => {
    expect(mergeSurfacePatch(SCREEN, 'this is not a statement')).toMatchObject({ ok: false, code: 'syntax' });
    expect(mergeSurfacePatch(SCREEN, 'a = Text("x")\na = Text("y")')).toMatchObject({ ok: false, code: 'duplicate', id: 'a' });
    expect(mergeSurfacePatch(SCREEN, '\n\n')).toMatchObject({ ok: false, code: 'syntax' });
    const many = Array.from({ length: SURFACE_PATCH_MAX_STATEMENTS + 1 }, (_, i) => `p${i} = Text("x")`).join('\n');
    expect(mergeSurfacePatch(SCREEN, many)).toMatchObject({ ok: false, code: 'too_large' });
  });
});

describe('checkSurfaceEvent: what a viewer may send back', () => {
  const send = (nodeId: string, name: string, payload: unknown = {}, source = SCREEN) => checkSurfaceEvent(SURFACE_REGISTRY, source, { nodeId, name, payload });

  it('accepts a press on a button that is drawn, with the empty payload the button declares', () => {
    expect(send('go', 'press')).toEqual({ ok: true, payload: {}, component: 'Button' });
  });
  it('refuses a part that does not exist, one that was never written and one the checker would not draw', () => {
    expect(send('missing', 'press')).toMatchObject({ ok: false, code: 'no_such_part' });
    expect(send('go', 'press', {}, 'root = Stack([go])\n')).toMatchObject({ ok: false, code: 'no_such_part' });
    const broken = 'root = Stack([go])\ngo = Button(42)\n';
    expect(send('go', 'press', {}, broken)).toMatchObject({ ok: false, code: 'no_such_part' });
  });
  it('refuses an event the part does not declare, including names that are properties of every object', () => {
    expect(send('title', 'press')).toMatchObject({ ok: false, code: 'unknown_event' });
    expect(send('go', 'click')).toMatchObject({ ok: false, code: 'unknown_event' });
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(send('go', name)).toMatchObject({ ok: false, code: 'unknown_event' });
  });
  it('refuses a payload with a value the event did not declare, and a payload that is not an object', () => {
    expect(send('go', 'press', { tool: 'messages.post' })).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(send('go', 'press', { value: 'yes' })).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(send('go', 'press', 'yes')).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(send('go', 'press', ['a'])).toMatchObject({ ok: false, code: 'invalid_payload' });
  });
  it('refuses a payload that is too large before it is read', () => {
    expect(send('go', 'press', { blob: 'x'.repeat(20_000) })).toMatchObject({ ok: false, code: 'too_large' });
  });
  it('returns the payload the event shape wrote, never the viewer\'s own object', () => {
    const form = createSurfaceRegistry([
      defineSurfaceComponent({
        name: 'Ask',
        summary: 'A question.',
        args: ['label'],
        props: z.object({ label: z.string() }),
        events: { submit: z.strictObject({ answer: z.string().max(10) }) },
      }),
    ]);
    const src = 'root = Ask("Name?")\n';
    const mine = { answer: 'Omar' };
    const r = checkSurfaceEvent(form, src, { nodeId: 'root', name: 'submit', payload: mine });
    expect(r).toEqual({ ok: true, payload: { answer: 'Omar' }, component: 'Ask' });
    if (r.ok) expect(r.payload).not.toBe(mine);
    expect(checkSurfaceEvent(form, src, { nodeId: 'root', name: 'submit', payload: { answer: 'x'.repeat(11) } })).toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(checkSurfaceEvent(form, src, { nodeId: 'root', name: 'submit', payload: { answer: 'a', extra: 1 } })).toMatchObject({ ok: false, code: 'invalid_payload' });
  });
  it('the sample screen is a screen the checker draws without a problem', () => {
    const tree = parseSurface(SCREEN, SURFACE_REGISTRY);
    expect(tree.problems).toEqual([]);
    expect(tree.root).not.toBeNull();
  });
});
