/** What one call looks like to an adapter: the header names are lower case, `raw` is the body as text, `json` is it parsed (or undefined when it is not JSON). */
export interface Incoming {
  headers: Readonly<Record<string, string | undefined>>;
  contentType: string;
  raw: string;
  json: unknown;
}

/** What an adapter decides: post this Markdown, leave it out (with the reason the caller is told), or refuse the payload as unreadable. */
export type Adapted = { kind: 'post'; text: string } | { kind: 'ignore'; reason: string } | { kind: 'reject'; reason: string };

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** `a.b.c` read from nested objects, undefined along the way when anything is missing. */
export function dig(o: unknown, ...path: string[]): unknown {
  let cur: unknown = o;
  for (const key of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}
