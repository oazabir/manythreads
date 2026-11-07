import { describe, expect, it } from 'vitest';
import {
  ListActionItemsResponse,
  ListPersonalRoutinesResponse,
  changeActionItemRoute,
  createPersonalRoutineRoute,
  draftPersonalRoutineRoute,
  listActionItemsRoute,
  listPersonalRoutinesRoute,
  recipeToDraft,
  personalRecipeById,
  runPersonalRoutineRoute,
  updatePersonalRoutineRoute,
} from '@manythreads/shared';
import { installRoutinesMock } from '../src/api/mock-routines';

type Route = { method: string; path: string };
type Handler = (c: { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> }) => unknown;

function setup(role = 'member') {
  const table = new Map<string, Handler>();
  let n = 0;
  installRoutinesMock((r: Route, handler: Handler) => table.set(`${r.method} ${r.path}`, handler), {
    me: () => ({ id: '00000000-0000-7000-8000-000000000001', role }),
    workspaceId: '00000000-0000-7000-8000-0000000000aa',
    nextId: () => `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
    now: '2026-11-07T08:00:00.000Z',
    fail: (status, _code, message) => {
      throw Object.assign(new Error(message), { status });
    },
  });
  const run = (r: Route, c: Partial<Parameters<Handler>[0]> = {}) => table.get(`${r.method} ${r.path}`)!({ params: {}, query: new URLSearchParams(), body: {}, ...c }) as { body?: unknown; status?: number } & Record<string, unknown>;
  return run;
}

describe('the routines mock', () => {
  it('refuses a create that was not confirmed and never turns one on by itself', () => {
    const run = setup();
    const draft = recipeToDraft(personalRecipeById('mail-summary')!, 'Asia/Dubai', new Date('2026-11-07T08:00:00Z'));
    const body = { name: draft.name, schedule: draft.schedule, scheduleWords: draft.scheduleWords, timeZone: draft.timeZone, prompt: draft.prompt, sources: draft.sources, outputPath: draft.outputPath, outputMode: draft.outputMode };
    expect(() => run(createPersonalRoutineRoute, { body })).toThrow(/confirm/);
    expect(ListPersonalRoutinesResponse.parse(run(listPersonalRoutinesRoute)).items).toHaveLength(0);
    const made = run(createPersonalRoutineRoute, { body: { ...body, confirmed: true } }).body as { routine: { id: string; enabled: boolean } };
    expect(made.routine.enabled).toBe(true);
    const list = ListPersonalRoutinesResponse.parse(run(listPersonalRoutinesRoute));
    expect(list.items).toHaveLength(1);
    expect(list.limits.used).toBe(1);
    const ran = run(runPersonalRoutineRoute, { params: { scheduledJobId: made.routine.id } }).body as { run: { status: string } };
    expect(ran.run.status).toBe('done');
    run(updatePersonalRoutineRoute, { params: { scheduledJobId: made.routine.id }, body: { enabled: false } });
    expect(() => run(runPersonalRoutineRoute, { params: { scheduledJobId: made.routine.id } })).toThrow(/turned off/);
  });
  it('proposes from a sentence without saving anything', () => {
    const run = setup();
    const out = run(draftPersonalRoutineRoute, { body: { sentence: 'Every weekday at 7:30 summarise my mail', timeZone: 'Asia/Dubai' } }) as { draft: { sources: string[] } };
    expect(out.draft.sources).toEqual(['mail']);
    expect(ListPersonalRoutinesResponse.parse(run(listPersonalRoutinesRoute)).items).toHaveLength(0);
  });
  it('refuses a guest', () => {
    expect(() => setup('guest')(listPersonalRoutinesRoute)).toThrow(/guest/i);
  });
  it('keeps action items by revision and refuses a stale change', () => {
    const run = setup();
    const first = ListActionItemsResponse.parse(run(listActionItemsRoute));
    const open = first.items.find((i) => !i.done)!;
    const after = (run(changeActionItemRoute, { body: { revision: first.revision, change: { op: 'tick', id: open.id, done: true } } }) as { list: unknown }).list;
    expect(ListActionItemsResponse.parse(after).items.find((i) => i.id === open.id)?.done).toBe(true);
    expect(() => run(changeActionItemRoute, { body: { revision: first.revision, change: { op: 'add', what: 'Late' } } })).toThrow(/changed/);
  });
});
