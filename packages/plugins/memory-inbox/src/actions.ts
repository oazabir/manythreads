import { conflict, forbidden, invalid, json, notFound, requireTeam, route, type PluginContext, type PluginTx, type RepoProvider, type TeamRow } from '@manythreads/sdk';
import {
  InboxActionsParams,
  InboxAction,
  ListInboxActionsResponse,
  RecordInboxActionRequest,
  RecordInboxActionResponse,
  isConceptPath,
  listInboxActionsRoute,
  parseActionItems,
  parseConcept,
  recordInboxActionRoute,
} from '@manythreads/shared';
import { ITEM_COLUMNS, type ItemRow } from './rows.ts';

// Action items on the board (PLAN P8-20). A filed item may have produced concepts of type `Action Items` (the Archivist writes one action to a line, in the form
// `- [ ] what (owner: name; due: YYYY-MM-DD)`). This file reads those lines back for the Inbox tab, with a card body ready to send, and records which action became
// which card. It never makes a card itself: the card is the PERSON's act, made by the web through the tasks API as the signed-in person (never as a bot, never as
// the platform), and the person who made it is the one who tells the inbox which action it was. docs/plugins/memory-inbox.md "Action items".

const ACTION_TYPE = 'action items';
const CONCEPTS_MAX = 20;
const CONCEPT_BYTES_MAX = 256 * 1024;

interface RosterRow extends Record<string, unknown> {
  actor_id: string;
  display_name: string;
}

/** The people of the team the owner's name could mean: the whole display name, or, failing that, the first name when only one person has it. */
export function ownerActor(roster: readonly { actor_id: string; display_name: string }[], owner: string | null): string | null {
  if (owner === null) return null;
  const wanted = owner.trim().toLowerCase();
  if (wanted === '') return null;
  const whole = roster.filter((r) => r.display_name.trim().toLowerCase() === wanted);
  if (whole.length === 1) return (whole[0] as { actor_id: string }).actor_id;
  if (whole.length > 1) return null;
  const first = roster.filter((r) => (r.display_name.trim().toLowerCase().split(/\s+/)[0] ?? '') === wanted);
  return first.length === 1 ? (first[0] as { actor_id: string }).actor_id : null;
}

function describe(itemName: string, what: { owner: string | null; due: string | null }, conceptPath: string): string {
  const lines = [`From the memory inbox: “${itemName}”.`];
  if (what.owner !== null) lines.push(`Owner: ${what.owner}`);
  if (what.due !== null) lines.push(`Due: ${what.due}`);
  lines.push(`Written in ${conceptPath}.`);
  return lines.join('\n').slice(0, 4000);
}

/** The actions of every `Action Items` concept the item filed, as the caller may read them. A concept that cannot be read or parsed is skipped. */
export async function readActions(ctx: PluginContext, tx: PluginTx, team: TeamRow, item: ItemRow): Promise<InboxAction[]> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo || item.filed_paths.length === 0) return [];
  const recorded = await tx.query<{ concept_path: string; action_index: number; task_id: string; added_by: string }>(
    'SELECT concept_path, action_index, task_id, added_by FROM app.memory_inbox_actions WHERE item_id = $1',
    [item.id],
  );
  const taken = new Map(recorded.rows.map((r) => [`${r.concept_path}\u0000${String(r.action_index)}`, r]));
  const roster = (await tx.query<RosterRow>('SELECT actor_id, display_name FROM app.teams_roster($1)', [team.id])).rows;
  const out: InboxAction[] = [];
  for (const path of item.filed_paths.filter(isConceptPath).slice(0, CONCEPTS_MAX)) {
    let text: string;
    try {
      text = new TextDecoder().decode((await repo.blob(tx, team.id, path, 'HEAD', CONCEPT_BYTES_MAX)).content);
    } catch {
      continue;
    }
    const concept = parseConcept(text);
    if (!concept.ok || concept.frontmatter.type.trim().toLowerCase() !== ACTION_TYPE) continue;
    for (const line of parseActionItems(concept.body)) {
      const done = taken.get(`${path}\u0000${String(line.index)}`);
      out.push(
        InboxAction.parse({
          conceptPath: path,
          index: line.index,
          what: line.what,
          ownerName: line.owner,
          ownerActorId: ownerActor(roster, line.owner),
          due: line.due,
          done: line.done,
          prepared: { title: line.what.slice(0, 200), description: describe(item.name, line, path), kind: 'other', priority: 'normal', branch: 'main' },
          taskId: done?.task_id ?? null,
          addedBy: done?.added_by ?? null,
        }),
      );
    }
  }
  return out;
}

async function requireItem(tx: PluginTx, team: TeamRow, itemId: string): Promise<ItemRow> {
  const row = (await tx.query<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM app.memory_inbox_items i WHERE i.id = $1 AND i.team_id = $2`, [itemId, team.id])).rows[0];
  if (!row) throw notFound('No such item in this team’s inbox');
  return row;
}

async function mayAdd(tx: PluginTx, team: TeamRow): Promise<boolean> {
  return (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1, 'post') AS ok", [team.id])).rows[0]?.ok === true;
}

export function registerActions(ctx: PluginContext): void {
  ctx.http.route({
    ...listInboxActionsRoute,
    schema: { response: ListInboxActionsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, itemId } = InboxActionsParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const item = await requireItem(tx, team, itemId);
      return json(ListInboxActionsResponse.parse({ actions: await readActions(ctx, tx, team, item), canAdd: await mayAdd(tx, team) }));
    }),
  });

  ctx.http.route({
    ...recordInboxActionRoute,
    schema: { body: RecordInboxActionRequest, response: RecordInboxActionResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, itemId } = InboxActionsParams.parse(req.params);
      const body = RecordInboxActionRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      if (team.archived_at) throw conflict('This team is archived.');
      if (!(await mayAdd(tx, team))) throw forbidden('Only people on this team can add cards to its board.');
      const item = await requireItem(tx, team, itemId);
      const action = (await readActions(ctx, tx, team, item)).find((a) => a.conceptPath === body.conceptPath && a.index === body.index);
      if (!action) throw notFound('That item has no such action.');
      // the card must be a card of this team that THIS person made: a bot's card, or somebody else's, is not "added by you"
      const card = (await tx.query<{ id: string }>('SELECT id FROM app.tasks WHERE id = $1 AND team_id = $2 AND created_by = $3', [body.taskId, team.id, tx.actor.id])).rows[0];
      if (!card) throw invalid('That card is not one you made on this team’s board.');
      if (action.taskId !== null) {
        if (action.taskId === body.taskId) return json(RecordInboxActionResponse.parse({ action }));
        throw conflict('That action is already on the board.');
      }
      const inserted = await tx.query(
        `INSERT INTO app.memory_inbox_actions (workspace_id, team_id, item_id, concept_path, action_index, task_id, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (item_id, concept_path, action_index) DO NOTHING RETURNING id`,
        [team.workspace_id, team.id, item.id, body.conceptPath, body.index, body.taskId, tx.actor.id],
      );
      if (inserted.rows.length === 0) throw conflict('That action is already on the board.');
      return json(RecordInboxActionResponse.parse({ action: { ...action, taskId: body.taskId, addedBy: tx.actor.id } }), 201);
    }),
  });
}
