import type { Stack } from '../fixtures/stack.ts';
import { personas } from '../fixtures/seed.ts';
import type { PersonaKey } from '../support/env.ts';

/*
 * Helpers of the Approvals specs (PLAN P5-20). Each spec starts a stack seeded with `repo`, where the loader has already made the bot `coder` from the
 * seed's own commit. The approvals themselves are arranged as the database owner, because the only ways to raise one are a bot's run (a model, a runtime)
 * and the MCP gateway, and what these specs check is the screen and the routes behind it: who sees what, who may decide, what deciding does.
 */

export const APPROVALS_STACK_ENV = { MANYTHREADS_STACK_SEED: 'repo' } as const;

const ENGINEERING = '00000000-0000-7000-8000-0000000b0001';

export interface ArrangedApproval {
  id: string;
  path: string;
}

/**
 * Gives the seed's bot a `pages.write` grant (what the approved call is checked against again when it is re-run) and arranges one pending approval
 * per entry: a `pages.write` call that creates `path`, asked by `requester`, which the people named in `approvers` (a role tag) may decide.
 */
export async function arrangeApprovals(
  stack: Stack,
  entries: ReadonlyArray<{ path: string; requester: PersonaKey; approvers?: string[]; threadRootId?: string; channelId?: string }>,
): Promise<ArrangedApproval[]> {
  // the loader (an outbox consumer) makes the bot from the seed's own commit a moment after the stack is up
  let bot: { id: string; actor_id: string } | undefined;
  for (let i = 0; i < 150 && !bot; i += 1) {
    bot = (
      await stack.sql<{ id: string; actor_id: string }>(
        `SELECT b.id, a.id AS actor_id FROM app.bots b JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id WHERE b.team_id = $1 AND b.slug = 'coder'`,
        [ENGINEERING],
      )
    )[0];
    if (!bot) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!bot) throw new Error('the seed has no bot "coder" after 30 s');
  await stack.sql(
    `INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints)
     VALUES ($1, $2, 'pages.write', true, '{}') ON CONFLICT (actor_id, capability) DO NOTHING`,
    [ENGINEERING, bot.actor_id],
  );
  const out: ArrangedApproval[] = [];
  for (const entry of entries) {
    const approvers = entry.approvers ?? ['role:on-call'];
    const scope = { roles: approvers, people: [], leads: approvers.length === 0 };
    const resume = {
      kind: 'tool',
      capability: 'pages.write',
      args: { team: ENGINEERING, mode: 'create', path: entry.path, content: `Written after approval: ${entry.path}` },
      trigger: 'mention',
    };
    const row = (
      await stack.sql<{ id: string }>(
        `INSERT INTO app.approvals (workspace_id, team_id, source, tool, summary, args_preview, resume, approver_scope, requester_id, bot_id, channel_id, thread_root_id)
         VALUES ($1, $2, 'grant', 'pages.write', $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10) RETURNING id`,
        [
          personas.omar.workspaceId,
          ENGINEERING,
          `pages.write · ${entry.path}`,
          JSON.stringify({ path: entry.path, mode: 'create' }),
          JSON.stringify(resume),
          JSON.stringify(scope),
          personas[entry.requester].actorId,
          bot.id,
          entry.channelId ?? null,
          entry.threadRootId ?? null,
        ],
      )
    )[0];
    out.push({ id: row!.id, path: entry.path });
  }
  return out;
}

export const rowOfApproval = (stack: Stack, id: string) =>
  stack.sql<{ status: string; outcome: string; outcome_detail: string }>('SELECT status, outcome, outcome_detail FROM app.approvals WHERE id = $1', [id]).then((r) => r[0]);
