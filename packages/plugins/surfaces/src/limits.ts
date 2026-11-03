// How fast a bot may draw, change and read its screens (PLAN P9-04). Counted in this server's memory, per bot and per tool, in a sliding minute: a restart forgets
// it, which is fine for a limit that protects the machine and the people looking at the thread, not a quota that is billed (conventions: rate limits never in the
// database). Each replica counts for itself.

const WINDOW_MS = 60_000;
/** Calls a bot may make of each tool in a minute. A screen redrawn faster than this is a loop, not a person's wish. */
export const TOOL_LIMITS = { render: 20, update: 60, event: 120 } as const;

const calls = new Map<string, number[]>();

/** True when the bot may call the tool now (and records the call); false when it has called too often in the last minute. */
export function allowCall(actorId: string, tool: keyof typeof TOOL_LIMITS, now: number = Date.now()): boolean {
  const key = `${actorId}:${tool}`;
  const recent = (calls.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= TOOL_LIMITS[tool]) {
    calls.set(key, recent);
    return false;
  }
  recent.push(now);
  calls.set(key, recent);
  if (calls.size > 5_000) {
    for (const [k, v] of calls) if (v.every((t) => now - t >= WINDOW_MS)) calls.delete(k);
  }
  return true;
}

/** Forget every count (tests). */
export function resetCallLimits(): void {
  calls.clear();
}
