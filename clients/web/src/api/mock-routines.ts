import {
  ActionItemView,
  PersonalRoutine,
  PersonalRoutineRun,
  RoutineLimits,
  changeActionItemRoute,
  cronToWords,
  createPersonalRoutineRoute,
  deletePersonalRoutineRoute,
  draftPersonalRoutineRoute,
  listActionItemsRoute,
  listPersonalRoutineRunsRoute,
  listPersonalRoutinesRoute,
  runPersonalRoutineRoute,
  updatePersonalRoutineRoute,
  updateRoutineSettingsRoute,
  wordsToSchedule,
  type RoutineQuietHours,
} from '@manythreads/shared';

/*
 * The mock of a person's own routines and action items (P20-10 to P20-12): the same routes, shapes and words the scheduled-jobs plugin answers with. Everything is
 * kept per signed-in person; no route takes a person. A guest has no Personal space and is refused with 403. A create without `confirmed: true` is refused, as
 * the server does. "Run now" adds a finished run at once.
 */

type Route = { method: string; path: string };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type On = (route: Route, handler: (c: Ctx) => unknown) => void;

export type RoutinesMockHooks = {
  me(): { id: string; role: string };
  workspaceId: string;
  nextId(): string;
  now: string;
  fail(status: number, code: 'not_found' | 'conflict' | 'forbidden' | 'validation_failed', message: string): never;
};

type Item = Omit<ActionItemView, 'id'>;
type Mine = {
  routines: PersonalRoutine[];
  runs: Map<string, PersonalRoutineRun[]>;
  timeZone: string | null;
  quietHours: RoutineQuietHours | null;
  items: Item[];
  revision: number;
};

const created = (body: unknown): { status: number; body: unknown } => ({ status: 201, body });

/** A handle for a line made from its words, the same shape the server makes (8 hex, `-2` after a repeat). */
function handles(items: readonly Item[]): string[] {
  const seen = new Map<string, number>();
  return items.map((i) => {
    let h = 0x811c9dc5;
    for (const ch of i.what.trim().toLowerCase()) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const base = h.toString(16).padStart(8, '0');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

export function installRoutinesMock(on: On, h: RoutinesMockHooks): void {
  const people = new Map<string, Mine>();

  const mineOf = (): Mine => {
    const who = h.me();
    if (who.role === 'guest') h.fail(403, 'forbidden', 'A guest has no Personal space.');
    let m = people.get(who.id);
    if (!m) {
      m = {
        routines: [],
        runs: new Map(),
        timeZone: null,
        quietHours: null,
        revision: 1,
        items: [
          { what: 'Send the revised quote to Acme', owner: 'Nadia', due: '2026-11-20', done: false, source: 'mail "Quote for Acme", 3 Nov', why: [], cardTaskId: null },
          { what: 'Reply to Rafi about the release', owner: null, due: null, done: true, source: 'thread in #eng', why: ['6 Nov: marked done because the reply was sent in the thread'], cardTaskId: null },
        ],
      };
      people.set(who.id, m);
    }
    return m;
  };

  const limits = (m: Mine): RoutineLimits => ({ maxRoutines: 20, used: m.routines.length, minIntervalMinutes: 15, monthlyCapUsd: 5, spentUsd: 0.4 * m.routines.length, runToolCalls: 40 });
  const settings = (m: Mine) => ({ timeZone: m.timeZone, quietHours: m.quietHours });
  const own = (m: Mine, id: string | undefined): PersonalRoutine => {
    const r = m.routines.find((x) => x.id === id);
    if (!r) h.fail(404, 'not_found', 'No such routine.');
    return r;
  };
  const replace = (m: Mine, next: PersonalRoutine): PersonalRoutine => {
    const parsed = PersonalRoutine.parse(next);
    m.routines = m.routines.map((r) => (r.id === parsed.id ? parsed : r));
    return parsed;
  };

  on(listPersonalRoutinesRoute, () => {
    const m = mineOf();
    return { items: m.routines, limits: limits(m), settings: settings(m) };
  });

  on(draftPersonalRoutineRoute, ({ body }) => {
    mineOf();
    const sentence = String(body['sentence'] ?? '').trim();
    const timeZone = String(body['timeZone'] ?? 'UTC');
    const parsed = wordsToSchedule(sentence, timeZone, new Date(h.now));
    if (!parsed) h.fail(422, 'validation_failed', 'I could not tell when that should run. Add a time, such as “every weekday at 7:30”.');
    return {
      draft: {
        name: sentence.replace(/^every\s+\S+\s+(at\s+\S+\s+)?/i, '').slice(0, 60) || 'My routine',
        schedule: parsed.cron,
        scheduleWords: cronToWords(parsed.cron, timeZone, new Date(h.now)),
        timeZone,
        prompt: `${sentence}. Look only at what is named, say where each thing came from, and keep it short.`,
        sources: /mail/i.test(sentence) ? ['mail'] : [],
        outputPath: 'Routines/my-routine/output.md',
        outputMode: 'replace',
        botSlug: 'brain',
      },
      notes: /mail/i.test(sentence) ? ['This reads your mail. Connect your mail account under Connections or the routine will not run.'] : [],
      by: 'rules',
    };
  });

  on(createPersonalRoutineRoute, ({ body }) => {
    const m = mineOf();
    if (body['confirmed'] !== true) h.fail(422, 'validation_failed', 'A routine is made only after you confirm the plan.');
    if (m.routines.length >= 20) h.fail(409, 'conflict', 'You already have 20 routines, the most there can be. Delete one first.');
    const name = String(body['name'] ?? 'My routine');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'routine';
    const timeZone = String(body['timeZone'] ?? 'UTC');
    const routine = PersonalRoutine.parse({
      id: h.nextId(), workspaceId: h.workspaceId, ownerPersonId: h.me().id, askerPersonId: h.me().id,
      botId: '00000000-0000-7000-8000-0000000b0001', botSlug: 'brain', botName: 'Brain',
      name, slug: /^[a-z]/.test(slug) ? slug : `routine-${slug}`, words: String(body['words'] ?? ''),
      schedule: body['schedule'], scheduleWords: body['scheduleWords'], timeZone,
      sources: body['sources'] ?? [], contractPath: `Routines/${slug}/routine.yaml`,
      outputPath: body['outputPath'] ?? `Routines/${slug}/output.md`, outputMode: body['outputMode'] ?? 'replace',
      enabled: true, nextRunAt: new Date(Date.parse(h.now) + 3_600_000).toISOString(), stoppedReason: null, stoppedAt: null, lastRun: null,
      recipeId: body['recipeId'] ?? null, createdAt: h.now, updatedAt: h.now,
    });
    m.routines.push(routine);
    return created({ routine });
  });

  on(updatePersonalRoutineRoute, ({ params, body }) => {
    const m = mineOf();
    const r = own(m, params['scheduledJobId']);
    const turningOn = body['enabled'] === true;
    const next = replace(m, {
      ...r,
      ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
      ...(typeof body['enabled'] === 'boolean' ? { enabled: body['enabled'] } : {}),
      ...(turningOn ? { stoppedReason: null, stoppedAt: null } : {}),
      updatedAt: h.now,
    });
    return { routine: next };
  });

  on(deletePersonalRoutineRoute, ({ params }) => {
    const m = mineOf();
    const r = own(m, params['scheduledJobId']);
    m.routines = m.routines.filter((x) => x.id !== r.id);
    return { deleted: true };
  });

  on(runPersonalRoutineRoute, ({ params }) => {
    const m = mineOf();
    const r = own(m, params['scheduledJobId']);
    if (!r.enabled || r.stoppedReason) h.fail(409, 'conflict', 'This routine is turned off. Turn it on first.');
    const run = PersonalRoutineRun.parse({
      id: h.nextId(), scheduledJobId: r.id, runId: null, status: 'done', outputPath: r.outputPath, reason: '', startedAt: h.now, endedAt: h.now,
      sourcesUsed: r.sources.map((type) => ({ type, ref: `${type} of the last day`, scope: 'person' })),
    });
    m.runs.set(r.id, [run, ...(m.runs.get(r.id) ?? [])]);
    replace(m, { ...r, lastRun: { id: run.id, status: 'done', startedAt: run.startedAt, endedAt: run.endedAt, reason: '' } });
    return created({ run });
  });

  on(listPersonalRoutineRunsRoute, ({ params }) => {
    const m = mineOf();
    const r = own(m, params['scheduledJobId']);
    return { items: m.runs.get(r.id) ?? [] };
  });

  on(updateRoutineSettingsRoute, ({ body }) => {
    const m = mineOf();
    if ('timeZone' in body) m.timeZone = (body['timeZone'] as string | null) ?? null;
    if ('quietHours' in body) m.quietHours = (body['quietHours'] as RoutineQuietHours | null) ?? null;
    return { settings: settings(m) };
  });

  // ---- action items ----
  const listOf = (m: Mine) => {
    const ids = handles(m.items);
    return {
      items: m.items.map((i, n) => ActionItemView.parse({ ...i, id: ids[n] })),
      fileId: h.nextId(),
      revision: `r${m.revision}`,
      updatedAt: h.now,
      keeperRoutineId: m.routines.find((r) => r.recipeId === 'action-items' && r.enabled)?.id ?? null,
    };
  };

  on(listActionItemsRoute, () => listOf(mineOf()));

  on(changeActionItemRoute, ({ body }) => {
    const m = mineOf();
    if (body['revision'] !== `r${m.revision}`) h.fail(409, 'conflict', 'Your list changed while you were looking at it.');
    const c = body['change'] as Record<string, unknown>;
    const ids = handles(m.items);
    const at = c['op'] === 'add' ? -1 : ids.indexOf(String(c['id']));
    if (c['op'] !== 'add' && at < 0) h.fail(404, 'not_found', 'That action is not on your list any more.');
    const item = m.items[at];
    if (c['op'] === 'add') m.items.push({ what: String(c['what']), owner: (c['owner'] as string | null | undefined) ?? null, due: (c['due'] as string | null | undefined) ?? null, done: false, source: null, why: [], cardTaskId: null });
    else if (item && c['op'] === 'tick') item.done = c['done'] === true;
    else if (item && c['op'] === 'edit') {
      if (typeof c['what'] === 'string') item.what = c['what'];
      if ('owner' in c) item.owner = (c['owner'] as string | null) ?? null;
      if ('due' in c) item.due = (c['due'] as string | null) ?? null;
    } else if (item && c['op'] === 'card') item.cardTaskId = String(c['taskId']) as Item['cardTaskId'];
    m.revision += 1;
    const list = listOf(m);
    const id = c['op'] === 'add' ? (handles(m.items).at(-1) ?? '') : (handles(m.items)[at] ?? '');
    return { list, id };
  });
}
