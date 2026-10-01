/** Minimal 5-field cron (minute hour day-of-month month day-of-week), UTC. Supports `*`, `a-b`, lists and `/step`. */
export interface CronSpec {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
  domAny: boolean;
  dowAny: boolean;
}

const RANGES: readonly [string, number, number][] = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day-of-month', 1, 31],
  ['month', 1, 12],
  ['day-of-week', 0, 7],
];

function parseField(src: string, name: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m?.[1]) throw new Error(`Invalid cron ${name} field "${src}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`Invalid cron step in ${name} field "${src}"`);
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = min;
      hi = max;
    } else if (m[1].includes('-')) {
      [lo, hi] = m[1].split('-').map(Number) as [number, number];
    } else {
      lo = Number(m[1]);
      hi = m[2] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron ${name} field "${src}" out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression needs 5 fields, got ${fields.length}: "${expr}"`);
  const sets = fields.map((f, i) => {
    const [name, min, max] = RANGES[i] as [string, number, number];
    return parseField(f, name, min, max);
  }) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  const dow = new Set([...sets[4]].map((d) => d % 7)); // 7 is Sunday too
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow,
    domAny: fields[2]?.startsWith('*') ?? false,
    dowAny: fields[4]?.startsWith('*') ?? false,
  };
}

export function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getUTCMinutes()) || !spec.hour.has(d.getUTCHours()) || !spec.month.has(d.getUTCMonth() + 1)) {
    return false;
  }
  const domOk = spec.dom.has(d.getUTCDate());
  const dowOk = spec.dow.has(d.getUTCDay());
  // Vixie cron: when both day fields are restricted, either may match.
  if (!spec.domAny && !spec.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

/** Latest slot (whole minute, UTC) with `after < slot <= now` matching `expr`, or null. */
export function latestSlot(expr: string, now: Date, after: Date): Date | null {
  const spec = parseCron(expr);
  const t = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  for (; t.getTime() > after.getTime(); t.setTime(t.getTime() - 60_000)) {
    if (cronMatches(spec, t)) return new Date(t.getTime());
  }
  return null;
}
