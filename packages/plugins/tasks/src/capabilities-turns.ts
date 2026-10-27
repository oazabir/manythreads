import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { emitUpdated } from './emit.ts';
import { TASK_SELECT, toTask, type TaskRow } from './rows.ts';

/**
 * Two small tools that let a bot take a turn on a card it shares with others: `tasks.release` gives a card back (the route's door, so a
 * tool call and a click are one history), and `tasks.describe` rewrites the description of a card the caller owns, which is where a bot
 * keeps the working state of a card (a checklist, a running count) between turns. Neither can touch a card the caller does not hold.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_DESCRIPTION = 8000;

async function cardOf(tx: PluginTx, taskId: string) {
  const row = (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1::uuid`, [taskId])).rows[0];
  return row ? toTask(row) : null;
}

const REFUSALS: Record<string, string> = {
  not_found: 'no such card',
  not_owner: 'only the owner can do this: claim the card first',
  already_done: 'the card is finished; nothing about it changes any more',
  waiting_on_person: 'the card waits on a person (a pull request to merge, or a handover to a person); it is not yours to change or give back',
  handoff_pending: 'a handover of this card waits for approval; it is not yours to change or give back until that is decided',
  claim_expired: 'your claim on the card has expired: claim it again first',
  invalid_input: 'the description is not valid text',
};
const refusal = (code: string): { ok: false; code: string; message: string } => ({ ok: false, code, message: REFUSALS[code] ?? code });

export function registerTurnCapabilities(ctx: PluginContext): void {
  ctx.capabilities.register('tasks.release', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    if (!UUID.test(taskId)) return { ok: false, code: 'invalid_input', message: 'taskId must be the card id (a uuid)' };
    const before = await cardOf(tx, taskId);
    const outcome = (await tx.query<{ outcome: string }>('SELECT app.tasks_release($1::uuid) AS outcome', [taskId])).rows[0]?.outcome;
    if (!before || outcome === 'not_found') return { ok: false, code: 'not_found', message: 'no such card' };
    if (outcome !== 'released') return refusal(outcome ?? 'conflict');
    const after = (await cardOf(tx, taskId)) ?? before;
    await emitUpdated(ctx, tx, before, after);
    return { ok: true, taskId, released: true };
  });

  ctx.capabilities.register('tasks.describe', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    if (!UUID.test(taskId)) return { ok: false, code: 'invalid_input', message: 'taskId must be the card id (a uuid)' };
    const description = input['description'];
    if (typeof description !== 'string' || description.length > MAX_DESCRIPTION || description.includes('\u0000')) {
      return { ok: false, code: 'invalid_input', message: `description must be text of at most ${MAX_DESCRIPTION} characters, with no NUL character` };
    }
    const before = await cardOf(tx, taskId);
    if (!before) return { ok: false, code: 'not_found', message: 'no such card' };
    // The door checks everything in one statement under the card's row lock: owner, live claim, state, no handover waiting.
    const outcome = (await tx.query<{ outcome: string }>('SELECT app.tasks_describe($1::uuid, $2) AS outcome', [taskId, description])).rows[0]?.outcome;
    if (outcome !== 'described') return refusal(outcome ?? 'conflict');
    const after = (await cardOf(tx, taskId)) ?? before;
    await emitUpdated(ctx, tx, before, after);
    return { ok: true, taskId, description: after.description };
  });
}
