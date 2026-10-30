import { json, requireTeam, route, type PluginContext } from '@manythreads/sdk';
import {
  CreateProposalRequest,
  DecideProposalRequest,
  ListProposalsQuery,
  ListProposalsResponse,
  ProposalParams,
  ProposalResponse,
  TeamProposalParams,
  approveProposalRoute,
  createProposalRoute,
  getProposalRoute,
  listProposalsRoute,
  rejectProposalRoute,
  withdrawProposalRoute,
} from '@manythreads/shared';
import { PROPOSAL_COLUMNS, toProposal, type ProposalRow } from './rows.ts';
import { applyProposal, closeProposal, createProposal, detailOf, requireProposal } from './service.ts';

// HTTP for proposals. Who may do what is decided in the database (migration 0001) and by the repo writer; the routes pass the caller's transaction through.

const WRITE_LIMIT = { limit: 60, windowMs: 60_000 } as const;
const READ_LIMIT = { limit: 600, windowMs: 60_000 } as const;

export function registerProposalRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: listProposalsRoute.method,
    path: listProposalsRoute.path,
    rateLimit: READ_LIMIT,
    schema: { query: ListProposalsQuery, response: ListProposalsResponse },
    handler: route(async (req, tx) => {
      const { slug } = TeamProposalParams.parse(req.params);
      const q = ListProposalsQuery.parse(req.query);
      const team = await requireTeam(tx, slug);
      const where = ['p.team_id = $1::uuid'];
      const args: unknown[] = [team.id];
      if (q.status) where.push(`p.status = $${args.push(q.status)}`);
      if (q.path) where.push(`p.path = $${args.push(q.path)}`);
      // open ones first (the ones that wait), then the newest decisions
      const rows = (
        await tx.query<ProposalRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM app.proposals p WHERE ${where.join(' AND ')} ORDER BY (p.status = 'open') DESC, coalesce(p.decided_at, p.created_at) DESC, p.id DESC LIMIT $${args.push(q.limit)}`,
          args,
        )
      ).rows;
      const open = (await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.proposals WHERE team_id = $1::uuid AND status = 'open'", [team.id])).rows[0]?.n ?? '0';
      return json(ListProposalsResponse.parse({ proposals: rows.map(toProposal), openCount: Number(open) }));
    }),
  });

  ctx.http.route({
    method: createProposalRoute.method,
    path: createProposalRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: CreateProposalRequest, response: ProposalResponse },
    handler: route(async (req, tx) => {
      const { slug } = TeamProposalParams.parse(req.params);
      const body = CreateProposalRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      return json(ProposalResponse.parse({ proposal: await createProposal(ctx, tx, team, body) }), 201);
    }),
  });

  ctx.http.route({
    method: getProposalRoute.method,
    path: getProposalRoute.path,
    rateLimit: READ_LIMIT,
    schema: { response: ProposalResponse },
    handler: route(async (req, tx) => {
      const { slug, proposalId } = ProposalParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const row = await requireProposal(tx, proposalId, team);
      return json(ProposalResponse.parse({ proposal: await detailOf(ctx, tx, row) }));
    }),
  });

  ctx.http.route({
    method: approveProposalRoute.method,
    path: approveProposalRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: DecideProposalRequest, response: ProposalResponse },
    handler: route(async (req, tx) => {
      const { slug, proposalId } = ProposalParams.parse(req.params);
      const body = DecideProposalRequest.parse(req.body ?? {});
      const team = await requireTeam(tx, slug);
      const row = await requireProposal(tx, proposalId, team);
      return json(ProposalResponse.parse({ proposal: await applyProposal(ctx, tx, row, { self: false, ...(body.note ? { note: body.note } : {}) }) }));
    }),
  });

  ctx.http.route({
    method: rejectProposalRoute.method,
    path: rejectProposalRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: DecideProposalRequest, response: ProposalResponse },
    handler: route(async (req, tx) => {
      const { slug, proposalId } = ProposalParams.parse(req.params);
      const body = DecideProposalRequest.parse(req.body ?? {});
      const team = await requireTeam(tx, slug);
      const row = await requireProposal(tx, proposalId, team);
      return json(ProposalResponse.parse({ proposal: await closeProposal(ctx, tx, row, { reason: 'rejected', ...(body.note ? { note: body.note } : {}) }) }));
    }),
  });

  ctx.http.route({
    method: withdrawProposalRoute.method,
    path: withdrawProposalRoute.path,
    rateLimit: WRITE_LIMIT,
    schema: { body: DecideProposalRequest, response: ProposalResponse },
    handler: route(async (req, tx) => {
      const { slug, proposalId } = ProposalParams.parse(req.params);
      const body = DecideProposalRequest.parse(req.body ?? {});
      const team = await requireTeam(tx, slug);
      const row = await requireProposal(tx, proposalId, team);
      return json(ProposalResponse.parse({ proposal: await closeProposal(ctx, tx, row, { reason: 'withdrawn', ...(body.note ? { note: body.note } : {}) }) }));
    }),
  });
}
