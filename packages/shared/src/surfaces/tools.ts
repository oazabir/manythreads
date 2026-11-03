import { z } from 'zod';
import { SURFACE_NODE_ID_MAX, SURFACE_SOURCE_MAX, SurfaceTitle } from '../entities/surface.ts';
import { SurfaceEventId, SurfaceId } from '../ids.ts';
import { createSurfaceStreamState, endSurface, feedSurface, parseSurface, type SurfaceNode, type SurfaceProblem, type SurfaceStatement } from './openui.ts';
import type { SurfaceRegistry } from './registry.ts';

// What a bot and a viewer may say to the surfaces plugin (PLAN P9-04, SPEC §14), as schemas and pure functions, so the server's tools, the server's routes and
// the web client agree on them. Nothing here touches a database.

/** The most statements one patch may carry. */
export const SURFACE_PATCH_MAX_STATEMENTS = 100;
/** The most text one patch may carry (characters). */
export const SURFACE_PATCH_MAX_CHARS = 100_000;
/** The most JSON text a viewer's event payload may carry (characters). The database allows more; a click or a form is small. */
export const SURFACE_EVENT_POST_MAX = 16_000;
/** The most events from viewers that may wait for the bot to read them, per surface. More are refused until the bot answers. */
export const SURFACE_PENDING_EVENTS_MAX = 100;
/** How many answers one person may have waiting on one screen, so one member cannot fill the queue for the others. */
export const SURFACE_PENDING_PER_PERSON_MAX = 5;
/** The most events `surface.event` answers with in one call. */
export const SURFACE_EVENT_TOOL_MAX = 50;

// The three tools ------------------------------------------------------------------------------------------------------------------
// The tools take no channel, thread, team or run: those are the run's own, read by the platform. A bot cannot draw somewhere it was not asked to.

/** `surface.render`: draw a new screen in the place this run answers in. */
export const SurfaceRenderInput = z.strictObject({
  title: SurfaceTitle.describe('A short title in one line, shown above the screen and kept in the thread.'),
  source: z.string().min(1).max(SURFACE_SOURCE_MAX).describe('The screen, written in OpenUI Lang: one statement per line, `name = Part(value, ...)`. The first part to draw is named `root`.'),
});
export type SurfaceRenderInput = z.infer<typeof SurfaceRenderInput>;

/** `surface.update`: change some parts of a screen you drew, by their names. */
export const SurfaceUpdateInput = z.strictObject({
  surfaceId: SurfaceId.describe('The screen to change (surface.render answered with it). It must be one you drew.'),
  patch: z
    .string()
    .min(1)
    .max(SURFACE_PATCH_MAX_CHARS)
    .describe('Statements in the same form as the screen. A statement with a name the screen already has replaces that part; a new name adds a part. Nothing is removed: to drop a part, stop pointing at it from its parent.'),
  baseVersion: z.number().int().min(1).optional().describe('The version you based the change on. If the screen has moved on, the change is refused and you are told the current version.'),
});
export type SurfaceUpdateInput = z.infer<typeof SurfaceUpdateInput>;

/** `surface.event`: read what people sent back from your screens since you last changed them. */
export const SurfaceEventToolInput = z.strictObject({
  surfaceId: SurfaceId.optional().describe('Only this screen. Leave it out for every screen you drew in the place you are answering in.'),
  afterEventId: SurfaceEventId.optional().describe('Only events after this one (the `eventId` of the last you read).'),
  limit: z.number().int().min(1).max(SURFACE_EVENT_TOOL_MAX).optional().describe('Most events to answer with (default 20).'),
});
export type SurfaceEventToolInput = z.infer<typeof SurfaceEventToolInput>;

/** The registry as help for the model: each part, the order of its values and what it does. Built from the registry, so it cannot drift from what is accepted. */
export function describeSurfaceParts(registry: SurfaceRegistry): string {
  return registry
    .names()
    .map((name) => {
      const def = registry.get(name)!;
      const events = Object.keys(def.events);
      const args = def.args.map((a) => (a === def.children ? `${a}: [parts]` : a)).join(', ');
      return `${def.name}(${args}) - ${def.summary}${events.length > 0 ? ` Events: ${events.join(', ')}.` : ''}`;
    })
    .join(' ');
}

// A patch ---------------------------------------------------------------------------------------------------------------------------

export type SurfacePatchResult =
  | { ok: true; source: string; changed: boolean; replaced: string[]; added: string[] }
  | { ok: false; code: 'syntax' | 'duplicate' | 'too_large'; id: string | null; message: string };

const readStatements = (text: string): { statements: readonly SurfaceStatement[]; overflow: boolean } => {
  const state = endSurface(feedSurface(createSurfaceStreamState(), text));
  return { statements: state.statements, overflow: state.overflow };
};

/**
 * Put a patch's statements into a surface's text by name. A statement whose name the surface already has replaces that statement where it stands; a new name
 * is added at the end; nothing is ever taken out (so a patch can only add and replace, and a part a patch does not name is untouched). Pure: the answer says what
 * the new text would be; whether the new text is acceptable is for the checker to say. A patch with a line that cannot be read as a statement, a name used
 * twice, or no statement at all is refused as a whole.
 */
export function mergeSurfacePatch(current: string, patch: string): SurfacePatchResult {
  if (patch.length > SURFACE_PATCH_MAX_CHARS) return { ok: false, code: 'too_large', id: null, message: `A patch can have at most ${SURFACE_PATCH_MAX_CHARS} characters` };
  const p = readStatements(patch);
  if (p.overflow || p.statements.length > SURFACE_PATCH_MAX_STATEMENTS) {
    return { ok: false, code: 'too_large', id: null, message: `A patch can have at most ${SURFACE_PATCH_MAX_STATEMENTS} statements` };
  }
  if (p.statements.length === 0) return { ok: false, code: 'syntax', id: null, message: 'The patch has no statements. Write `name = Part(...)` lines.' };
  const byId = new Map<string, SurfaceStatement>();
  for (const st of p.statements) {
    if (st.ast === null) return { ok: false, code: 'syntax', id: st.id, message: `${st.error ?? 'A statement could not be read'} (in the patch, at "${st.id}")` };
    if (byId.has(st.id)) return { ok: false, code: 'duplicate', id: st.id, message: `"${st.id}" is written twice in the patch` };
    byId.set(st.id, st);
  }
  const c = readStatements(current);
  const out: string[] = [];
  const unchanged: string[] = [];
  const used = new Set<string>();
  const replaced: string[] = [];
  for (const st of c.statements) {
    unchanged.push(st.text);
    const next = byId.get(st.id);
    if (next === undefined) {
      out.push(st.text);
    } else if (!used.has(st.id)) {
      used.add(st.id);
      out.push(next.text);
      if (next.text !== st.text) replaced.push(st.id);
    }
    // a second statement of an already-replaced name is dropped: the first one is the one the checker uses
  }
  const added: string[] = [];
  for (const st of p.statements) {
    if (used.has(st.id)) continue;
    out.push(st.text);
    added.push(st.id);
  }
  const source = `${out.join('\n')}\n`;
  const before = `${unchanged.join('\n')}\n`;
  if (source.length > SURFACE_SOURCE_MAX) return { ok: false, code: 'too_large', id: null, message: `With the patch the screen would be longer than ${SURFACE_SOURCE_MAX} characters` };
  return { ok: true, source, changed: source !== before, replaced, added };
}

/** The problems a text has, as `code:name` keys: how to tell a problem a change introduced from one that was already there. */
export const problemKey = (p: SurfaceProblem): string => `${p.code}:${p.id ?? ''}`;

// A viewer's event ------------------------------------------------------------------------------------------------------------------

export type SurfaceEventCheck =
  | { ok: true; payload: Record<string, unknown>; component: string }
  | { ok: false; code: 'no_such_part' | 'unknown_event' | 'invalid_payload' | 'too_large'; message: string };

/** The part with this name in the checked tree, if it was drawn (a part that was refused, or never written, cannot be answered). */
export function findSurfacePart(root: SurfaceNode | null, nodeId: string): Extract<SurfaceNode, { kind: 'component' }> | null {
  if (root === null) return null;
  const stack: SurfaceNode[] = [root];
  let seen = 0;
  while (stack.length > 0 && seen++ < 5000) {
    const n = stack.pop()!;
    if (n.kind !== 'component') continue;
    if (n.id === nodeId) return n;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return null;
}

const clipped = (s: string, max = 200): string => (s.length > max ? `${s.slice(0, max)}...` : s);

/**
 * Judge an event a viewer sent against the surface as it is NOW: the part must be drawn on it, the part's own definition must declare an event of that name,
 * and the payload must fit that event's shape exactly (an extra key is refused, not dropped). What comes back is the payload as the shape wrote it, never the
 * viewer's own object. The one place this is decided, so the route and every test use the same rule; nothing in it can name a tool, a channel or a person.
 */
export function checkSurfaceEvent(registry: SurfaceRegistry, source: string, input: { nodeId: string; name: string; payload: unknown }): SurfaceEventCheck {
  if (input.nodeId.length === 0 || input.nodeId.length > SURFACE_NODE_ID_MAX) return { ok: false, code: 'no_such_part', message: 'That part has no usable name' };
  const part = findSurfacePart(parseSurface(source, registry).root, input.nodeId);
  if (part === null) return { ok: false, code: 'no_such_part', message: `This screen has no part named "${clipped(input.nodeId, 40)}" that can be answered` };
  const def = registry.get(part.name);
  const event = def !== undefined && Object.hasOwn(def.events, input.name) ? def.events[input.name] : undefined;
  if (event === undefined) return { ok: false, code: 'unknown_event', message: `${part.name} has no "${clipped(input.name, 40)}" event` };
  let size = 0;
  try {
    size = JSON.stringify(input.payload ?? {}).length;
  } catch {
    return { ok: false, code: 'invalid_payload', message: 'The payload could not be read' };
  }
  if (size > SURFACE_EVENT_POST_MAX) return { ok: false, code: 'too_large', message: `An event can carry at most ${SURFACE_EVENT_POST_MAX} characters` };
  const parsed = event.payload.safeParse(input.payload ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues
      .slice(0, 3)
      .map((i) => `"${i.path.length > 0 ? i.path.join('.') : 'payload'}" ${i.message}`)
      .join('; ');
    return { ok: false, code: 'invalid_payload', message: clipped(`The ${input.name} of ${part.name} was sent values it cannot use: ${why}`, 300) };
  }
  return { ok: true, payload: parsed.data as Record<string, unknown>, component: part.name };
}
