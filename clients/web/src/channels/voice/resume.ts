/*
 * Where each voice message was left (P14-17): a reader who stops a clip and comes back finds the play position where they left it. The map
 * lives in this browser's `localStorage` (nothing goes to the server): file id to position, the newest 50 kept. Every storage call is wrapped:
 * a private window or blocked site data makes the player forget, never fail. The speed the reader picked is kept the same way.
 */

const KEY = 'mt.voice.resume';
const SPEED_KEY = 'mt.voice.speed';
const KEEP = 50;
/** Within this much of the start or the end a position is not worth keeping. */
const EDGE_MS = 1_000;

export type ResumeMap = Record<string, { ms: number; at: number }>;

/** Reads the stored map; anything that is not a map of `{ ms, at }` numbers is dropped. */
export function parseResume(raw: string | null): ResumeMap {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const out: ResumeMap = {};
    for (const [id, e] of Object.entries(v)) {
      const ms = (e as { ms?: unknown } | null)?.ms;
      const at = (e as { at?: unknown } | null)?.at;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && typeof at === 'number' && Number.isFinite(at)) out[id] = { ms, at };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The map after the reader stopped `fileId` at `ms` of a clip `durationMs` long. At the very start or the very end the entry is removed (a finished
 * clip starts again from the top); otherwise it is set, and only the newest `KEEP` entries stay.
 */
export function withPosition(map: ResumeMap, fileId: string, ms: number, durationMs: number, now: number): ResumeMap {
  const next: ResumeMap = { ...map };
  if (!Number.isFinite(ms) || ms < EDGE_MS || ms > durationMs - EDGE_MS) {
    delete next[fileId];
    return next;
  }
  next[fileId] = { ms: Math.round(ms), at: now };
  const ids = Object.keys(next);
  if (ids.length > KEEP) {
    ids.sort((a, b) => (next[b]?.at ?? 0) - (next[a]?.at ?? 0));
    for (const id of ids.slice(KEEP)) delete next[id];
  }
  return next;
}

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The position (ms) where the reader left this clip; 0 when nothing is kept. */
export function loadPosition(fileId: string, s: Storage | null = store()): number {
  try {
    return parseResume(s?.getItem(KEY) ?? null)[fileId]?.ms ?? 0;
  } catch {
    return 0;
  }
}

/** Remembers the position (or forgets it, near either end); never throws. */
export function savePosition(fileId: string, ms: number, durationMs: number, s: Storage | null = store(), now: number = Date.now()): void {
  try {
    if (!s) return;
    s.setItem(KEY, JSON.stringify(withPosition(parseResume(s.getItem(KEY)), fileId, ms, durationMs, now)));
  } catch {
    /* storage is full or blocked: the player forgets */
  }
}

/** Forgets the position of a clip that was played to its end. */
export function clearPosition(fileId: string, s: Storage | null = store()): void {
  savePosition(fileId, 0, 0, s);
}

/** The speed the reader last picked (1, 1.5 or 2); 1 when nothing valid is kept. */
export function loadSpeed(s: Storage | null = store()): number {
  try {
    const n = Number(s?.getItem(SPEED_KEY));
    return n === 1.5 || n === 2 ? n : 1;
  } catch {
    return 1;
  }
}

export function saveSpeed(speed: number, s: Storage | null = store()): void {
  try {
    s?.setItem(SPEED_KEY, String(speed));
  } catch {
    /* blocked */
  }
}
