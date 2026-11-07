import { fileURLToPath } from 'node:url';
import { expect, type APIResponse } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { addBot, conversationStackEnv } from '../conversations/support.ts';
import type { StackApi } from '../support/stack-browser.ts';

/*
 * Helpers of the routine specs (PLAN P20-T3): a person's own routines under Account > Routines and the list under Account > Action items. Every spec file starts a
 * stack of its own, so nothing here has to put the database back; the few specs that change a shared fact (the workspace allowance, the state of the Brain bot)
 * put it back in a finally.
 *
 * The stack runs the stand-in Hermes of `conversations/fake-hermes-routine.mjs`: a "Run now" opens a real run through the real gateway, and the stand-in's reply is
 * what the routine saves in the person's files. The workspace Brain (the bot a routine is run by unless the person picks another) is made by a job on a 15-minute
 * cron that a fresh stack has not reached, so `brainReady` makes its slot due.
 */

const ROUTINE_FAKE = fileURLToPath(new URL('../conversations/fake-hermes-routine.mjs', import.meta.url));

/** The environment of a stack that can run a routine: the repo seed, and the routine stand-in as the Hermes runtime. */
export const routineStackEnv = (): Record<string, string> => ({ ...conversationStackEnv(), MANYTHREADS_HERMES_PREFIX: ROUTINE_FAKE });

export interface RoutineJson {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  stoppedReason: string | null;
  botSlug: string | null;
  schedule: string;
  scheduleWords: string;
  timeZone: string;
  sources: string[];
  contractPath: string;
  outputPath: string;
  outputMode: string;
  nextRunAt: string | null;
  recipeId: string | null;
  lastRun: { id: string; status: string; reason: string } | null;
}

export interface RunJson {
  id: string;
  runId: string | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  outputPath: string | null;
  reason: string;
  sourcesUsed: Array<{ type: string; ref: string; scope: string }>;
}

export interface ListJson {
  items: RoutineJson[];
  limits: { maxRoutines: number; used: number; minIntervalMinutes: number; monthlyCapUsd: number; spentUsd: number; runToolCalls: number };
  settings: { timeZone: string | null; quietHours: { from: string; to: string } | null };
}

/** Makes the workspace Brain's slot due, then waits until it is in the persona's list of bots; answers its id. */
export async function brainReady(stack: Stack, api: StackApi): Promise<string> {
  await stack.sql(`UPDATE app.job_schedules SET last_slot = now() - interval '1 day', created_at = now() - interval '1 day' WHERE queue = 'bots.ensure-workspace-brain'`);
  let id = '';
  await expect
    .poll(
      async () => {
        const items = (await api.get<{ items: Array<{ botId: string; botSlug: string }> }>('/api/me/bot-consents')).items;
        id = items.find((i) => i.botSlug === 'brain')?.botId ?? '';
        return id !== '';
      },
      { timeout: 90_000, message: 'the workspace Brain to exist' },
    )
    .toBe(true);
  return id;
}

/** The body of a confirmed routine. The schedule is 05:00 UTC on weekdays (9:00 in Dubai) unless a spec says otherwise. */
export const routineBody = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  confirmed: true,
  name,
  words: `${name} please`,
  botSlug: 'brain',
  schedule: '0 5 * * 1-5',
  scheduleWords: 'Weekdays at 9:00 AM',
  timeZone: 'Asia/Dubai',
  prompt: 'Write me a short note.',
  sources: [],
  outputMode: 'replace',
  ...extra,
});

export async function postRoutine(api: StackApi, body: Record<string, unknown>): Promise<APIResponse> {
  return api.ctx.post('/api/me/scheduled-jobs', { data: body, headers: await api.headers() });
}

/** Makes a routine through the route the screen uses (the person's yes is `confirmed: true`) and answers it. */
export async function makeRoutine(api: StackApi, name: string, extra: Record<string, unknown> = {}): Promise<RoutineJson> {
  const res = await postRoutine(api, routineBody(name, extra));
  const text = await res.text();
  expect(res.status(), `make ${name}: ${text}`).toBe(201);
  return (JSON.parse(text) as { routine: RoutineJson }).routine;
}

export const listRoutines = (api: StackApi): Promise<ListJson> => api.get<ListJson>('/api/me/scheduled-jobs');

export async function patchRoutine(api: StackApi, id: string, data: Record<string, unknown>): Promise<APIResponse> {
  return api.ctx.patch(`/api/me/scheduled-jobs/${id}`, { data, headers: await api.headers() });
}

export async function runRoutine(api: StackApi, id: string): Promise<APIResponse> {
  return api.ctx.post(`/api/me/scheduled-jobs/${id}/run`, { headers: await api.headers() });
}

export const runsOf = async (api: StackApi, id: string): Promise<RunJson[]> => (await api.get<{ items: RunJson[] }>(`/api/me/scheduled-jobs/${id}/runs`)).items;

/** The sentence of an error answer (`{ error: { message } }`). */
export async function messageOf(res: APIResponse): Promise<string> {
  try {
    return String(((await res.json()) as { error?: { message?: unknown } }).error?.message ?? '');
  } catch {
    return '';
  }
}

/** Waits for the newest firing of a routine to end, and answers it. */
export async function settledRun(api: StackApi, id: string, timeoutMs = 120_000): Promise<RunJson> {
  let run: RunJson | undefined;
  await expect
    .poll(
      async () => {
        run = (await runsOf(api, id))[0];
        return run?.status ?? 'none';
      },
      { timeout: timeoutMs, message: 'the firing to end' },
    )
    .toMatch(/^(done|failed)$/);
  return run!;
}

/** Runs a queue's job once, as the stack's own worker does on its cron, and waits until it has finished. */
export async function runJobOnce(stack: Stack, queue: string): Promise<void> {
  const id = (await stack.sql<{ id: string }>(`INSERT INTO app.jobs (queue, payload, run_at) VALUES ($1, '{}'::jsonb, now()) RETURNING id`, [queue]))[0]!.id;
  await expect
    .poll(async () => (await stack.sql<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [id]))[0]?.state, { timeout: 30_000, message: `the ${queue} job to finish` })
    .toMatch(/^(done|failed|dead)$/);
  const state = (await stack.sql<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [id]))[0]?.state;
  expect(state, `the ${queue} job ended as ${String(state)}`).toBe('done');
}

/** The tick of the scheduler, then the job that tells owners about stops (what the stack does once a minute). */
export async function tick(stack: Stack): Promise<void> {
  await runJobOnce(stack, 'scheduled-jobs.tick');
  await runJobOnce(stack, 'scheduled-jobs.tell-stops');
}

/** Makes the routine due now, so the next tick looks at it. */
export const makeDue = (stack: Stack, id: string): Promise<unknown> => stack.sql(`UPDATE app.scheduled_jobs SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [id]);

/** The text of a file in the person's Personal space, or null when there is none. */
export async function personalText(api: StackApi, path: string): Promise<string | null> {
  const slash = path.lastIndexOf('/');
  const folder = path.slice(0, slash);
  const tree = await api.get<{ entries: Array<{ kind: string; path: string; fileId: string | null }> }>(`/api/me/files/tree?path=${encodeURIComponent(folder)}`).catch(() => null);
  const name = path.slice(slash + 1);
  const hit = tree?.entries.find((e) => e.kind === 'file' && (e.path === path || e.path.endsWith(`/${name}`) || e.path === name));
  if (!hit?.fileId) return null;
  const res = await api.ctx.get(`/api/files/${hit.fileId}/content`);
  return res.status() === 200 ? res.text() : null;
}

/**
 * A bot of the Engineering team that a routine can be run by in a stack with the stand-in Hermes: its definition asks for `personal.read` (so a person must say yes first),
 * carries a model alias (a Hermes run needs one) and has the tools the stand-in calls.
 */
export const KEEPER_MD = [
  '---',
  'schema: 1',
  'name: Keeper',
  'role: Runs routines for the people who ask',
  'kind: agent',
  'runtime: hermes',
  'model:',
  '  aliases: [smart]',
  'triggers:',
  '  - { type: conversation }',
  '  - { type: mention }',
  'capabilities:',
  '  native: [messages.post, messages.search, files.read, personal.read]',
  '---',
  '',
  '# Keeper',
  '',
].join('\n');

/** Adds the bot `keeper` (as `admin`) and lets it read the Personal space of each of `people` (their own yes). Answers the bot's id. */
export async function addKeeper(stack: Stack, admin: StackApi, people: readonly StackApi[]): Promise<string> {
  const { botId } = await addBot(stack, admin, 'keeper', KEEPER_MD);
  for (const api of people) await setConsent(api, botId, true);
  return botId;
}

/** A person's own answer to "may this bot read my Personal space". */
export async function setConsent(api: StackApi, botId: string, allowed: boolean): Promise<void> {
  const res = await api.ctx.put(`/api/me/bot-consents/${botId}`, { data: { allowed }, headers: await api.headers() });
  expect(res.status(), await res.text()).toBe(200);
}

/** A mail connection of a person (what the "mail" source of a routine needs). Answers a function that takes it away again. */
export async function connectMail(stack: Stack, email: string): Promise<() => Promise<void>> {
  const rows = await stack.sql<{ id: string }>(
    `INSERT INTO app.connections (workspace_id, slug, kind, name, scope, owner_id, status)
     SELECT a.workspace_id, 'e2e-mail', 'email', 'E2E mail', 'person', a.id, 'enabled'
       FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND a.kind = 'person' WHERE p.primary_email = $1
     RETURNING id`,
    [email],
  );
  expect(rows, `a mail connection for ${email}`).toHaveLength(1);
  return async () => void (await stack.sql('DELETE FROM app.connections WHERE id = $1', [rows[0]!.id]));
}

/** The text of the reminder message a stop sends (`stopMessage` in the scheduler), for a routine of that name. */
export const stopMessagesFor = (stack: Stack, name: string): Promise<Array<{ body: string }>> =>
  stack.sql<{ body: string }>('SELECT body FROM app.messages WHERE body LIKE $1 ORDER BY created_at', [`Your routine “${name}” was switched off because %`]);
