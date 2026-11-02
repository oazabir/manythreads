// How long one model call of the Workshop's helpers may take. Real models answering with a whole BOT.md took 80 to 230 seconds (found live on P7-04), so the default is 240 seconds; an
// operator can change it with MANYTHREADS_WORKSHOP_MODEL_TIMEOUT_MS (milliseconds, kept between 10 seconds and 9 minutes, below the 10 minutes after which a silent session is taken as stuck). Documented in docs/plugins/workshop.md.

export const DEFAULT_MODEL_TIMEOUT_MS = 240_000;
const MIN_MS = 10_000;
const MAX_MS = 540_000;

export function modelTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env['MANYTHREADS_WORKSHOP_MODEL_TIMEOUT_MS'] ?? '');
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MODEL_TIMEOUT_MS;
  return Math.min(MAX_MS, Math.max(MIN_MS, Math.round(n)));
}
