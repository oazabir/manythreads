import { conflict, forbidden, json, notFound, requireTeam, route, type PluginContext, type PluginTx, type TeamRow } from '@manythreads/sdk';
import {
  OpenTerminalRequest,
  TerminalBotParams,
  TerminalParams,
  TerminalRecordingResponse,
  TerminalSessionResponse,
  TerminalStatusResponse,
  EndTerminalRequest,
  endTerminalRoute,
  getTerminalRoute,
  openTerminalRoute,
  terminalSocketRoute,
  terminalStatusRoute,
} from '@manythreads/shared';
import { limitsOf } from './config.ts';
import { TerminalService } from './service.ts';
import type { PtyStarter } from './pty.ts';

// The terminal's routes (PLAN P7-09). EVERY one is for a workspace owner or admin and answers 403 to anyone else: the check is the first thing each route does, before it looks at the team, the
// bot or the terminal, so a person who is not an admin learns nothing about any of them. The socket's check runs in the route's `guard`, so a refusal is a real HTTP 403 on the upgrade request
// and no socket is ever opened for it.

const WRITE_LIMIT = { limit: 20, windowMs: 60_000 } as const;
const READ_LIMIT = { limit: 300, windowMs: 60_000 } as const;
const SOCKET_LIMIT = { limit: 30, windowMs: 60_000 } as const;

async function requireAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can use the terminal');
}

type Target = { team: TeamRow; bot: { id: string; slug: string } };

async function targetOf(tx: PluginTx, slug: string, botSlug: string): Promise<Target> {
  const team = await requireTeam(tx, slug);
  const bot = (await tx.query<{ id: string; slug: string }>('SELECT id, slug FROM app.bots WHERE team_id = $1::uuid AND slug = $2', [team.id, botSlug])).rows[0];
  if (!bot) throw notFound('No such bot');
  return { team, bot };
}

export function registerTerminalRoutes(ctx: PluginContext, starter?: PtyStarter): TerminalService {
  const service = new TerminalService(ctx, starter);

  ctx.http.route({
    method: terminalStatusRoute.method,
    path: terminalStatusRoute.path,
    rateLimit: READ_LIMIT,
    schema: { response: TerminalStatusResponse },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { slug, botSlug } = TerminalBotParams.parse(req.params);
      const { bot } = await targetOf(tx, slug, botSlug);
      const state = await service.availability(tx.actor.workspaceId);
      return json({ available: state.available, reason: state.reason, limits: limitsOf(service.config()), sessions: await service.recent(tx, bot.id) });
    }),
  });

  ctx.http.route({
    method: openTerminalRoute.method,
    path: openTerminalRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: OpenTerminalRequest, response: TerminalSessionResponse },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { slug, botSlug } = TerminalBotParams.parse(req.params);
      const body = OpenTerminalRequest.parse(req.body);
      const { team, bot } = await targetOf(tx, slug, botSlug);
      if (team.archived_at) throw conflict('This team is archived');
      if (!req.caller) throw forbidden('Sign in first');
      const row = await service.request(req.caller, { teamId: team.id, botId: bot.id, botSlug: bot.slug }, body.runId);
      return json({ session: service.mapSession(row) }, 201);
    }),
  });

  ctx.http.route({
    method: getTerminalRoute.method,
    path: getTerminalRoute.path,
    rateLimit: READ_LIMIT,
    schema: { response: TerminalRecordingResponse },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { slug, botSlug, terminalId } = TerminalParams.parse(req.params);
      const { bot } = await targetOf(tx, slug, botSlug);
      const row = await service.find(tx, bot.id, terminalId);
      if (!row) throw notFound('No such terminal');
      return json({ session: service.mapRecording(row) });
    }),
  });

  ctx.http.route({
    method: endTerminalRoute.method,
    path: endTerminalRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: EndTerminalRequest, response: TerminalSessionResponse },
    handler: route(async (req, tx) => {
      await requireAdmin(tx);
      const { slug, botSlug, terminalId } = TerminalParams.parse(req.params);
      EndTerminalRequest.parse(req.body);
      const { bot } = await targetOf(tx, slug, botSlug);
      const row = await service.find(tx, bot.id, terminalId);
      if (!row) throw notFound('No such terminal');
      await service.endByAdmin(row.workspace_id, row);
      // read the result as the system: the caller's transaction began before the end was written
      const after = await ctx.db.system((inner) => service.find(inner, bot.id, terminalId), { workspaceId: row.workspace_id });
      return json({ session: service.mapSession(after ?? row) });
    }),
  });

  ctx.http.route({
    method: terminalSocketRoute.method,
    path: terminalSocketRoute.path,
    rateLimit: SOCKET_LIMIT,
    // Before the upgrade, as the caller: an admin, and a terminal that this admin asked for and that is still waiting for its connection.
    async guard(req, tx) {
      await requireAdmin(tx);
      const { slug, botSlug, terminalId } = TerminalParams.parse(req.params);
      const { bot } = await targetOf(tx, slug, botSlug);
      const row = await service.find(tx, bot.id, terminalId);
      if (!row || row.admin_id !== req.caller?.actorId) throw notFound('No such terminal');
      if (row.status !== 'waiting') throw conflict('This terminal is already open or has ended');
    },
    ws: async (socket, req) => {
      const caller = req.caller;
      if (!caller || caller.kind !== 'person') {
        socket.close(1008, 'sign in to use the terminal');
        return;
      }
      const parsed = TerminalParams.safeParse(req.params);
      if (!parsed.success) {
        socket.close(1008, 'not a terminal');
        return;
      }
      await service.connect(caller, { terminalId: parsed.data.terminalId, botSlug: parsed.data.botSlug }, socket);
    },
  });

  return service;
}
