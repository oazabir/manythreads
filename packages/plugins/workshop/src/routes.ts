import { HttpError, conflict, forbidden, invalid, json, notFound, requireTeam, route, type PluginContext, type PluginTx, type TeamRow } from '@manythreads/sdk';
import {
  AnswerSetupRequest,
  CancelSetupRequest,
  CreateSetupSessionRequest,
  SetupQuestion,
  SetupSessionParams,
  SetupSessionResponse,
  TeamSetupParams,
  answerSetupRoute,
  cancelSetupRoute,
  createSetupSessionRoute,
  getSetupSessionRoute,
} from '@manythreads/shared';
import { z } from 'zod';
import { SESSION_COLUMNS, failStuck, toSession, type SessionRow } from './rows.ts';
import { answersMessage, enqueueSetup } from './session.ts';

// HTTP for "Add a bot" (PLAN P7-04). Every route runs as the person: the row-level policy of `setup_sessions` lets a person see only their own sessions, so a session id of someone else is a
// plain 404. The routes only write the row and queue the job (`session.ts`); the model is never called inside a request.

const WRITE_LIMIT = { limit: 30, windowMs: 60_000 } as const;
const READ_LIMIT = { limit: 600, windowMs: 60_000 } as const;
/** Conversations one person may have open (working or waiting for answers) at once. */
const OPEN_PER_PERSON = 3;

async function ownSession(tx: PluginTx, team: TeamRow, sessionId: string, lock = false): Promise<SessionRow> {
  await failStuck(tx);
  const row = (
    await tx.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM app.setup_sessions WHERE id = $1::uuid AND team_id = $2::uuid${lock ? ' FOR UPDATE' : ''}`, [sessionId, team.id])
  ).rows[0];
  if (!row) throw notFound('No such setup conversation');
  return row;
}

export function registerSetupRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: createSetupSessionRoute.method,
    path: createSetupSessionRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: CreateSetupSessionRequest, response: SetupSessionResponse },
    handler: route(async (req, tx) => {
      const { slug } = TeamSetupParams.parse(req.params);
      const body = CreateSetupSessionRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      if (team.archived_at) throw conflict('This team is archived, so no bot can be added to it');
      // the same right as proposing a change to the team's files: whoever may post in the team
      const may = (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1::uuid, 'post') AS ok", [team.id])).rows[0]?.ok === true;
      if (!may) throw forbidden('Only people who can post in this team can set up a bot for it');
      if (!ctx.providers.get('llm')) throw new HttpError(503, 'internal', 'The model gateway is not available, so the helper cannot run');
      // One start at a time per person: the count below and the insert are one step, so parallel requests cannot all pass the limit. A stuck session does not count against it.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`workshop.setup:${tx.actor.id}`]);
      await failStuck(tx);
      const open = (await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.setup_sessions WHERE owner_id = (SELECT app.actor()) AND status IN ('working', 'asking')")).rows[0]?.n ?? '0';
      if (Number(open) >= OPEN_PER_PERSON) throw conflict('You already have setup conversations open. Finish or cancel one first.');
      const row = (
        await tx.query<SessionRow>(
          `INSERT INTO app.setup_sessions (workspace_id, team_id, owner_id, brief, name)
           VALUES ($1::uuid, $2::uuid, (SELECT app.actor()), $3, $4) RETURNING ${SESSION_COLUMNS}`,
          [team.workspace_id, team.id, body.brief, body.name ?? null],
        )
      ).rows[0] as SessionRow;
      await enqueueSetup(ctx, tx, team.workspace_id, row.id, 0);
      return json(SetupSessionResponse.parse({ session: toSession(row) }), 201);
    }),
  });

  ctx.http.route({
    method: getSetupSessionRoute.method,
    path: getSetupSessionRoute.path,
    rateLimit: READ_LIMIT,
    schema: { response: SetupSessionResponse },
    handler: route(async (req, tx) => {
      const { slug, sessionId } = SetupSessionParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      return json(SetupSessionResponse.parse({ session: toSession(await ownSession(tx, team, sessionId)) }));
    }),
  });

  ctx.http.route({
    method: answerSetupRoute.method,
    path: answerSetupRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: AnswerSetupRequest, response: SetupSessionResponse },
    handler: route(async (req, tx) => {
      const { slug, sessionId } = SetupSessionParams.parse(req.params);
      const body = AnswerSetupRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      const row = await ownSession(tx, team, sessionId, true);
      if (row.status !== 'asking') throw conflict('This conversation is not waiting for answers');
      const questions = z.array(SetupQuestion).parse(row.questions);
      const given = new Map<string, string>();
      for (const a of body.answers) {
        if (!questions.some((q) => q.id === a.questionId)) throw invalid(`answers: there is no open question ${a.questionId}`);
        if (given.has(a.questionId)) throw invalid(`answers: question ${a.questionId} is answered twice`);
        given.set(a.questionId, a.text);
      }
      const missing = questions.filter((q) => !given.has(q.id));
      if (missing.length > 0) throw invalid(`answers: answer every question (missing ${missing.map((q) => q.id).join(', ')})`);
      const before = Array.isArray(row.answers) ? (row.answers as unknown[]) : [];
      const answers = [...before, ...questions.map((q) => ({ questionId: q.id, requirementId: q.requirementId, question: q.question, answer: given.get(q.id) as string }))];
      const history = [...(Array.isArray(row.history) ? (row.history as unknown[]) : []), { role: 'user', content: answersMessage(questions, body.answers) }];
      const updated = (
        await tx.query<SessionRow>(
          `UPDATE app.setup_sessions SET status = 'working', questions = '[]'::jsonb, answers = $2::jsonb, history = $3::jsonb, updated_at = now()
            WHERE id = $1::uuid RETURNING ${SESSION_COLUMNS}`,
          [row.id, JSON.stringify(answers), JSON.stringify(history)],
        )
      ).rows[0] as SessionRow;
      await enqueueSetup(ctx, tx, team.workspace_id, row.id, row.rounds);
      return json(SetupSessionResponse.parse({ session: toSession(updated) }));
    }),
  });

  ctx.http.route({
    method: cancelSetupRoute.method,
    path: cancelSetupRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: CancelSetupRequest, response: SetupSessionResponse },
    handler: route(async (req, tx) => {
      const { slug, sessionId } = SetupSessionParams.parse(req.params);
      CancelSetupRequest.parse(req.body ?? {});
      const team = await requireTeam(tx, slug);
      const row = await ownSession(tx, team, sessionId, true);
      if (row.status !== 'working' && row.status !== 'asking') return json(SetupSessionResponse.parse({ session: toSession(row) }));
      const updated = (
        await tx.query<SessionRow>(`UPDATE app.setup_sessions SET status = 'cancelled', questions = '[]'::jsonb, updated_at = now() WHERE id = $1::uuid RETURNING ${SESSION_COLUMNS}`, [row.id])
      ).rows[0] as SessionRow;
      return json(SetupSessionResponse.parse({ session: toSession(updated) }));
    }),
  });
}
