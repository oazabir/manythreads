// Small helpers the bridge shares.

/** Lets a key through at most once per `windowMs` (a refusal's audit line: a flood of bad calls writes one line a minute per account and reason). */
export function createOncePer(windowMs: number, now: () => number = Date.now): (key: string) => boolean {
  const seen = new Map<string, number>();
  return (key) => {
    const t = now();
    if (seen.size > 5_000) for (const [k, at] of seen) if (t - at >= windowMs) seen.delete(k);
    const at = seen.get(key);
    if (at !== undefined && t - at < windowMs) return false;
    seen.set(key, t);
    return true;
  };
}

export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Postgres error code of a thrown database error, if it is one. */
export const pgCode = (err: unknown): string | undefined => (typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined);
