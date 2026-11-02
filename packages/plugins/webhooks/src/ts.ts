// `ts`: how the Slack-shaped API names a message (PLAN P14-14).
//
// Slack names a message in a channel by its `ts`, a string such as "1700000000.000200": the seconds since 1970, a dot, and six digits. A script keeps that
// string from `chat.postMessage` and hands it back to `chat.update` and `reactions.add`. A message here is named by an id (a UUID version 7), and that id
// already holds its time: the first 48 bits are the milliseconds, and the 12 bits after the version digit (called `rand_a`) hold the part of the
// millisecond that the database clock knew, in 4,096 steps. So the `ts` is **worked out from the id and from nothing else**, and no table keeps it:
//
//     ts = <ms div 1000> "." <6 digits: (ms mod 1000) * 1000 + floor(rand_a * 1000 / 4096)>
//
// The way back is a range: the same arithmetic run backwards gives the lowest and highest id that can have that `ts` (same milliseconds, `rand_a` between
// two bounds, any of the other bits), and the message is found with `id BETWEEN lo AND hi` in its channel, which is a primary-key range scan.
//
// Two honest limits. (1) Six digits hold about a quarter of the 4,096 steps, so two messages written in the same microsecond share a `ts`; the lookup
// then answers the earlier one, and `chat.update` also filters by author, so an integration still finds its own. Two messages of one channel less than
// a microsecond apart do not happen outside an import. (2) A `ts` is a name for a message in one channel; the channel is always given next to it.

const MS_LIMIT = 2 ** 48;

/** The `ts` of a message id. Pure; the same id always gives the same string. */
export function messageIdToTs(id: string): string {
  const hex = id.replace(/-/g, '');
  const ms = parseInt(hex.slice(0, 12), 16);
  const randA = parseInt(hex.slice(13, 16), 16);
  const micro = (ms % 1000) * 1000 + Math.floor((randA * 1000) / 4096);
  return `${Math.floor(ms / 1000)}.${String(micro).padStart(6, '0')}`;
}

const TS_SHAPE = /^(\d{1,11})\.(\d{6})$/;

/** Whether a string is shaped like a `ts` (it may still name no message). */
export const isTs = (s: unknown): s is string => typeof s === 'string' && TS_SHAPE.test(s.trim());

const hex3 = (n: number): string => n.toString(16).padStart(3, '0');

/**
 * The lowest and highest message id that have this `ts`, for `id BETWEEN lo AND hi`. Null when it is not a `ts` or is out of range. Every id with the
 * version digit 7 and any variant bits between the two is inside; ids of other versions never are, so a stray id never matches.
 */
export function tsToIdRange(ts: string): { lo: string; hi: string } | null {
  const m = TS_SHAPE.exec(ts.trim());
  if (!m) return null;
  const micro = Number(m[2]);
  const ms = Number(m[1]) * 1000 + Math.floor(micro / 1000);
  if (!Number.isSafeInteger(ms) || ms >= MS_LIMIT) return null;
  const sub = micro % 1000;
  // rand_a such that floor(rand_a * 1000 / 4096) = sub, in integers: rand_a in [ceil(sub * 4096 / 1000), ceil((sub + 1) * 4096 / 1000) - 1]
  const lowest = Math.floor((sub * 4096 + 999) / 1000);
  const highest = Math.floor(((sub + 1) * 4096 + 999) / 1000) - 1;
  const head = ms.toString(16).padStart(12, '0');
  const front = `${head.slice(0, 8)}-${head.slice(8, 12)}`;
  return { lo: `${front}-7${hex3(lowest)}-8000-000000000000`, hi: `${front}-7${hex3(highest)}-bfff-ffffffffffff` };
}
