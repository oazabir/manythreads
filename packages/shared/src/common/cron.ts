/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week), UTC. Supports `*`, `a-b`, lists, `/step` and the three-letter
 * day/month names (`mon`, `jan`). The kernel uses the same grammar for its job schedules; this copy is here so a plugin can show and
 * store `next_run_at` without depending on the kernel.
 */
export interface CronSpec {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
  domAny: boolean;
  dowAny: boolean;
}

const DOW_NAMES: Readonly<Record<string, number>> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function named(token: string, names: Readonly<Record<string, number>>): number | undefined {
  // A field with names still takes numbers: `mon-fri` and `1-5` are the same range.
  return /^\d+$/.test(token) ? Number(token) : names[token.toLowerCase()];
}

function parseField(src: string, name: string, min: number, max: number, names?: Readonly<Record<string, number>>): Set<number> {
  const out = new Set<number>();
  for (const rawPart of src.split(',')) {
    const part = rawPart.trim();
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!m?.[1]) throw new Error(`Invalid cron ${name} field "${src}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step in ${name} field "${src}"`);
    const base = m[1];
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = min;
      hi = max;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-') as [string, string];
      const loV = names ? named(a, names) : Number(a);
      const hiV = names ? named(b, names) : Number(b);
      if (loV === undefined || hiV === undefined) throw new Error(`Invalid cron ${name} field "${src}"`);
      lo = loV;
      hi = hiV;
    } else {
      const only = names ? named(base, names) : Number(base);
      if (only === undefined) throw new Error(`Invalid cron ${name} field "${src}"`);
      lo = only;
      hi = m[2] ? max : only;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Cron ${name} field "${src}" out of range ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`Cron ${name} field "${src}" matches nothing`);
  return out;
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression needs 5 fields, got ${fields.length}: "${expr}"`);
  const [minute, hour, dom, month, dowRaw] = fields as [string, string, string, string, string];
  const sets = [
    parseField(minute, 'minute', 0, 59),
    parseField(hour, 'hour', 0, 23),
    parseField(dom, 'day-of-month', 1, 31),
    parseField(month, 'month', 1, 12, MONTH_NAMES),
    parseField(dowRaw, 'day-of-week', 0, 7, DOW_NAMES),
  ] as const;
  const dow = new Set([...sets[4]].map((d) => d % 7)); // 7 is Sunday too
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow, domAny: dom.startsWith('*'), dowAny: dowRaw.startsWith('*') };
}

export function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getUTCMinutes()) || !spec.hour.has(d.getUTCHours()) || !spec.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getUTCDate());
  const dowOk = spec.dow.has(d.getUTCDay());
  // Vixie cron: when both day fields are restricted, either may match.
  if (!spec.domAny && !spec.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

/** The first whole minute strictly after `from` that matches `expr`, or null when the expression never fires. */
export function nextCronRun(expr: string, from: Date, limitDays = 366 * 4): Date | null {
  const spec = parseCron(expr);
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const end = t.getTime() + limitDays * 86_400_000;
  for (; t.getTime() <= end; t.setTime(t.getTime() + 60_000)) {
    if (cronMatches(spec, t)) return new Date(t.getTime());
  }
  return null;
}
