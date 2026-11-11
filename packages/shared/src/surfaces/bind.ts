import { z } from 'zod';
import { SURFACE_MAX_PROP_CHARS } from './openui.ts';
import { SURFACE_BIND_ARG, type SurfaceComponentDef } from './registry.ts';

// Data binding (PLAN P9-06, SPEC §14, principle 7): a part of a screen says "my values come from this read tool", and the app fills them in when it draws, as the
// person looking, never as the bot. This file is everything that is decided without a database or a screen:
//
//   * which tools a screen may bind (a short list that this repository names; a bot cannot add to it),
//   * what a binding looks like and what the checker refuses (`checkSurfaceBind`, used by ./openui.ts),
//   * how a tool's answer is turned into the values of the part (`applyBinding`), through the part's own schema, so the caps are the part's caps.
//
// A binding is written as the last value of a part that can be bound:
//
//   open = Table(["Title", "State"], [], "Open cards", {tool: "tasks.read", into: {rows: "tasks[].[title,state]"}, refreshSeconds: 30})
//
// The values written in the part itself stay as the placeholder shown while the data is on its way (and when it cannot come). The tool, its arguments and the
// selectors are fixed by the screen's text, which the server reads; the page never sends a tool name or arguments (the data route takes only the part's name).

/** The fastest a part may refresh by itself (seconds). */
export const SURFACE_BIND_REFRESH_MIN_SECONDS = 10;
/** The slowest refresh that can be asked for (seconds). */
export const SURFACE_BIND_REFRESH_MAX_SECONDS = 3600;
/** The most JSON text a binding's tool arguments may carry (characters). */
export const SURFACE_BIND_ARGS_MAX_CHARS = 2000;
/** How deep a binding's arguments may nest. */
export const SURFACE_BIND_ARGS_MAX_DEPTH = 3;
/** The most a tool may answer with before the answer is refused instead of used (characters of JSON). */
export const SURFACE_BIND_RESULT_MAX_CHARS = 65_536;
/** The most values of one part one binding may fill. */
export const SURFACE_BIND_MAX_INTO = 4;
/** The longest selector (characters). */
export const SURFACE_BIND_SELECTOR_MAX = 120;
/** The most items of a list the `limit` may keep. */
export const SURFACE_BIND_LIMIT_MAX = 100;
/** The most steps in one selector. */
export const SURFACE_BIND_SELECTOR_STEPS_MAX = 8;
/**
 * The named events that make a bound part read its data again, besides the interval: `answered` (the person pressed something on this screen and it went through,
 * so what the bot does next may show in the data). A new version of the screen always reads every bound part again, so it needs no name.
 */
export const SURFACE_BIND_REFRESH_EVENTS = ['answered'] as const;
export type SurfaceBindRefreshEvent = (typeof SURFACE_BIND_REFRESH_EVENTS)[number];

const TOOL_NAME = /^[a-z][a-z0-9_]{0,29}\.[a-z][a-z0-9_]{0,29}$/;
const PROP_NAME = /^[a-z][A-Za-z0-9]{0,39}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
/** A web address in any form a viewer's browser or a link previewer would follow, and the schemes that run or open something. */
const ADDRESS = /(^|[^a-z0-9])(?:[a-z][a-z0-9+.-]{1,15}:\/\/|www\.|(?:javascript|data|vbscript|file|mailto|blob):)/i;

// The tools a screen may bind ---------------------------------------------------------------------------------------------------

/**
 * One tool a screen may bind. It must be a read in the gateway's catalog too (`kind: 'read'`, checked again when the call is made), and the shape of its
 * arguments is fixed here: a bot cannot pass a field the tool takes for another purpose (a team to search in, a bank to recall from).
 */
export interface BindableTool {
  readonly name: string;
  /** What the tool answers, in plain words, for the bot that writes the binding (the field names it can select). */
  readonly summary: string;
  readonly args: z.ZodObject<z.ZodRawShape>;
}

const SearchArgs = z.strictObject({ query: z.string().trim().min(2).max(200), limit: z.number().int().min(1).max(20).optional() });

/**
 * The tools a screen may bind. Each answers from rows the person looking is allowed to read (the database decides), takes only plain arguments and changes nothing.
 * Not here, on purpose: memory (its bank is the bot's run), knowledge search and inbox (they answer from the bot's run or hold documents), and every tool of a person's
 * own connection (they act with that person's outside account). Adding a tool is a change to this list in the repository, reviewed like any other.
 */
export const SURFACE_BINDABLE_TOOLS: readonly BindableTool[] = [
  {
    name: 'tasks.read',
    summary: 'The task cards of the person’s teams, newest change first (at most 50). Select from tasks[]: id, title, description, state, kind, priority, owner, creator, branch. Takes taskId for one card.',
    args: z.strictObject({ taskId: z.uuid().optional() }),
  },
  {
    name: 'tasks.goal',
    summary:
      'Where one goal of the person’s team stands. Select from plan: ref, title, chip, stepNow, stepCount, steps[].[title,status], spend.usd, spend.budgetUsd, thread.replies. Takes goalId.',
    args: z.strictObject({ goalId: z.uuid() }),
  },
  {
    name: 'messages.search',
    summary: 'Messages the person may read that match some words (limit at most 20). Select from hits[]: id, snippet, authorId, createdAt, threadRootId. Takes query and limit.',
    args: SearchArgs,
  },
  {
    name: 'files.search',
    summary: 'Files the person may read whose names match some words (limit at most 20). Select from hits[]: id, name, folderPath, size, mime, createdAt. Takes query and limit.',
    args: SearchArgs,
  },
];

/** The tool a screen may bind under this name, or undefined. */
export function bindableTool(name: string): BindableTool | undefined {
  return SURFACE_BINDABLE_TOOLS.find((t) => t.name === name);
}

// A selector --------------------------------------------------------------------------------------------------------------------

export type SelectorStep =
  | { readonly k: 'key'; readonly name: string }
  | { readonly k: 'index'; readonly n: number }
  | { readonly k: 'each' }
  | { readonly k: 'pick'; readonly names: readonly string[] };

export type SelectorParse = { ok: true; steps: readonly SelectorStep[] } | { ok: false; message: string };

/**
 * A selector says which part of a tool's answer to use: names joined by dots (`you`, `tasks.0.title`, `tasks.length`), `[]` to go through every item of a list
 * (`tasks[].title` is the title of each card), and a last `[a,b,c]` to take several fields of each item as a row (`tasks[].[title,state]`). No expressions, no
 * calls, no way to reach anything but a field the answer actually has.
 */
export function parseSelector(text: string): SelectorParse {
  if (text.length === 0 || text.length > SURFACE_BIND_SELECTOR_MAX) return { ok: false, message: `a selector is 1 to ${SURFACE_BIND_SELECTOR_MAX} characters` };
  const pieces = text.split('.');
  if (pieces.length > SURFACE_BIND_SELECTOR_STEPS_MAX) return { ok: false, message: `a selector has at most ${SURFACE_BIND_SELECTOR_STEPS_MAX} parts` };
  const steps: SelectorStep[] = [];
  let eaches = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const last = i === pieces.length - 1;
    if (piece === '[]') {
      steps.push({ k: 'each' });
      eaches++;
    } else if (piece.startsWith('[') && piece.endsWith(']')) {
      if (!last) return { ok: false, message: 'a [a,b] pick can only come last' };
      const names = piece.slice(1, -1).split(',');
      if (names.length === 0 || names.length > 10 || !names.every((n) => IDENT.test(n) && !FORBIDDEN.has(n))) {
        return { ok: false, message: 'a [a,b] pick names 1 to 10 fields, letters, digits and _' };
      }
      steps.push({ k: 'pick', names });
    } else if (/^[0-9]{1,3}$/.test(piece)) {
      steps.push({ k: 'index', n: Number(piece) });
    } else {
      const each = piece.endsWith('[]');
      const name = each ? piece.slice(0, -2) : piece;
      if (!IDENT.test(name) || FORBIDDEN.has(name)) return { ok: false, message: `"${piece.slice(0, 40)}" is not a field name` };
      steps.push({ k: 'key', name });
      if (each) {
        steps.push({ k: 'each' });
        eaches++;
      }
    }
  }
  if (eaches > 1) return { ok: false, message: 'a selector can go through a list only once' };
  return { ok: true, steps };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const scalar = (v: unknown): string | number | boolean | null => (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : null);

function stepOnce(v: unknown, step: SelectorStep): unknown {
  switch (step.k) {
    case 'key':
      if (step.name === 'length' && (Array.isArray(v) || typeof v === 'string')) return v.length;
      return isObject(v) ? own(v, step.name) : undefined;
    case 'index':
      return Array.isArray(v) ? v[step.n] : undefined;
    case 'each':
      return Array.isArray(v) ? v : undefined;
    case 'pick':
      return isObject(v) ? step.names.map((n) => scalar(own(v, n))) : undefined;
  }
}

/** The part of `data` a selector names; `found` is false when the answer does not have it. Never throws, never reads anything the answer does not own. */
export function selectValue(data: unknown, steps: readonly SelectorStep[]): { found: true; value: unknown } | { found: false } {
  let cur: unknown = data;
  let mapped = false;
  for (const step of steps) {
    if (step.k === 'each') {
      if (!Array.isArray(cur)) return { found: false };
      mapped = true;
      continue;
    }
    if (mapped) {
      // every item of the list goes through the step; an item without the field gives null, so a row with a gap is still a row
      cur = (cur as unknown[]).map((item) => {
        const out = stepOnce(item, step);
        return out === undefined ? null : out;
      });
      continue;
    }
    cur = stepOnce(cur, step);
    if (cur === undefined) return { found: false };
  }
  return { found: true, value: cur };
}

// The declaration --------------------------------------------------------------------------------------------------------------

/** A checked binding: what a part declares. `args` and `into` have passed their checks; nothing in here is an address. */
export interface SurfaceBind {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** The part's value (a prop in `SurfaceComponentDef.bindable`) to the selector that fills it. */
  readonly into: Readonly<Record<string, string>>;
  /** Read again every this many seconds (10 to 3600). Absent: not by the clock. */
  readonly refreshSeconds?: number;
  /** Read again when one of these happens on the screen. */
  readonly refreshOn?: readonly SurfaceBindRefreshEvent[];
  /** Keep only the first items of a selected list. */
  readonly limit?: number;
}

const BindShape = z.strictObject({
  tool: z.string().regex(TOOL_NAME, 'a tool name looks like "tasks.read"'),
  args: z.record(z.string().max(40), z.unknown()).default({}),
  into: z.record(z.string(), z.string()),
  refreshSeconds: z.number().int().min(SURFACE_BIND_REFRESH_MIN_SECONDS).max(SURFACE_BIND_REFRESH_MAX_SECONDS).optional(),
  refreshOn: z.array(z.enum(SURFACE_BIND_REFRESH_EVENTS)).max(SURFACE_BIND_REFRESH_EVENTS.length).optional(),
  limit: z.number().int().min(1).max(SURFACE_BIND_LIMIT_MAX).optional(),
});

function argsProblem(args: unknown, depth = 0): string | null {
  if (typeof args === 'string') return ADDRESS.test(args) ? 'an argument looks like a web address, and a binding takes none' : null;
  if (typeof args !== 'object' || args === null) return null;
  if (depth >= SURFACE_BIND_ARGS_MAX_DEPTH) return `arguments nest at most ${SURFACE_BIND_ARGS_MAX_DEPTH} deep`;
  for (const v of Array.isArray(args) ? args : Object.values(args)) {
    const why = argsProblem(v, depth + 1);
    if (why !== null) return why;
  }
  return null;
}

const issues = (e: z.ZodError): string =>
  e.issues
    .slice(0, 3)
    .map((i) => `"${i.path.length > 0 ? i.path.join('.') : 'value'}" ${i.message}`)
    .join('; ');

export type SurfaceBindCheck = { ok: true; bind: SurfaceBind } | { ok: false; message: string };

/**
 * Check what a part declared as its binding: the shape, a tool a screen may bind, arguments that fit that tool (and are small, shallow and hold no address), and
 * selectors that name only values this part lets a binding fill. The answer is the declaration as the checker will keep it, or one plain sentence.
 */
export function checkSurfaceBind(def: SurfaceComponentDef, raw: unknown): SurfaceBindCheck {
  if (def.bindable.length === 0) return { ok: false, message: `${def.name} cannot be bound to data` };
  if (!isObject(raw)) return { ok: false, message: `"${SURFACE_BIND_ARG}" must be written like {tool: "tasks.read", into: {rows: "tasks[].title"}}` };
  const shape = BindShape.safeParse(raw);
  if (!shape.success) return { ok: false, message: issues(shape.error) };
  const b = shape.data;
  const tool = bindableTool(b.tool);
  if (tool === undefined) {
    return { ok: false, message: `"${b.tool}" is not a tool a screen can bind. These are: ${SURFACE_BINDABLE_TOOLS.map((t) => t.name).join(', ')}` };
  }
  const argsText = JSON.stringify(b.args);
  if (argsText.length > SURFACE_BIND_ARGS_MAX_CHARS) return { ok: false, message: `the arguments are longer than ${SURFACE_BIND_ARGS_MAX_CHARS} characters` };
  const why = argsProblem(b.args);
  if (why !== null) return { ok: false, message: why };
  const args = tool.args.safeParse(b.args);
  if (!args.success) return { ok: false, message: `the arguments for ${tool.name} do not fit: ${issues(args.error)}` };
  const props = Object.keys(b.into);
  if (props.length === 0 || props.length > SURFACE_BIND_MAX_INTO) return { ok: false, message: `"into" names 1 to ${SURFACE_BIND_MAX_INTO} values of the part` };
  for (const prop of props) {
    if (!PROP_NAME.test(prop) || !def.bindable.includes(prop)) {
      return { ok: false, message: `${def.name} cannot fill "${prop.slice(0, 40)}" from data. It can fill: ${def.bindable.join(', ')}` };
    }
    const sel = parseSelector(b.into[prop]!);
    if (!sel.ok) return { ok: false, message: `the selector for "${prop}": ${sel.message}` };
  }
  return {
    ok: true,
    bind: {
      tool: tool.name,
      args: args.data as Record<string, unknown>,
      into: b.into,
      ...(b.refreshSeconds !== undefined ? { refreshSeconds: b.refreshSeconds } : {}),
      ...(b.refreshOn !== undefined ? { refreshOn: [...new Set(b.refreshOn)] } : {}),
      ...(b.limit !== undefined ? { limit: b.limit } : {}),
    },
  };
}

// Filling a part from an answer -------------------------------------------------------------------------------------------------

export type BindOutcome =
  | { state: 'ok'; props: Record<string, unknown> }
  | { state: 'empty' }
  | { state: 'error'; code: 'missing' | 'shape' | 'too_large'; message: string };

const isEmpty = (v: unknown): boolean => v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Turn a tool's answer into the values of one part. Each selector picks a value; a list is cut to `limit`; a number or true/false that lands in a text value becomes
 * text; a cell of a Table that is not plain (a list, an object) becomes empty. Then the part's OWN schema judges the result, so every cap of the part holds for bound
 * values exactly as for written ones, and the values together may not exceed what one written part may carry. The answer is the values to put over the part's
 * placeholders (only the ones the binding fills), "nothing to show yet", or one plain sentence about why it does not fit. No markup is ever produced: the values are
 * plain data that the page draws as text.
 */
export function applyBinding(def: SurfaceComponentDef, written: Readonly<Record<string, unknown>>, bind: SurfaceBind, data: unknown): BindOutcome {
  const picked: Record<string, unknown> = {};
  for (const [prop, selector] of Object.entries(bind.into)) {
    const parsed = parseSelector(selector);
    if (!parsed.ok) return { state: 'error', code: 'shape', message: 'This part’s data is set up in a way the app cannot read.' };
    const found = selectValue(data, parsed.steps);
    if (!found.found) return { state: 'error', code: 'missing', message: 'The answer did not have what this part asks for.' };
    let value = found.value;
    if (bind.limit !== undefined && Array.isArray(value)) value = value.slice(0, bind.limit);
    if (isEmpty(value)) return { state: 'empty' };
    if (typeof written[prop] === 'string' && (typeof value === 'number' || typeof value === 'boolean')) value = String(value);
    if (def.name === 'Table' && prop === 'rows' && Array.isArray(value)) value = value.map((row) => (Array.isArray(row) ? row.map(scalar) : row));
    picked[prop] = value;
  }
  let size = 0;
  try {
    size = JSON.stringify(picked).length;
  } catch {
    return { state: 'error', code: 'shape', message: 'The data could not be read.' };
  }
  if (size > SURFACE_MAX_PROP_CHARS) return { state: 'error', code: 'too_large', message: 'There is too much data for this part. Ask for fewer items.' };
  const merged = def.props.safeParse({ ...written, ...picked });
  if (!merged.success) return { state: 'error', code: 'shape', message: `The data does not fit this ${def.name.toLowerCase()}: ${issues(merged.error)}.` };
  const out: Record<string, unknown> = {};
  for (const prop of Object.keys(picked)) out[prop] = (merged.data as Record<string, unknown>)[prop];
  return { state: 'ok', props: out };
}

/** The bot's help for binding, built from the list above so it cannot drift from what the checker accepts. */
export function describeSurfaceBinding(): string {
  return (
    `Data binding: a part that lists "bind" can fill some of its values from a read tool, as the person looking (they see only what they may read; you cannot read it). ` +
    `Write the placeholder values as usual and a binding as the LAST value: {tool: "tasks.read", args: {}, into: {rows: "tasks[].[title,state]"}, refreshSeconds: 30}. ` +
    `"into" maps a value of the part to a selector on the tool's answer: dotted names (tasks.0.title, tasks.length), [] for every item of a list (tasks[].title) and a last [a,b] for a row of fields (tasks[].[title,state]). ` +
    `"refreshSeconds" (${SURFACE_BIND_REFRESH_MIN_SECONDS} to ${SURFACE_BIND_REFRESH_MAX_SECONDS}) reads again on a clock while the page is open and visible; "refreshOn" is a list of event names (${SURFACE_BIND_REFRESH_EVENTS.map((e) => `"${e}"`).join(', ')}: the person pressed something on this screen); a new version of the screen reads every bound part again; "limit" keeps the first N items. ` +
    `The arguments hold no web addresses. Tools you may bind: ${SURFACE_BINDABLE_TOOLS.map((t) => `${t.name} - ${t.summary}`).join(' ')}`
  );
}
