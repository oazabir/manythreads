import { z } from 'zod';

// The component registry (PLAN P9-02, SPEC §14): the one list of parts a bot may put on a surface. A part is a name and a Zod schema for its props; the web
// client and the server both read this list, so what the server accepts is exactly what the client draws. A name that is not here, or props that do not
// fit the schema, are refused and never drawn (see ./openui.ts for the checker that uses it).
//
// OpenUI Lang passes a part's values by position: `Heading("Sales", 2)`. `args` fixes that order. One of the positions may hold the part's children
// (other parts); `children` names it. Everything else is plain data and is checked by `props`.

/** The most values one component call may carry. */
export const SURFACE_MAX_ARGS = 16;

/** The most events one part may declare. */
export const SURFACE_MAX_EVENTS_PER_COMPONENT = 8;

const NAME = /^[A-Z][A-Za-z0-9]{0,39}$/;
const ARG = /^[a-z][A-Za-z0-9]{0,39}$/;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** What a person's click or form sends back to the bot from one part: the shape of the payload. Anything not in the shape is refused, never passed on. */
export interface SurfaceEventDef {
  /** A strict object: a payload with a key the shape does not name is refused. */
  readonly payload: z.ZodObject<z.ZodRawShape>;
}

/** One registered part. Make it with `defineSurfaceComponent`. */
export interface SurfaceComponentDef {
  /** PascalCase, at most 40 characters: the name a bot writes. */
  readonly name: string;
  /** What it is, in one plain sentence (shown to the bot as its tool help and to a person when a node is refused). */
  readonly summary: string;
  /** The names of the positional values, in the order a bot writes them. Every prop is in here exactly once; so is the children slot, if the part has one. */
  readonly args: readonly string[];
  /** The slot (one of `args`) that holds child parts, or null for a part with no children. */
  readonly children: string | null;
  /** The shape of the plain-data values (every arg except the children slot). */
  readonly props: z.ZodObject<z.ZodRawShape>;
  /**
   * The events a viewer may send back from this part, by name (`press`, `submit`). A part with none cannot be answered at all: an event for it is refused.
   * The shape is the part's own, so what the bot receives is exactly what the part allows.
   */
  readonly events: Readonly<Record<string, SurfaceEventDef>>;
  /**
   * The values (props) a data binding may fill in (PLAN P9-06, ./bind.ts). A part with some has one more position at the end of `args`, named `bind`, where a bot may
   * declare which registered read tool feeds them. The value written in the part itself stays as the placeholder, checked by `props` like any other.
   */
  readonly bindable: readonly string[];
}

export interface SurfaceComponentInput<S extends z.ZodRawShape> {
  name: string;
  summary: string;
  args: readonly string[];
  children?: string;
  props: z.ZodObject<S>;
  /** The events a viewer may send back from this part: name to the shape of its payload. */
  events?: Record<string, z.ZodObject<z.ZodRawShape>>;
  /** The props a data binding may fill in (see `SurfaceComponentDef.bindable`). The part gets a last position named `bind`. */
  bindable?: readonly string[];
}

/** The name of the position that carries a data binding. A part cannot use it for anything else. */
export const SURFACE_BIND_ARG = 'bind';

/** Check a part's definition (fails at load, never at run time) and return it. */
export function defineSurfaceComponent<S extends z.ZodRawShape>(input: SurfaceComponentInput<S>): SurfaceComponentDef {
  const { name, args, props } = input;
  const children = input.children ?? null;
  if (!NAME.test(name)) throw new Error(`Component name "${name}" must be PascalCase letters and digits, at most 40 characters`);
  if (args.length > SURFACE_MAX_ARGS) throw new Error(`${name}: at most ${SURFACE_MAX_ARGS} values`);
  if (new Set(args).size !== args.length) throw new Error(`${name}: a value name is used twice`);
  for (const a of args) if (!ARG.test(a)) throw new Error(`${name}: "${a}" is not a value name (camelCase)`);
  if (children !== null && !args.includes(children)) throw new Error(`${name}: the children slot "${children}" is not one of its values`);
  const keys = Object.keys(props.shape);
  for (const k of keys) if (!args.includes(k)) throw new Error(`${name}: prop "${k}" has no position`);
  for (const a of args) if (a !== children && !keys.includes(a)) throw new Error(`${name}: value "${a}" has no schema`);
  if (children !== null && keys.includes(children)) throw new Error(`${name}: "${children}" is the children slot and cannot also be a prop`);
  const bindable = [...(input.bindable ?? [])];
  if (args.includes(SURFACE_BIND_ARG)) throw new Error(`${name}: "${SURFACE_BIND_ARG}" is reserved for data binding`);
  for (const b of bindable) if (!keys.includes(b)) throw new Error(`${name}: "${b}" cannot be bound because it is not a prop`);
  if (new Set(bindable).size !== bindable.length) throw new Error(`${name}: a bindable value is listed twice`);
  if (bindable.length > 0 && args.length + 1 > SURFACE_MAX_ARGS) throw new Error(`${name}: no room for the "${SURFACE_BIND_ARG}" value`);
  const events: Record<string, SurfaceEventDef> = {};
  const eventNames = Object.keys(input.events ?? {});
  if (eventNames.length > SURFACE_MAX_EVENTS_PER_COMPONENT) throw new Error(`${name}: at most ${SURFACE_MAX_EVENTS_PER_COMPONENT} events`);
  for (const e of eventNames) {
    if (!EVENT_NAME.test(e)) throw new Error(`${name}: "${e}" is not an event name (lowercase letters, digits and underscores)`);
    events[e] = { payload: input.events![e]!.strict() as unknown as z.ZodObject<z.ZodRawShape> };
  }
  return {
    name,
    summary: input.summary,
    args: bindable.length > 0 ? [...args, SURFACE_BIND_ARG] : [...args],
    children,
    props: props as unknown as z.ZodObject<z.ZodRawShape>,
    events,
    bindable,
  };
}

/** A set of parts, by name. */
export interface SurfaceRegistry {
  readonly size: number;
  has(name: string): boolean;
  get(name: string): SurfaceComponentDef | undefined;
  names(): string[];
}

/** Make a registry from definitions. A name used twice fails at load. */
export function createSurfaceRegistry(defs: readonly SurfaceComponentDef[]): SurfaceRegistry {
  const byName = new Map<string, SurfaceComponentDef>();
  for (const d of defs) {
    if (byName.has(d.name)) throw new Error(`Component "${d.name}" is registered twice`);
    byName.set(d.name, d);
  }
  return {
    size: byName.size,
    has: (name) => byName.has(name),
    get: (name) => byName.get(name),
    names: () => [...byName.keys()].sort(),
  };
}
