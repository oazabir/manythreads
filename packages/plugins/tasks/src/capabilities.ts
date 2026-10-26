import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { BOT_BOARD_NAME, CreateTaskRequest, DEFAULT_BOARD_COLUMNS, TasksBoardCreatedEvent } from '@manythreads/shared';
import { insertCard } from './create.ts';
import { postHandoffCard } from './card.ts';
import { emitCompleted, emitHandedOff, emitUpdated } from './emit.ts';
import { handoverAllowlist, isCardCreator, mayHandoffToActor } from './handoff.ts';
import { TASK_SELECT, toBoard, toHandoff, toTask, type BoardRow, type HandoffRow, type TaskRow } from './rows.ts';

/**
 * The `tasks.*` tools a bot may be granted (PLAN P6-02). They are the same doors the routes use: the bot's allowlist decides whether the
 * broker offers them, and the SQL functions decide the rest (ownership, freshness, bounds), so a tool call and a drag cannot disagree.
 */
async function cardOf(tx: PluginTx, taskId: string) {
  const row = (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1::uuid`, [taskId])).rows[0];
  return row ? toTask(row) : null;
}

type ActorLabel = { kind: string; name: string; slug: string | null };

/** Names for a list of actor ids (a person cannot read another actor's row, so this goes through the tasks door). */
async function actorLabels(tx: PluginTx, ids: string[]): Promise<Map<string, ActorLabel>> {
  if (ids.length === 0) return new Map();
  const res = await tx.query<{ o_actor_id: string; o_kind: string; o_name: string; o_slug: string | null }>(
    'SELECT o_actor_id, o_kind, o_name, o_slug FROM app.tasks_actor_labels($1::uuid[])',
    [ids],
  );
  return new Map(res.rows.map((r) => [r.o_actor_id, { kind: r.o_kind, name: r.o_name, slug: r.o_slug }]));
}

/** A bot reads by its slug (what `toBotSlug` and `mayTag` use), a person by display name; the caller's own actor ends in "(you)". */
export function labelOf(labels: Map<string, ActorLabel>, id: string, self: string): string {
  const l = labels.get(id);
  const base = l ? (l.slug ?? l.name) : 'unknown';
  return id === self ? `${base} (you)` : base;
}

export function registerCapabilities(ctx: PluginContext): void {
  ctx.capabilities.register('tasks.read', async (input, tx) => {
    const taskId = typeof input['taskId'] === 'string' ? input['taskId'] : null;
    const rows = await tx.query<{ owner_id: string | null; created_by: string | null }>(
      `SELECT t.id, t.title, t.state, t.kind, t.priority, t.owner_id, t.created_by, t.board_id, t.branch, t.base_sha, t.tested_sha, t.rework_count, t.handoff_count
         FROM app.tasks t
        WHERE t.team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
          AND ($1::uuid IS NULL OR t.id = $1::uuid)
        ORDER BY t.updated_at DESC
        LIMIT 50`,
      [taskId],
    );
    // An id alone tells a bot nothing (live bug: a Reviewer read its own actor id as the Coder's). Every owner and creator is named next to
    // its id, and the caller's own cards say so: `owner: "reviewer (you)"`.
    const ids = [...new Set(rows.rows.flatMap((r) => [r.owner_id, r.created_by, tx.actor.id]).filter((v): v is string => v !== null))];
    const labels = await actorLabels(tx, ids);
    const name = (id: string | null): string | null => (id === null ? null : labelOf(labels, id, tx.actor.id));
    return {
      ok: true,
      you: name(tx.actor.id),
      tasks: rows.rows.map((r) => ({ ...r, owner: name(r.owner_id), creator: name(r.created_by) })),
    };
  });

  // Creating a card is the Orchestrator's one act (SPEC §8): the run writes the card in its bot's team, never in a team the caller names.
  // The card goes through the route's own door (`insertCard`), so a card created by a tool and one created by a person are the same row and
  // the same `created` history. There is no assign tool: assignment is a handover, with the caller's `mayTag` deciding the target.
  ctx.capabilities.register('tasks.create', async (input, tx) => {
    const parsed = CreateTaskRequest.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.map(String).join('.') || 'input';
      return { ok: false, code: 'invalid_input', message: `${field}: ${issue?.message ?? 'invalid'}` };
    }
    const body = parsed.data;
    const bot = (
      await tx.query<{ team_id: string; workspace_id: string }>(
        `SELECT b.team_id, b.workspace_id FROM app.actors a JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot' WHERE a.id = $1::uuid`,
        [tx.actor.id],
      )
    ).rows[0];
    if (!bot) return { ok: false, code: 'forbidden', message: 'only a bot of a team creates a card' };
    if (body.goalId) {
      const goal = await tx.query('SELECT 1 FROM app.goals WHERE id = $1::uuid AND team_id = $2::uuid', [body.goalId, bot.team_id]);
      if (goal.rows.length === 0) return { ok: false, code: 'not_found', message: 'no such goal in this team' };
    }
    if (body.environmentId) {
      const env = await tx.query('SELECT 1 FROM app.environments WHERE id = $1::uuid AND team_id = $2::uuid', [body.environmentId, bot.team_id]);
      if (env.rows.length === 0) return { ok: false, code: 'not_found', message: 'no such environment in this team' };
    }
    // A card goes on the named board, or else on the Bot Board of the channel this run answers in when that board already exists (it is made
    // by `boards.ensure`, never here). A named board must be one of this team's (the door also checks the channel is readable).
    let boardId: string | null = body.boardId ?? null;
    if (boardId) {
      const board = await tx.query('SELECT 1 FROM app.boards WHERE id = $1::uuid AND team_id = $2::uuid', [boardId, bot.team_id]);
      if (board.rows.length === 0) return { ok: false, code: 'not_found', message: 'no such board in this team' };
    } else {
      boardId =
        (
          await tx.query<{ id: string }>(
            `SELECT b.id FROM app.boards b WHERE b.channel_id = (SELECT app.tasks_run_channel()) AND b.name = $1 AND b.team_id = $2::uuid`,
            [BOT_BOARD_NAME, bot.team_id],
          )
        ).rows[0]?.id ?? null;
    }
    const task = await insertCard(ctx, tx, {
      boardId,
      workspaceId: bot.workspace_id,
      teamId: bot.team_id,
      goalId: body.goalId ?? null,
      title: body.title,
      description: body.description,
      kind: body.kind,
      priority: body.priority,
      branch: body.branch,
      environmentId: body.environmentId ?? null,
      actorId: tx.actor.id,
    });
    // A card made in a run that answers in a thread of this team belongs to that thread, so its completion can wake the creator there.
    // The door does nothing when the run has no such thread; the card is read again to carry the link.
    await tx.query('SELECT app.tasks_link_run_thread($1::uuid)', [task.id]);
    return { ok: true, task: (await cardOf(tx, task.id)) ?? task };
  });

  // The one board a bot may create: the "Bot Board" of a team channel, where every bot card of that channel lives. Get-or-create in one
  // statement on the unique index (channel, name), so two runs asking at once end with one board. A board of that name already attached to the
  // channel counts, whoever made it; a team board of that name that is not attached to the channel does not.
  ctx.capabilities.register('boards.ensure', async (input, tx) => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const asked = input['channelId'];
    if (asked !== undefined && asked !== null && (typeof asked !== 'string' || !UUID.test(asked))) {
      return { ok: false, code: 'invalid_input', message: 'channelId must be a channel id (a uuid), or left out for the channel of this run' };
    }
    const bot = (
      await tx.query<{ team_id: string; workspace_id: string }>(
        `SELECT b.team_id, b.workspace_id FROM app.actors a JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot' WHERE a.id = $1::uuid`,
        [tx.actor.id],
      )
    ).rows[0];
    if (!bot) return { ok: false, code: 'forbidden', message: 'only a bot of a team ensures a board' };
    const channelId = typeof asked === 'string' ? asked : (await tx.query<{ id: string | null }>('SELECT app.tasks_run_channel() AS id')).rows[0]?.id;
    if (!channelId) return { ok: false, code: 'invalid_input', message: 'no channel: pass channelId, this run does not answer in a team channel' };
    // A team channel of the bot's own team, not archived, that the caller may post in (a direct message, a bot conversation or a channel of
    // another team is refused as "not found", the same words for a channel that does not exist).
    const channel = (
      await tx.query<{ id: string }>(
        `SELECT c.id FROM app.channels c
          WHERE c.id = $1::uuid AND c.kind = 'channel' AND c.archived_at IS NULL AND c.team_id = $2::uuid
            AND c.id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])`,
        [channelId, bot.team_id],
      )
    ).rows[0];
    if (!channel) return { ok: false, code: 'not_found', message: 'no such team channel that you can post in (not a direct message, not archived, not another team)' };
    const drawn = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
    const row = await ctx.db.getOneOrCreate<BoardRow>(tx, {
      table: 'app.boards',
      values: {
        id: drawn,
        workspace_id: bot.workspace_id,
        team_id: bot.team_id,
        channel_id: channel.id,
        name: BOT_BOARD_NAME,
        columns: JSON.stringify(DEFAULT_BOARD_COLUMNS),
        created_by: tx.actor.id,
      },
      conflict: ['channel_id', 'name'],
      conflictWhere: 'channel_id IS NOT NULL',
    });
    const board = toBoard(row);
    if (row.id === drawn) {
      await ctx.audit.emit(
        tx,
        TasksBoardCreatedEvent.parse({
          type: 'tasks.board.created',
          schemaVersion: 1,
          workspaceId: board.workspaceId,
          teamId: board.teamId,
          boardId: board.id,
          channelId: board.channelId,
          name: board.name,
          creatorId: tx.actor.id,
        }),
      );
    }
    return { ok: true, created: row.id === drawn, board };
  });

  ctx.capabilities.register('tasks.claim', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    if (!taskId) return { ok: false, code: 'invalid_input', message: 'taskId is required' };
    const releaseAt = typeof input['ttlSeconds'] === 'number' ? Math.floor(input['ttlSeconds']) : 3600;
    const res = (await tx.query<{ o_outcome: string; o_owner_id: string | null; o_expires_at: Date | null }>('SELECT * FROM app.tasks_claim($1::uuid, $2)', [taskId, releaseAt])).rows[0];
    if (!res) return { ok: false, code: 'not_found', message: 'no such card' };
    // Claiming a card you already hold is a no-op that succeeds: no second claim row, no event (a model that lost track of what it owns just continues).
    if (res.o_outcome === 'already_owned' && res.o_owner_id === tx.actor.id) {
      const live = await tx.query<{ expires_at: Date }>('SELECT expires_at FROM app.task_claims WHERE task_id = $1::uuid AND released_at IS NULL ORDER BY claimed_at DESC LIMIT 1', [taskId]);
      return { ok: true, taskId, alreadyYours: true, expiresAt: (live.rows[0]?.expires_at ?? new Date()).toISOString() };
    }
    if (res.o_outcome !== 'claimed') return { ok: false, code: res.o_outcome, message: res.o_outcome };
    return { ok: true, taskId, expiresAt: (res.o_expires_at ?? new Date()).toISOString() };
  });

  ctx.capabilities.register('tasks.complete', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    if (!taskId) return { ok: false, code: 'invalid_input', message: 'taskId is required' };
    const testedSha = typeof input['testedSha'] === 'string' ? input['testedSha'] : null;
    const branchHeadSha = typeof input['branchHeadSha'] === 'string' ? input['branchHeadSha'] : null;
    const before = await cardOf(tx, taskId);
    const res = (await tx.query<{ o_outcome: string; o_reason: string }>('SELECT * FROM app.tasks_complete($1::uuid, $2, $3)', [taskId, testedSha, branchHeadSha])).rows[0];
    if (!res || !before) return { ok: false, code: 'not_found', message: 'no such card' };
    if (res.o_outcome !== 'done') return { ok: false, code: res.o_outcome, message: res.o_reason || res.o_outcome };
    // The same two events the route writes: a tool call and a drag are one history, and whoever watches the card (a board, the creator bot) hears both.
    const after = (await cardOf(tx, taskId)) ?? before;
    await emitCompleted(ctx, tx, after);
    await emitUpdated(ctx, tx, before, after);
    // A done card keeps no private notes.
    await tx.query('SELECT app.tasks_drop_private_notes($1::uuid)', [taskId]);
    return { ok: true, taskId, testedSha };
  });

  ctx.capabilities.register('tasks.handoff', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    const mode = input['mode'] === 'person' ? 'person' : 'bot';
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID.test(taskId)) return { ok: false, code: 'invalid_input', message: 'taskId must be the card id (a uuid) from tasks.read' };
    // The target is named by bot slug (`toBotSlug`, what handover.mayTag lists) or by actor id (`toActorId`). A model that has only a slug
    // often puts it in `toActorId`, so a value that is not a uuid is read as a slug rather than failing inside the database.
    const named = [input['toBotSlug'], input['toActorId'], input['to']].find((v): v is string => typeof v === 'string' && v.trim() !== '')?.trim();
    if (!named) return { ok: false, code: 'invalid_input', message: 'name who takes the card: toBotSlug (a bot of your team, e.g. "reviewer") or toActorId' };
    let toActorId = named;
    if (!UUID.test(named)) {
      const bot = (
        await tx.query<{ team_id: string }>(`SELECT b.team_id FROM app.actors a JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot' WHERE a.id = $1::uuid`, [tx.actor.id])
      ).rows[0];
      const target = bot ? (await tx.query<{ id: string }>('SELECT o_actor_id AS id FROM app.tasks_bot_of($1::uuid, $2)', [bot.team_id, named])).rows[0] : undefined;
      if (!target) return { ok: false, code: 'not_found', message: `no active bot "${named}" in your team; pass toBotSlug with the slug of a bot you may hand to` };
      toActorId = target.id;
    }
    // The same allowlist the board enforces (P6-03): a bot reaches only the people and bots its grant's `mayTag` names, plus the card's creator
    // (a hand-back is always allowed). The refusal says outright that nothing moved, so a model cannot report a handover that did not happen.
    const mayTag = await handoverAllowlist(tx, tx.actor.id);
    if (mayTag !== null && !(await mayHandoffToActor(tx, mayTag, toActorId)) && !(await isCardCreator(tx, taskId, toActorId))) {
      return {
        ok: false,
        code: 'forbidden',
        message: `not handed over: "${named}" is not in your handover.mayTag${mayTag.length ? ` (${mayTag.join(', ')})` : ' (it is empty)'} and did not create this card; the card is still yours. Hand it to one of those or to its creator, or say in the thread that you could not`,
      };
    }
    const note = typeof input['note'] === 'string' ? input['note'] : '';
    // A private note (a password, a token) travels sealed, never in the visible note: checked before anything moves.
    const privateNote = input['privateNote'];
    if (privateNote !== undefined && (typeof privateNote !== 'string' || privateNote.length < 1 || privateNote.length > 4000)) {
      return { ok: false, code: 'invalid_input', message: 'privateNote must be a string of 1 to 4000 characters' };
    }
    const before = await cardOf(tx, taskId);
    const res = (
      await tx.query<{ o_outcome: string; o_handoff_id: string | null; o_reason: string }>('SELECT * FROM app.tasks_handoff($1::uuid, $2::uuid, $3, $4, NULL)', [taskId, toActorId, mode, note])
    ).rows[0];
    if (!res || !before) return { ok: false, code: 'not_found', message: 'no such card' };
    if (res.o_outcome !== 'moved' || !res.o_handoff_id) return { ok: false, code: res.o_outcome, message: res.o_reason || res.o_outcome };
    // Same as the route: the events (the second one wakes the new owner), then the visible card message in the card's thread.
    // Sealed in the platform's secret store (written by the system, like every secret); the handover row keeps only the secret's id. A failure
    // here throws, which rolls the whole handover back: a note that did not arrive must not look as if it had.
    let hasPrivateNote = false;
    if (typeof privateNote === 'string') {
      // Sealed and ticketed for this caller in one system transaction: only a secret the tasks door sealed for the caller can be attached.
      const secretId = await ctx.db.system(
        async (sys) => {
          const id = await ctx.secrets.put(sys, privateNote);
          await sys.query('SELECT app.tasks_ticket_private_note($1::uuid, $2::uuid)', [id, tx.actor.id]);
          return id;
        },
        { workspaceId: tx.actor.workspaceId },
      );
      const attached = (await tx.query<{ ok: boolean }>('SELECT app.tasks_set_private_note($1::uuid, $2::uuid) AS ok', [res.o_handoff_id, secretId])).rows[0]?.ok === true;
      if (!attached) throw new Error('the private note could not be attached to the handover');
      hasPrivateNote = true;
    }
    const handoffRow = (await tx.query<HandoffRow>('SELECT * FROM app.handoffs WHERE id = $1::uuid', [res.o_handoff_id])).rows[0];
    const after = (await cardOf(tx, taskId)) ?? before;
    if (handoffRow) {
      await emitHandedOff(ctx, tx, after, toHandoff(handoffRow));
      await emitUpdated(ctx, tx, before, after);
      await postHandoffCard(ctx, tx, { task: after, handoffId: res.o_handoff_id, toActorId, note, pending: false, privateNote: hasPrivateNote });
    }
    return { ok: true, taskId, handoffId: res.o_handoff_id, ...(hasPrivateNote ? { privateNoteSealed: true } : {}) };
  });

  // The secret half of a handover. Only the bot the latest handover gave the card to, while it still owns it; the database answers the secret's
  // id for that caller alone and the system decrypts it. The text is returned to the caller and goes nowhere else (no event, no history).
  ctx.capabilities.register('tasks.private_note', async (input, tx) => {
    const taskId = String(input['taskId'] ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) return { ok: false, code: 'invalid_input', message: 'taskId must be the card id (a uuid)' };
    const none = { ok: false, code: 'no_private_note', message: 'no private note was passed to you with this card, or the card is no longer yours' };
    if (tx.actor.kind !== 'bot') return none;
    const secretId = (await tx.query<{ id: string | null }>('SELECT app.tasks_private_note_secret($1::uuid) AS id', [taskId])).rows[0]?.id;
    if (!secretId) return none;
    const note = await ctx.db.system((sys) => ctx.secrets.get(sys, secretId), { workspaceId: tx.actor.workspaceId });
    return { ok: true, taskId, privateNote: note, warning: 'Secret. Never repeat it in a message, a card note, memory or a log.' };
  });

  ctx.capabilities.register('tasks.deploy', async (input, tx) => {
    const environmentId = String(input['environmentId'] ?? '');
    if (!environmentId) return { ok: false, code: 'invalid_input', message: 'environmentId is required' };
    const taskId = typeof input['taskId'] === 'string' ? input['taskId'] : null;
    const res = (
      await tx.query<{ o_outcome: string; o_reason: string; o_approval_id: string | null; o_deploy_id: string | null }>(
        'SELECT * FROM app.tasks_deploy_request($1::uuid, $2::uuid, $3)',
        [environmentId, taskId, typeof input['note'] === 'string' ? input['note'] : ''],
      )
    ).rows[0];
    if (!res) return { ok: false, code: 'internal', message: 'the deploy check answered nothing' };
    if (res.o_outcome === 'deployed') return { ok: true, environmentId, taskId };
    return { ok: false, code: res.o_outcome, message: res.o_reason, approvalId: res.o_approval_id };
  });
}
