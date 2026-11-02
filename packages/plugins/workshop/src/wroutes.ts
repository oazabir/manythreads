import { HttpError, conflict, forbidden, invalid, json, notFound, requireTeam, route, type PluginContext, type PluginTx, type TeamRow } from '@manythreads/sdk';
import {
  CreateWorkshopSessionRequest,
  EndWorkshopSessionRequest,
  PostWorkshopMessageRequest,
  WORKSHOP_MAX_MESSAGES,
  WORKSHOP_MAX_OPEN,
  WorkshopBotParams,
  WorkshopSessionListResponse,
  WorkshopSessionParams,
  WorkshopSessionResponse,
  createWorkshopSessionRoute,
  endWorkshopSessionRoute,
  getWorkshopSessionRoute,
  listWorkshopSessionsRoute,
  postWorkshopMessageRoute,
  type WorkshopAbout,
  type WorkshopEntry,
  type WorkshopMode,
} from '@manythreads/shared';
import { askerRole } from './inventory.ts';
import { enqueueTurn, userMessageFor } from './wsession.ts';
import { WS_COLUMNS, entriesOf, failStuckWorkshop, titleOf, toWorkshopSession, type WsRow } from './wrows.ts';

// HTTP for the Workshop tab (PLAN P7-05). Every route runs as the person: the row-level policy of `workshop_sessions` lets a person see only their own conversations (a lead and an admin
// included), so someone else's session id is a plain 404. The routes only write the row and queue the job (`wsession.ts`); the model is never called inside a request.

const WRITE_LIMIT = { limit: 30, windowMs: 60_000 } as const;
const READ_LIMIT = { limit: 600, windowMs: 60_000 } as const;
/** A conversation whose record already holds this many entries takes no more messages: a turn adds up to a few dozen, and the row has a hard size limit. */
const ENTRIES_FULL = 140;
/** What of a rehearsal reply is carried into the Build conversation. */
const ABOUT_EXCERPT_CHARS = 1200;

type BotRef = {
  id: string;
  slug: string;
  status: string;
};

async function botOf(tx: PluginTx, team: TeamRow, botSlug: string): Promise<BotRef> {
  const bot = (await tx.query<BotRef>('SELECT id, slug, status FROM app.bots WHERE team_id = $1::uuid AND slug = $2', [team.id, botSlug])).rows[0];
  if (!bot) throw notFound('No such bot');
  return bot;
}

/** The right each mode needs. Build and Live: posting in the team. Rehearse runs the bot's own tools as the person's: a lead or an admin. */
async function mayUse(tx: PluginTx, team: TeamRow, mode: WorkshopMode): Promise<void> {
  if (mode === 'rehearse') {
    const who = await askerRole(tx, team.id);
    if (!who.onTeam || !who.canGrantDestructive) throw forbidden('Only a team lead or an admin can rehearse a bot');
    return;
  }
  const may = (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1::uuid, 'post') AS ok", [team.id])).rows[0]?.ok === true;
  if (!may) throw forbidden('Only people who can post in this team can use the Workshop');
}

async function ownSession(tx: PluginTx, team: TeamRow, botSlug: string, sessionId: string, lock = false): Promise<WsRow> {
  await failStuckWorkshop(tx);
  const row = (
    await tx.query<WsRow>(`SELECT ${WS_COLUMNS} FROM app.workshop_sessions WHERE id = $1::uuid AND team_id = $2::uuid AND bot_slug = $3${lock ? ' FOR UPDATE' : ''}`, [sessionId, team.id, botSlug])
  ).rows[0];
  if (!row) throw notFound('No such Workshop conversation');
  return row;
}

/** The reply of the person's own Rehearse conversation that a Build message corrects. Read through the person's transaction: someone else's conversation does not exist for them. */
async function aboutOf(tx: PluginTx, team: TeamRow, botSlug: string, about: WorkshopAbout): Promise<NonNullable<Extract<WorkshopEntry, { kind: 'person' }>['about']>> {
  const row = (
    await tx.query<WsRow>(`SELECT ${WS_COLUMNS} FROM app.workshop_sessions WHERE id = $1::uuid AND team_id = $2::uuid AND bot_slug = $3 AND mode = 'rehearse'`, [about.sessionId, team.id, botSlug])
  ).rows[0];
  const entry = row ? entriesOf(row.entries).find((e) => e.id === about.entryId) : undefined;
  if (!entry || entry.kind !== 'reply') throw invalid('about: that is not a reply of your rehearsal of this bot');
  return { sessionId: about.sessionId, entryId: about.entryId, excerpt: entry.text.slice(0, ABOUT_EXCERPT_CHARS) };
}

export function registerWorkshopRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: createWorkshopSessionRoute.method,
    path: createWorkshopSessionRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: CreateWorkshopSessionRequest, response: WorkshopSessionResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = WorkshopBotParams.parse(req.params);
      const body = CreateWorkshopSessionRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      if (team.archived_at) throw conflict('This team is archived');
      const bot = await botOf(tx, team, botSlug);
      await mayUse(tx, team, body.mode);
      if (body.mode === 'rehearse' && bot.status !== 'active') throw conflict('This bot is switched off or does not load, so it cannot be rehearsed');
      if (!ctx.providers.get('llm')) throw new HttpError(503, 'internal', 'The model gateway is not available, so the helper cannot run');
      // One start at a time per person: the count and the insert are one step, so parallel requests cannot all pass the limit. A stuck conversation does not count.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`workshop.session:${tx.actor.id}`]);
      await failStuckWorkshop(tx);
      const open = (await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.workshop_sessions WHERE owner_id = (SELECT app.actor()) AND status IN ('working', 'ready')")).rows[0]?.n ?? '0';
      if (Number(open) >= WORKSHOP_MAX_OPEN) throw conflict('You already have Workshop conversations open. End one first.');
      const at = new Date().toISOString();
      const first = body.text === undefined ? [] : [{ id: 'e1', at, kind: 'person', text: body.text }];
      const history = body.text === undefined ? [] : [{ role: 'user', content: body.text }];
      const row = (
        await tx.query<WsRow>(
          `INSERT INTO app.workshop_sessions (workspace_id, team_id, bot_id, bot_slug, owner_id, mode, status, title, entries, history, message_count, turn)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, (SELECT app.actor()), $5, $6, $7, $8::jsonb, $9::jsonb, $10::int, $11::int) RETURNING ${WS_COLUMNS}`,
          [team.workspace_id, team.id, bot.id, bot.slug, body.mode, body.text === undefined ? 'ready' : 'working', body.text === undefined ? '' : titleOf(body.text), JSON.stringify(first), JSON.stringify(history), body.text === undefined ? 0 : 1, body.text === undefined ? 0 : 1],
        )
      ).rows[0] as WsRow;
      if (body.text !== undefined) await enqueueTurn(ctx, tx, team.workspace_id, row.id, row.turn);
      return json(WorkshopSessionResponse.parse({ session: toWorkshopSession(row) }), 201);
    }),
  });

  ctx.http.route({
    method: listWorkshopSessionsRoute.method,
    path: listWorkshopSessionsRoute.path,
    rateLimit: READ_LIMIT,
    schema: { response: WorkshopSessionListResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = WorkshopBotParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await botOf(tx, team, botSlug);
      await failStuckWorkshop(tx);
      const rows = (
        await tx.query<WsRow>(`SELECT ${WS_COLUMNS} FROM app.workshop_sessions WHERE team_id = $1::uuid AND bot_slug = $2 ORDER BY updated_at DESC, id DESC LIMIT 20`, [team.id, botSlug])
      ).rows;
      return json(
        WorkshopSessionListResponse.parse({
          sessions: rows.map((r) => {
            const s = toWorkshopSession(r);
            return { id: s.id, mode: s.mode, status: s.status, title: s.title, messageCount: s.messageCount, updatedAt: s.updatedAt };
          }),
        }),
      );
    }),
  });

  ctx.http.route({
    method: getWorkshopSessionRoute.method,
    path: getWorkshopSessionRoute.path,
    rateLimit: READ_LIMIT,
    schema: { response: WorkshopSessionResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug, sessionId } = WorkshopSessionParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      return json(WorkshopSessionResponse.parse({ session: toWorkshopSession(await ownSession(tx, team, botSlug, sessionId)) }));
    }),
  });

  ctx.http.route({
    method: postWorkshopMessageRoute.method,
    path: postWorkshopMessageRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: PostWorkshopMessageRequest, response: WorkshopSessionResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug, sessionId } = WorkshopSessionParams.parse(req.params);
      const body = PostWorkshopMessageRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const row = await ownSession(tx, team, botSlug, sessionId, true);
      if (row.status === 'working') throw conflict('The helper is still answering. Wait for the answer first.');
      if (row.status !== 'ready') throw conflict('This conversation is over. Start a new one.');
      if (row.message_count >= WORKSHOP_MAX_MESSAGES) throw conflict(`A conversation takes ${String(WORKSHOP_MAX_MESSAGES)} messages. Start a new one.`);
      const entries = entriesOf(row.entries);
      if (entries.length >= ENTRIES_FULL) throw conflict('This conversation is full. Start a new one.');
      if (body.about && row.mode !== 'build') throw invalid('about: only a Build message can be about a rehearsal reply');
      const bot = await botOf(tx, team, botSlug);
      await mayUse(tx, team, row.mode);
      if (row.mode === 'rehearse' && bot.status !== 'active') throw conflict('This bot is switched off or does not load, so it cannot be rehearsed');
      const about = body.about ? await aboutOf(tx, team, botSlug, body.about) : undefined;
      const nextId = entries.reduce((n, e) => Math.max(n, Number(e.id.slice(1))), 0) + 1;
      const entry = { id: `e${String(nextId)}`, at: new Date().toISOString(), kind: 'person' as const, text: body.text, ...(about ? { about } : {}) };
      const history = [...(Array.isArray(row.history) ? (row.history as unknown[]) : []), { role: 'user', content: userMessageFor(body.text, about) }];
      const updated = (
        await tx.query<WsRow>(
          `UPDATE app.workshop_sessions
              SET status = 'working', entries = $2::jsonb, history = $3::jsonb, message_count = message_count + 1, turn = turn + 1, message = NULL,
                  title = CASE WHEN title = '' THEN $4 ELSE title END, updated_at = now()
            WHERE id = $1::uuid RETURNING ${WS_COLUMNS}`,
          [row.id, JSON.stringify([...entries, entry]), JSON.stringify(history), titleOf(body.text)],
        )
      ).rows[0] as WsRow;
      await enqueueTurn(ctx, tx, team.workspace_id, row.id, updated.turn);
      return json(WorkshopSessionResponse.parse({ session: toWorkshopSession(updated) }));
    }),
  });

  ctx.http.route({
    method: endWorkshopSessionRoute.method,
    path: endWorkshopSessionRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: EndWorkshopSessionRequest, response: WorkshopSessionResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug, sessionId } = WorkshopSessionParams.parse(req.params);
      EndWorkshopSessionRequest.parse(req.body ?? {});
      const team = await requireTeam(tx, slug);
      const row = await ownSession(tx, team, botSlug, sessionId, true);
      if (row.status !== 'working' && row.status !== 'ready') return json(WorkshopSessionResponse.parse({ session: toWorkshopSession(row) }));
      // ending a working conversation cancels it: the job's next write finds the row no longer working and stops
      const next = row.status === 'working' ? 'cancelled' : 'ended';
      const updated = (
        await tx.query<WsRow>(`UPDATE app.workshop_sessions SET status = $2, updated_at = now() WHERE id = $1::uuid RETURNING ${WS_COLUMNS}`, [row.id, next])
      ).rows[0] as WsRow;
      return json(WorkshopSessionResponse.parse({ session: toWorkshopSession(updated) }));
    }),
  });
}
