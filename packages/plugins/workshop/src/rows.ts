import type { PluginTx } from '@manythreads/sdk';
import { SetupSession, type SetupStatus } from '@manythreads/shared';

// Reading and writing `app.setup_sessions`: the one mapper. `history` (the helper's own conversation) is read where the job needs it and never mapped to the API shape.

export type SessionRow = {
  id: string;
  workspace_id: string;
  team_id: string;
  owner_id: string;
  status: SetupStatus;
  brief: string;
  name: string | null;
  requirements: unknown;
  questions: unknown;
  answers: unknown;
  inventory: unknown;
  proposals: unknown;
  limits: unknown;
  history: unknown;
  message: string | null;
  rounds: number;
  created_at: Date;
  updated_at: Date;
};

export const SESSION_COLUMNS =
  'id, workspace_id, team_id, owner_id, status, brief, name, requirements, questions, answers, inventory, proposals, limits, history, message, rounds, created_at, updated_at';

export const toSession = (r: SessionRow): SetupSession =>
  SetupSession.parse({
    id: r.id,
    teamId: r.team_id,
    status: r.status,
    brief: r.brief,
    name: r.name,
    requirements: r.requirements,
    questions: r.questions,
    answers: r.answers,
    inventory: r.inventory,
    proposals: r.proposals,
    limits: r.limits,
    message: r.message,
    rounds: r.rounds,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });

/** What a step of the helper changes in a session row. Only the fields present are written. */
export interface SessionPatch {
  status?: SetupStatus;
  name?: string | null;
  requirements?: unknown;
  questions?: unknown;
  answers?: unknown;
  inventory?: unknown;
  proposals?: unknown;
  limits?: unknown;
  history?: unknown;
  message?: string | null;
  rounds?: number;
}

const JSON_FIELDS = new Set(['requirements', 'questions', 'answers', 'inventory', 'proposals', 'limits', 'history']);
const PLAIN_FIELDS = new Set(['status', 'name', 'message', 'rounds']);

/**
 * Writes a patch to a session that is still `working` (a person who cancelled meanwhile is never overwritten). Returns false when the row was no longer working. The column names come from
 * this file's own patch keys, never from outside.
 */
export async function patchWorking(tx: PluginTx, id: string, patch: SessionPatch): Promise<boolean> {
  const sets: string[] = ['updated_at = now()'];
  const args: unknown[] = [id];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!JSON_FIELDS.has(key) && !PLAIN_FIELDS.has(key)) throw new Error(`setup_sessions has no patchable column "${key}"`);
    const column = key;
    args.push(JSON_FIELDS.has(key) ? JSON.stringify(value) : value);
    sets.push(`${column} = $${args.length}${JSON_FIELDS.has(key) ? '::jsonb' : ''}`);
  }
  const res = await tx.query(`UPDATE app.setup_sessions SET ${sets.join(', ')} WHERE id = $1::uuid AND status = 'working' RETURNING id`, args);
  return res.rows.length > 0;
}

/** A session whose helper has written nothing for this long is taken as stuck (the server stopped mid-run, the model call never came back). Every step of a live one writes the row. */
export const STUCK_AFTER_MINUTES = 10;
export const STUCK_MESSAGE = 'The helper stopped answering. Start again, or add the bot by hand.';

/**
 * Turns the person's own `working` sessions that have not been written for `STUCK_AFTER_MINUTES` into `failed`, with one plain sentence. Run whenever the person reads or starts one, so a
 * stuck session neither hangs the screen for ever nor counts against the open-session limit. A late write from the dead job finds the row no longer `working` and changes nothing.
 */
export async function failStuck(tx: PluginTx): Promise<number> {
  const res = await tx.query(
    `UPDATE app.setup_sessions SET status = 'failed', questions = '[]'::jsonb, message = $1, updated_at = now()
      WHERE owner_id = (SELECT app.actor()) AND status = 'working' AND updated_at < now() - make_interval(mins => $2::int) RETURNING id`,
    [STUCK_MESSAGE, STUCK_AFTER_MINUTES],
  );
  return res.rows.length;
}
