import { SURFACE_SOURCE_MAX, type SurfaceRejectionCode } from '../entities/surface.ts';
import { checkSurfaceBind, type SurfaceBind } from './bind.ts';
import { SURFACE_BIND_ARG, type SurfaceRegistry } from './registry.ts';

// OpenUI Lang, the text a bot writes to draw a surface (PLAN P9-03, SPEC §14), and the checker that stands between that text and the screen.
//
//   root = Stack([title, body], "large")
//   title = Heading("Sales this week", 1)
//   body = Text("Up four percent.")
//
// One statement per line: a name, `=`, then a part written as `Name(value, value, ...)`. Values are strings, numbers, true, false, null, lists `[...]`,
// objects `{key: value}`, the name of another statement (which may be written later, so a surface can draw while it is still being written), or a part
// written inline. `root` is the first part to draw. A statement may run over several lines while its brackets are open.
//
// The checker is the point of this file. It takes text in any chunking and turns it into a tree of parts in which EVERY part is a name found in the
// registry with props that passed that part's Zod schema, or a rejection card. Nothing else gets through: an unknown name, a value that does not fit, a
// loop, a tree that is too deep or too wide, a line that is not a statement. A rejected part never takes its neighbours down with it. Pure functions only
// (the state is a plain object a caller keeps), so the web client and the server run the same code. Every pass over the text is linear in its length.

/** Statements a surface may hold. */
export const SURFACE_MAX_STATEMENTS = 500;
/** The longest one statement may be (characters). */
export const SURFACE_MAX_STATEMENT_CHARS = 60_000;
/** How deep parts may nest on the screen. */
export const SURFACE_MAX_DEPTH = 16;
/** The most parts drawn from one surface (a name used in several places counts every time). */
export const SURFACE_MAX_RENDER_NODES = 2000;
/** The most children one part may have. */
export const SURFACE_MAX_CHILDREN = 200;
/** The most data one part may carry in its props (characters, counted as the text would be written). */
export const SURFACE_MAX_PROP_CHARS = 20_000;
/** The most problems kept for one surface. */
export const SURFACE_MAX_PROBLEMS = 100;

const MAX_PARSE_DEPTH = 32;
const MAX_ITEMS = 5000;
const MAX_NAME_SHOWN = 40;
const MAX_MESSAGE = 300;

// Syntax tree ----------------------------------------------------------------------------------------------------------------------

type Ast =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'arr'; items: Ast[] }
  | { t: 'obj'; entries: [string, Ast][] }
  | { t: 'ref'; id: string }
  | { t: 'call'; name: string; args: Ast[] };

/** One line of the text: `id = part`, or the reason it could not be read. */
export interface SurfaceStatement {
  id: string;
  ast: Ast | null;
  error: string | null;
  /** The statement as written (trimmed): what a patch puts in place of another statement of the same name (patch.ts). */
  text: string;
}

/** What a bot is told when it writes a part only the platform draws (the Answer, PLAN P9-07). */
export const platformOnlyMessage = (name: string): string => `${name} is drawn only by the platform; use Callout or Text for your own text`;

/** True for the problem `platformOnlyMessage` made: the surface tools refuse a screen that has one anywhere, not only at its root. */
export const isPlatformOnlyProblem = (p: { code: string; message: string }): boolean => p.code === 'unknown_component' && / is drawn only by the platform; use Callout or Text/.test(p.message);

/** Where the checker is in a stream of text. A plain object: keep the latest one, hand it back to `feedSurface`. */
export interface SurfaceStreamState {
  /** The text received after the last finished statement. */
  rest: string;
  /** Where in `rest` the next character to look at is. */
  pos: number;
  depth: number;
  inStr: boolean;
  esc: boolean;
  statements: readonly SurfaceStatement[];
  /** Characters received so far. */
  consumed: number;
  /** The text went over a limit; whatever came after is dropped. */
  overflow: boolean;
  /** `endSurface` was called: no more text is coming. */
  ended: boolean;
}

export function createSurfaceStreamState(): SurfaceStreamState {
  return { rest: '', pos: 0, depth: 0, inStr: false, esc: false, statements: [], consumed: 0, overflow: false, ended: false };
}

// Reading statements ---------------------------------------------------------------------------------------------------------------

const HEAD = /^([A-Za-z_][A-Za-z0-9_]{0,63})[ \t]*=(?!=)[ \t\r\n]*/;
const IDENT = /[A-Za-z_][A-Za-z0-9_]{0,64}/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isIdentChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122);
const isIdentStart = (c: number): boolean => (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122);

function parseExpression(src: string, from: number): Ast {
  let i = from;
  const ws = (): void => {
    while (i < src.length) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const str = (): string => {
    i++; // the opening quote
    let out = '';
    let from2 = i;
    for (;;) {
      if (i >= src.length) throw new Error('A text is missing its closing quote');
      const c = src.charCodeAt(i);
      if (c === 34) {
        out += src.slice(from2, i);
        i++;
        return out;
      }
      if (c === 10 || c === 13) throw new Error('A text is missing its closing quote');
      if (c < 32 && c !== 9) throw new Error('A text has a control character in it');
      if (c === 92) {
        out += src.slice(from2, i);
        const e = src[i + 1];
        i += 2;
        if (e === '"' || e === '\\' || e === '/') out += e;
        else if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === 'u') {
          const hex = src.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('A text has a broken \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else throw new Error('A text has an escape this language does not know');
        from2 = i;
        continue;
      }
      i++;
    }
  };
  const list = (close: string, depth: number): Ast[] => {
    const items: Ast[] = [];
    for (;;) {
      ws();
      if (src[i] === close) {
        i++;
        return items;
      }
      if (items.length >= MAX_ITEMS) throw new Error('A list has too many items');
      items.push(expr(depth + 1));
      ws();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === close) {
        i++;
        return items;
      }
      throw new Error(i >= src.length ? 'A bracket is not closed' : `Expected "," or "${close}" but found "${src[i]}"`);
    }
  };
  const expr = (depth: number): Ast => {
    if (depth > MAX_PARSE_DEPTH) throw new Error('Brackets are nested too deeply');
    ws();
    if (i >= src.length) throw new Error('The statement ends too early');
    const ch = src[i]!;
    const c = src.charCodeAt(i);
    if (ch === '"') return { t: 'str', v: str() };
    if (ch === '[') {
      i++;
      return { t: 'arr', items: list(']', depth) };
    }
    if (ch === '{') {
      i++;
      const entries: [string, Ast][] = [];
      for (;;) {
        ws();
        if (src[i] === '}') {
          i++;
          break;
        }
        if (entries.length >= MAX_ITEMS) throw new Error('An object has too many keys');
        let key: string;
        if (src[i] === '"') key = str();
        else {
          IDENT.lastIndex = i;
          const m = IDENT.exec(src);
          if (!m) throw new Error('An object key must be a name or a text');
          key = m[0];
          i += key.length;
        }
        if (FORBIDDEN_KEYS.has(key)) throw new Error(`"${key}" cannot be used as a key`);
        ws();
        if (src[i] !== ':') throw new Error(`Expected ":" after the key "${key.slice(0, MAX_NAME_SHOWN)}"`);
        i++;
        entries.push([key, expr(depth + 1)]);
        ws();
        if (src[i] === ',') {
          i++;
          continue;
        }
        if (src[i] === '}') {
          i++;
          break;
        }
        throw new Error(i >= src.length ? 'A bracket is not closed' : `Expected "," or "}" but found "${src[i]}"`);
      }
      return { t: 'obj', entries };
    }
    if (ch === '-' || (c >= 48 && c <= 57)) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      if (!m) throw new Error('That is not a number');
      i += m[0].length;
      const v = Number(m[0]);
      if (!Number.isFinite(v)) throw new Error('That number is too large');
      return { t: 'num', v };
    }
    if (isIdentStart(c)) {
      IDENT.lastIndex = i;
      const m = IDENT.exec(src)!;
      const name = m[0];
      if (name.length > 64) throw new Error('A name is longer than 64 characters');
      i += name.length;
      if (name === 'true') return { t: 'bool', v: true };
      if (name === 'false') return { t: 'bool', v: false };
      if (name === 'null') return { t: 'null' };
      const j = i;
      ws();
      if (src[i] === '(') {
        i++;
        return { t: 'call', name, args: list(')', depth) };
      }
      i = j;
      return { t: 'ref', id: name };
    }
    throw new Error(`Did not expect "${ch}" here`);
  };
  const ast = expr(0);
  ws();
  if (i < src.length) throw new Error(`Did not expect "${src[i]}" after the end of the part`);
  return ast;
}

function parseStatement(text: string, n: number): SurfaceStatement | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.startsWith('```')) return null;
  const head = HEAD.exec(trimmed);
  if (!head) return { id: `line${n + 1}`, ast: null, error: 'A line starts with a name, then "=", then the part', text: trimmed };
  const id = head[1]!;
  try {
    return { id, ast: parseExpression(trimmed, head[0].length), error: null, text: trimmed };
  } catch (e) {
    return { id, ast: null, error: e instanceof Error ? e.message : 'The statement could not be read', text: trimmed };
  }
}

/** Does a new statement start at `i` (a name and "=")? `maybe` when the text ends before that can be told. */
function startsStatement(text: string, i: number): 'yes' | 'no' | 'maybe' {
  while (i < text.length && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
  if (i >= text.length) return 'maybe';
  if (!isIdentStart(text.charCodeAt(i))) return 'no';
  const begin = i;
  while (i < text.length && isIdentChar(text.charCodeAt(i)) && i - begin <= 64) i++;
  if (i - begin > 64) return 'no';
  while (i < text.length && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
  if (i >= text.length) return 'maybe';
  return text[i] === '=' ? 'yes' : 'no';
}

function scan(s: SurfaceStreamState, final: boolean): SurfaceStreamState {
  const text = s.rest;
  let start = 0;
  let i = s.pos;
  let { depth, inStr, esc, overflow } = s;
  const added: SurfaceStatement[] = [];
  const emit = (end: number): void => {
    if (overflow) return;
    if (s.statements.length + added.length >= SURFACE_MAX_STATEMENTS) {
      overflow = true;
      return;
    }
    const st = parseStatement(text.slice(start, end), s.statements.length + added.length);
    if (st) added.push(st);
  };
  let held = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inStr) {
      if (c === '\n') {
        emit(i);
        start = i + 1;
        inStr = false;
        esc = false;
        depth = 0;
      } else if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = depth > 0 ? depth - 1 : 0;
    else if (c === '\n') {
      if (depth === 0) {
        emit(i);
        start = i + 1;
      } else {
        // Brackets still open at the end of a line. Another statement starting on the next line means the writer forgot to close them.
        const next = startsStatement(text, i + 1);
        if (next === 'yes') {
          emit(i);
          start = i + 1;
          depth = 0;
        } else if (next === 'maybe' && !final) {
          held = true;
          break;
        }
      }
    }
    i++;
  }
  if (final && !held && text.slice(start).trim() !== '') {
    emit(text.length);
    start = text.length;
    i = text.length;
  }
  const rest = text.slice(start);
  if (rest.length > SURFACE_MAX_STATEMENT_CHARS) overflow = true;
  return {
    ...s,
    rest: overflow ? '' : rest,
    pos: overflow ? 0 : i - start,
    depth: overflow ? 0 : depth,
    inStr: overflow ? false : inStr,
    esc: overflow ? false : esc,
    statements: added.length > 0 ? [...s.statements, ...added] : s.statements,
    overflow,
  };
}

/** Add the next piece of text. Pieces may be cut anywhere, even inside a word or a quoted text. */
export function feedSurface(state: SurfaceStreamState, chunk: string): SurfaceStreamState {
  if (state.ended || state.overflow || chunk === '') return state;
  let text = chunk;
  let overflow = false;
  if (state.consumed + text.length > SURFACE_SOURCE_MAX) {
    text = text.slice(0, Math.max(0, SURFACE_SOURCE_MAX - state.consumed));
    overflow = true;
  }
  const next = scan({ ...state, rest: state.rest + text, consumed: state.consumed + text.length }, false);
  return overflow ? { ...next, overflow: true } : next;
}

/** No more text is coming: read whatever is left as a last statement. */
export function endSurface(state: SurfaceStreamState): SurfaceStreamState {
  if (state.ended) return state;
  return { ...scan(state, true), ended: true };
}

// The checked tree -----------------------------------------------------------------------------------------------------------------

/** One thing wrong with a surface: a part that was refused, or a fault of the whole text. */
export interface SurfaceProblem {
  code: SurfaceRejectionCode;
  /** The name of the part (`root`, `sales_table`, or `body.0` for an inline one); null when it is about the whole text. */
  id: string | null;
  message: string;
}

/** What to draw. A `component` has passed its schema: `props` are the schema's output, `children` are already checked. */
export type SurfaceNode =
  | {
      kind: 'component';
      key: string;
      id: string;
      name: string;
      props: Record<string, unknown>;
      children: SurfaceNode[];
      /** The data binding the part declared (PLAN P9-06), already checked: a tool a screen may bind, plain arguments, selectors for values the part lets a binding fill. */
      bind?: SurfaceBind;
    }
  | { kind: 'rejected'; key: string; id: string; name: string | null; code: SurfaceRejectionCode; message: string }
  | { kind: 'pending'; key: string; id: string };

export interface SurfaceTree {
  /** Null until `root` has been written. */
  root: SurfaceNode | null;
  problems: SurfaceProblem[];
  /** The text has ended and nothing is still waiting for a statement that has not arrived. */
  complete: boolean;
}

interface Ctx {
  registry: SurfaceRegistry;
  byId: Map<string, SurfaceStatement>;
  final: boolean;
  problems: SurfaceProblem[];
  reached: Set<string>;
  nodes: number;
}

type DataResult = { ok: true; value: unknown } | { ok: false; code: SurfaceRejectionCode; message: string; pending: boolean };

const shown = (s: string, max = MAX_NAME_SHOWN): string => (s.length > max ? `${s.slice(0, max)}...` : s);
const clip = (s: string): string => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}...` : s);

function addProblem(ctx: Ctx, p: SurfaceProblem): void {
  if (ctx.problems.length < SURFACE_MAX_PROBLEMS) ctx.problems.push({ ...p, message: clip(p.message) });
}

function reject(ctx: Ctx, key: string, id: string, name: string | null, code: SurfaceRejectionCode, message: string): SurfaceNode {
  addProblem(ctx, { code, id, message });
  return { kind: 'rejected', key, id, name: name === null ? null : shown(name), code, message: clip(message) };
}

/** A name used as a value (in a prop). Unfinished text may still be going to define it. */
function toData(ast: Ast, ctx: Ctx, stack: string[], budget: { left: number }): DataResult {
  const spend = (n: number): boolean => {
    budget.left -= n;
    return budget.left >= 0;
  };
  const tooBig: DataResult = { ok: false, code: 'too_large', message: 'The values of this part are too large', pending: false };
  switch (ast.t) {
    case 'null':
      return spend(4) ? { ok: true, value: null } : tooBig;
    case 'bool':
      return spend(5) ? { ok: true, value: ast.v } : tooBig;
    case 'num':
      return spend(8) ? { ok: true, value: ast.v } : tooBig;
    case 'str':
      return spend(ast.v.length + 2) ? { ok: true, value: ast.v } : tooBig;
    case 'arr': {
      if (!spend(2) || stack.length > MAX_PARSE_DEPTH) return tooBig;
      const out: unknown[] = [];
      for (const item of ast.items) {
        const r = toData(item, ctx, stack, budget);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    case 'obj': {
      if (!spend(2) || stack.length > MAX_PARSE_DEPTH) return tooBig;
      const out: Record<string, unknown> = {};
      for (const [k, v] of ast.entries) {
        if (!spend(k.length + 2)) return tooBig;
        const r = toData(v, ctx, stack, budget);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      return { ok: true, value: out };
    }
    case 'call':
      return { ok: false, code: 'invalid_props', message: `${shown(ast.name)}(...) is a part; a part cannot be used as a value`, pending: false };
    case 'ref': {
      const st = ctx.byId.get(ast.id);
      if (!st) {
        return ctx.final
          ? { ok: false, code: 'unresolved_ref', message: `"${shown(ast.id)}" is used but never written`, pending: false }
          : { ok: false, code: 'unresolved_ref', message: `Waiting for "${shown(ast.id)}"`, pending: true };
      }
      if (stack.includes(ast.id)) return { ok: false, code: 'cycle', message: `"${shown(ast.id)}" refers to itself`, pending: false };
      if (st.error !== null || st.ast === null) return { ok: false, code: 'syntax', message: `"${shown(ast.id)}" could not be read`, pending: false };
      return toData(st.ast, ctx, [...stack, ast.id], budget);
    }
  }
}

function resolveStatement(st: SurfaceStatement, ctx: Ctx, key: string, depth: number, stack: string[]): SurfaceNode {
  ctx.reached.add(st.id);
  if (st.error !== null || st.ast === null) return reject(ctx, key, st.id, null, 'syntax', st.error ?? 'The statement could not be read');
  if (stack.includes(st.id)) return reject(ctx, key, st.id, null, 'cycle', `"${shown(st.id)}" contains itself`);
  if (st.ast.t !== 'call') return reject(ctx, key, st.id, null, 'invalid_props', `"${shown(st.id)}" is a value, not a part, so it cannot be drawn`);
  return resolveCall(st.ast, st.id, ctx, key, depth, [...stack, st.id]);
}

function resolveCall(call: Extract<Ast, { t: 'call' }>, id: string, ctx: Ctx, key: string, depth: number, stack: string[]): SurfaceNode {
  if (depth > SURFACE_MAX_DEPTH) return reject(ctx, key, id, call.name, 'too_deep', `Parts are nested more than ${SURFACE_MAX_DEPTH} deep`);
  ctx.nodes++;
  if (ctx.nodes > SURFACE_MAX_RENDER_NODES) return reject(ctx, key, id, call.name, 'too_large', `A surface can draw at most ${SURFACE_MAX_RENDER_NODES} parts`);
  const def = ctx.registry.get(call.name);
  if (!def) return reject(ctx, key, id, call.name, 'unknown_component', `"${shown(call.name)}" is not a part this app can draw`);
  if (def.platformOnly && ctx.registry.botInput) return reject(ctx, key, id, def.name, 'unknown_component', platformOnlyMessage(def.name));
  if (call.args.length > def.args.length) {
    return reject(ctx, key, id, def.name, 'invalid_props', `${def.name} takes at most ${def.args.length} values, but ${call.args.length} were given`);
  }
  const raw: Record<string, unknown> = {};
  let rawBind: unknown;
  let childAsts: Ast[] = [];
  const budget = { left: SURFACE_MAX_PROP_CHARS };
  for (let idx = 0; idx < def.args.length; idx++) {
    const arg = def.args[idx]!;
    const a = call.args[idx];
    if (a === undefined || a.t === 'null') continue;
    if (arg === def.children) {
      childAsts = a.t === 'arr' ? a.items : [a];
      continue;
    }
    const r = toData(a, ctx, stack, budget);
    if (!r.ok) {
      if (r.pending) return { kind: 'pending', key, id };
      return reject(ctx, key, id, def.name, r.code, `${def.name}, "${arg}": ${r.message}`);
    }
    if (arg === SURFACE_BIND_ARG && def.bindable.length > 0) rawBind = r.value;
    else raw[arg] = r.value;
  }
  let bind: SurfaceBind | undefined;
  if (rawBind !== undefined) {
    const checked = checkSurfaceBind(def, rawBind);
    if (!checked.ok) return reject(ctx, key, id, def.name, 'invalid_props', `${def.name}, "${SURFACE_BIND_ARG}": ${checked.message}`);
    bind = checked.bind;
  }
  const parsed = def.props.safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `"${issue.path.length > 0 ? issue.path.join('.') : 'value'}" ${issue.message}`)
      .join('; ');
    return reject(ctx, key, id, def.name, 'invalid_props', `${def.name} was given values it cannot use: ${why}`);
  }
  if (childAsts.length > SURFACE_MAX_CHILDREN) {
    return reject(ctx, key, id, def.name, 'too_large', `${def.name} can have at most ${SURFACE_MAX_CHILDREN} children`);
  }
  const resolveChild = (a: Ast, j: number): SurfaceNode => {
    const childKey = `${key}/${j}`;
    if (a.t === 'ref') {
      const st = ctx.byId.get(a.id);
      if (!st) {
        if (!ctx.final) return { kind: 'pending', key: childKey, id: a.id };
        return reject(ctx, childKey, a.id, null, 'unresolved_ref', `"${shown(a.id)}" is used but never written`);
      }
      return resolveStatement(st, ctx, childKey, depth + 1, stack);
    }
    if (a.t === 'call') return resolveCall(a, `${id}.${j}`, ctx, childKey, depth + 1, stack);
    return reject(ctx, childKey, `${id}.${j}`, null, 'invalid_props', `Only parts can go inside ${def.name}, not a plain value`);
  };
  const children: SurfaceNode[] = [];
  for (let j = 0; j < childAsts.length; j++) {
    const a = childAsts[j]!;
    const childKey = `${key}/${j}`;
    if (ctx.nodes > SURFACE_MAX_RENDER_NODES) {
      // The budget is spent: one card says so, and the rest of this part's children are not looked at.
      children.push(reject(ctx, childKey, `${id}.${j}`, null, 'too_large', `A surface can draw at most ${SURFACE_MAX_RENDER_NODES} parts`));
      break;
    }
    children.push(resolveChild(a, j));
  }
  return { kind: 'component', key, id, name: def.name, props: parsed.data as Record<string, unknown>, children, ...(bind !== undefined ? { bind } : {}) };
}

/** Check what has arrived so far and say what to draw. Safe to call after every piece of text. */
export function resolveSurface(state: SurfaceStreamState, registry: SurfaceRegistry): SurfaceTree {
  const ctx: Ctx = { registry, byId: new Map(), final: state.ended, problems: [], reached: new Set(), nodes: 0 };
  // First, so that a flood of other problems cannot push it out of the list.
  if (state.overflow) addProblem(ctx, { code: 'too_large', id: null, message: 'The surface is too long, so the rest of it was dropped' });
  for (const st of state.statements) {
    if (ctx.byId.has(st.id)) {
      addProblem(ctx, { code: 'duplicate', id: st.id, message: `"${shown(st.id)}" is written twice; the first one is used` });
      continue;
    }
    ctx.byId.set(st.id, st);
  }
  const rootStatement = ctx.byId.get('root');
  let root: SurfaceNode | null = null;
  if (rootStatement) root = resolveStatement(rootStatement, ctx, 'root', 0, []);
  else if (state.ended) addProblem(ctx, { code: 'unresolved_ref', id: 'root', message: 'There is no "root" statement, so there is nothing to draw' });
  // A statement nothing points to is never drawn, but a bot should still hear that it could not be read.
  for (const st of ctx.byId.values()) {
    if (st.error !== null && !ctx.reached.has(st.id)) addProblem(ctx, { code: 'syntax', id: st.id, message: st.error });
  }
  const waiting = (n: SurfaceNode | null): boolean => n !== null && (n.kind === 'pending' || (n.kind === 'component' && n.children.some(waiting)));
  return { root, problems: ctx.problems, complete: state.ended && !waiting(root) };
}

/** The whole text at once (what the server does when a bot sends a finished surface). */
export function parseSurface(source: string, registry: SurfaceRegistry): SurfaceTree {
  return resolveSurface(endSurface(feedSurface(createSurfaceStreamState(), source)), registry);
}
