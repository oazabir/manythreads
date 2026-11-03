import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  memoryInboxMigrationSource,
  memoryShareMigrationSource,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MISSING_ACCEPT_SQL } from '../../src/accept.ts';

// P8-24 (cross-team consent): the receiving team decides. The accept row is filed to the DESTINATION team, only its leads (and workspace owners and admins) can decide it, the
// person who wrote the share never can, a decision moves the link, and the team can later pause, resume or end it. Nobody on the sending side, and nobody in a third team,
// can move a link or read the incoming view of a team they cannot read.
//
// Cast: ENG (omar, owner and admin, leads it; nadia and rafi members) shares with MARKETING (tariq leads it; no workspace role). SUPPORT has only sameera.

const { omar, nadia, rafi, sameera, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const SUPPORT = TEAM_IDS['Customer support'];
const MARKETING = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
let counter = 2000;

/** A share of `from` with a link to `to` in `state`, as the loader leaves them. */
async function seedLink(from: string, to: string, state = 'requested', shareStatus = 'active'): Promise<{ shareId: string; linkId: string }> {
  counter += 1;
  return sys(async (tx) => {
    const dest = (await tx.query<{ slug: string; name: string }>('SELECT slug, name FROM app.teams WHERE id = $1', [to])).rows[0]!;
    const share = await tx.query<{ id: string }>(`INSERT INTO app.memory_shares (workspace_id, team_id, slug, name, status, definition, defined_by) VALUES ($1, $2, $3, 'Release notes', $4, '{"approval":"review"}'::jsonb, $5) RETURNING id`, [
      omar.workspaceId,
      from,
      `accept-${counter}`,
      shareStatus,
      omar.actorId,
    ]);
    const shareId = share.rows[0]!.id;
    const link = await tx.query<{ id: string }>(
      `INSERT INTO app.memory_share_links (workspace_id, team_id, share_id, dest_team_id, dest_slug, dest_name, state, accepted_at) VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 IN ('accepted', 'paused') THEN now() END) RETURNING id`,
      [omar.workspaceId, from, shareId, to, dest.slug, dest.name, state],
    );
    return { shareId, linkId: link.rows[0]!.id };
  });
}

const ask = (linkId: string, requester: Persona = omar): Promise<string> => sys(async (tx) => (await tx.query<{ id: string }>('SELECT app.memory_share_request_accept($1::uuid, $2::uuid) AS id', [linkId, requester.actorId])).rows[0]!.id);
const approval = (id: string): Promise<Record<string, unknown>> =>
  sys(async (tx) => (await tx.query('SELECT team_id, source, tool, status, outcome, summary, resume, approver_scope, requester_id, bot_id, args_preview FROM app.approvals WHERE id = $1', [id])).rows[0] as Record<string, unknown>);
const decide = (p: Persona, id: string, decision: 'approved' | 'denied'): Promise<unknown> => as(p, (tx) => tx.query('SELECT app.approvals_decide($1, $2, $3)', [id, decision, 'ok']));
const settle = (id: string, decision: string): Promise<Array<Record<string, unknown>>> => sys(async (tx) => (await tx.query('SELECT * FROM app.memory_share_settle_accept($1::uuid, $2)', [id, decision])).rows as Array<Record<string, unknown>>);
const linkOf = (id: string): Promise<{ state: string; ended_reason: string | null; accepted_by: string | null; approval_id: string | null }> =>
  sys(async (tx) => (await tx.query<{ state: string; ended_reason: string | null; accepted_by: string | null; approval_id: string | null }>('SELECT state, ended_reason, accepted_by, approval_id FROM app.memory_share_links WHERE id = $1', [id])).rows[0]!);
const act = (p: Persona, linkId: string, dest: string, action: string): Promise<Array<Record<string, unknown>>> =>
  as(p, async (tx) => (await tx.query('SELECT * FROM app.memory_share_link_act($1::uuid, $2::uuid, $3)', [linkId, dest, action])).rows as Array<Record<string, unknown>>);
const incoming = (p: Persona, dest: string): Promise<Array<Record<string, unknown>>> => as(p, async (tx) => (await tx.query('SELECT * FROM app.memory_share_incoming($1::uuid)', [dest])).rows as Array<Record<string, unknown>>);

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, approvalsMigrationSource, memoryInboxMigrationSource, memoryShareMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('asking the receiving team to accept', () => {
  it('files an Approvals row to the DESTINATION team (source grant, tool memory.share.accept, leads decide) and only the platform can', async () => {
    const { linkId } = await seedLink(ENG, MARKETING);
    expect(await code(as(omar, (tx) => tx.query('SELECT app.memory_share_request_accept($1::uuid, $2::uuid)', [linkId, omar.actorId])))).toBe('42501');
    expect(await code(as(tariq, (tx) => tx.query('SELECT app.memory_share_request_accept($1::uuid, $2::uuid)', [linkId, tariq.actorId])))).toBe('42501');
    const id = await ask(linkId);
    const row = await approval(id);
    expect(row).toMatchObject({ team_id: MARKETING, source: 'grant', tool: 'memory.share.accept', status: 'pending', outcome: 'none', requester_id: omar.actorId, bot_id: null });
    expect(row['approver_scope']).toEqual({ roles: [], people: [], leads: true });
    expect(row['resume']).toMatchObject({ kind: 'handoff', payload: { op: 'memory_share_accept', linkId } });
    expect(String(row['summary'])).toContain('Release notes');
    expect((await linkOf(linkId)).approval_id).toBe(id);
    // asking again while the row is open is the same row
    expect(await ask(linkId)).toBe(id);
  });

  it('refuses a link that is not waiting, a share that is not active, and a requester from nowhere', async () => {
    const accepted = await seedLink(ENG, MARKETING, 'accepted');
    expect(await code(ask(accepted.linkId))).toBe('55000');
    const removed = await seedLink(ENG, MARKETING, 'requested', 'removed');
    expect(await code(ask(removed.linkId))).toBe('55000');
    const { linkId } = await seedLink(ENG, MARKETING);
    expect(await code(sys((tx) => tx.query('SELECT app.memory_share_request_accept($1::uuid, $2::uuid)', [linkId, '00000000-0000-7000-8000-00000000dead'])))).toBe('23503');
  });

  it('is seen and decided by the destination’s lead; the person who wrote the share, a member of the destination’s sender and a third team cannot decide it', async () => {
    const { linkId } = await seedLink(ENG, MARKETING);
    const id = await ask(linkId, omar);
    const sees = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.approvals WHERE id = $1', [id])).rowCount ?? 0);
    expect(await sees(tariq)).toBe(1);
    expect(await sees(nadia)).toBe(0);
    expect(await sees(sameera)).toBe(0);
    expect(await sees(lena)).toBe(0);
    expect(await code(decide(omar, id, 'approved'))).toBe('42501'); // the requester can never decide their own row
    expect(await code(decide(nadia, id, 'approved'))).toBe('42501');
    expect(await code(decide(rafi, id, 'approved'))).toBe('42501');
    expect(await code(decide(sameera, id, 'approved'))).toBe('42501');
    expect(await code(decide(lena, id, 'approved'))).toBe('42501');
    expect((await approval(id))['status']).toBe('pending');
    expect((await linkOf(linkId)).state).toBe('requested');
  });
});

describe('the tick asks again for a waiting link with no open request', () => {
  const missing = (): Promise<string[]> => sys(async (tx) => (await tx.query<{ id: string }>(MISSING_ACCEPT_SQL)).rows.map((r) => r.id));

  it('a link with no request, or whose request expired unanswered, is asked again; one with an open or a decided request is not', async () => {
    const none = await seedLink(ENG, MARKETING);
    const open = await seedLink(ENG, MARKETING);
    await ask(open.linkId);
    const expired = await seedLink(ENG, MARKETING);
    const expiredId = await ask(expired.linkId);
    await sys((tx) => tx.query(`UPDATE app.approvals SET status = 'expired', decided_at = now() WHERE id = $1`, [expiredId]));
    const lapsed = await seedLink(ENG, MARKETING);
    const lapsedId = await ask(lapsed.linkId);
    // still marked pending, but past its time (the sweep has not run yet): it is not an open request either
    await sys((tx) => tx.query(`UPDATE app.approvals SET expires_at = now() - interval '1 minute' WHERE id = $1`, [lapsedId]));
    const decided = await seedLink(ENG, MARKETING);
    const decidedId = await ask(decided.linkId);
    await decide(tariq, decidedId, 'approved'); // the subscriber has not moved the link yet: do not file a second row
    const found = await missing();
    expect(found).toEqual(expect.arrayContaining([none.linkId, expired.linkId, lapsed.linkId]));
    expect(found).not.toContain(open.linkId);
    expect(found).not.toContain(decided.linkId);
    // asking again for the expired one files a fresh row and the link points at it
    const fresh = await ask(expired.linkId);
    expect(fresh).not.toBe(expiredId);
    expect((await linkOf(expired.linkId)).approval_id).toBe(fresh);
    expect(await missing()).not.toContain(expired.linkId);
  });
});

describe('a decision moves the link', () => {
  it('approved: the link is accepted, by the person who decided, and the approval is finished', async () => {
    const { linkId } = await seedLink(ENG, MARKETING);
    const id = await ask(linkId);
    await decide(tariq, id, 'approved');
    // not before the platform settles it, and only the platform can
    expect((await linkOf(linkId)).state).toBe('requested');
    expect(await code(as(tariq, (tx) => tx.query('SELECT * FROM app.memory_share_settle_accept($1::uuid, $2)', [id, 'approved'])))).toBe('42501');
    expect(await settle(id, 'denied')).toEqual([]); // not what was decided
    const moved = await settle(id, 'approved');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ o_link_id: linkId, o_team_id: ENG, o_dest_team_id: MARKETING, o_to: 'accepted', o_ended: null, o_decider: tariq.actorId });
    expect(await linkOf(linkId)).toMatchObject({ state: 'accepted', ended_reason: null, accepted_by: tariq.actorId });
    expect(await approval(id)).toMatchObject({ status: 'approved', outcome: 'ran' });
    expect(await settle(id, 'approved')).toEqual([]); // once only
  });

  it('denied: the link ends, by the team, and naming the team again does not reopen it, only a new share asks again', async () => {
    const { linkId } = await seedLink(ENG, MARKETING);
    const id = await ask(linkId);
    await decide(tariq, id, 'denied');
    const moved = await settle(id, 'denied');
    expect(moved[0]).toMatchObject({ o_to: 'revoked', o_ended: 'by_team' });
    expect(await linkOf(linkId)).toMatchObject({ state: 'revoked', ended_reason: 'by_team' });
    expect(await code(ask(linkId))).toBe('55000');
  });

  it('a workspace admin who leads another team can decide an accept row for any team', async () => {
    const { linkId } = await seedLink(MARKETING, SUPPORT);
    const id = await ask(linkId, tariq);
    await decide(omar, id, 'approved');
    expect((await settle(id, 'approved'))[0]).toMatchObject({ o_to: 'accepted', o_decider: omar.actorId });
  });

  it('an approval that is not an accept row, or a link that already moved on, settles nothing', async () => {
    const { linkId } = await seedLink(ENG, MARKETING);
    const id = await ask(linkId);
    await decide(tariq, id, 'approved');
    // the sending file dropped the team and the link ended before the decision was applied
    await sys((tx) => tx.query(`UPDATE app.memory_share_links SET state = 'revoked', ended_reason = 'removed' WHERE id = $1`, [linkId]));
    expect(await settle(id, 'approved')).toEqual([]);
    expect((await linkOf(linkId)).state).toBe('revoked');
    expect(await settle('00000000-0000-7000-8000-00000000f00d', 'approved')).toEqual([]);
  });
});

describe('pause, resume, end: only the receiving team’s leads', () => {
  it('a lead of the receiving team pauses, resumes and ends the link', async () => {
    const { linkId } = await seedLink(ENG, MARKETING, 'accepted');
    expect((await act(tariq, linkId, MARKETING, 'pause'))[0]).toMatchObject({ o_from: 'accepted', o_to: 'paused', o_actor: tariq.actorId });
    expect((await linkOf(linkId)).state).toBe('paused');
    expect((await act(tariq, linkId, MARKETING, 'resume'))[0]).toMatchObject({ o_from: 'paused', o_to: 'accepted' });
    expect((await act(tariq, linkId, MARKETING, 'revoke'))[0]).toMatchObject({ o_to: 'revoked', o_ended: 'by_team' });
    expect(await linkOf(linkId)).toMatchObject({ state: 'revoked', ended_reason: 'by_team' });
  });

  it('refuses the sending team, a member of the receiving team, a third team and a guest (42501), and moves nothing', async () => {
    const { linkId } = await seedLink(ENG, MARKETING, 'accepted');
    // nadia and rafi are members of the SENDING team; sameera of a third team; the sending lead omar is an admin (below) so he is not part of this list
    for (const p of [nadia, rafi, sameera, lena]) {
      for (const action of ['pause', 'revoke']) expect(await code(act(p, linkId, MARKETING, action)), `${p.key} ${action}`).toBe('42501');
    }
    expect((await linkOf(linkId)).state).toBe('accepted');
  });

  it('a lead of the SENDING team who is not an admin cannot pause or end the link from the sending side', async () => {
    const { linkId } = await seedLink(MARKETING, ENG, 'accepted'); // tariq sends, omar (admin) receives
    // tariq addresses the link by its real destination: he does not manage ENG
    expect(await code(act(tariq, linkId, ENG, 'pause'))).toBe('42501');
    // and cannot pose as the destination by naming his own team: the link is not that team's
    expect(await code(act(tariq, linkId, MARKETING, 'pause'))).toBe('P0002');
    expect((await linkOf(linkId)).state).toBe('accepted');
  });

  it('a link addressed through the wrong team is not found, even for an admin who manages both', async () => {
    const { linkId } = await seedLink(ENG, MARKETING, 'accepted');
    expect(await code(act(omar, linkId, SUPPORT, 'pause'))).toBe('P0002');
    expect(await code(act(omar, '00000000-0000-7000-8000-00000000f00d', MARKETING, 'pause'))).toBe('P0002');
  });

  it('only the right moves: a requested link cannot be paused, a revoked one cannot be resumed, and an unknown action is refused', async () => {
    const waiting = await seedLink(ENG, MARKETING, 'requested');
    expect(await code(act(tariq, waiting.linkId, MARKETING, 'pause'))).toBe('55000');
    expect(await code(act(tariq, waiting.linkId, MARKETING, 'resume'))).toBe('55000');
    const accepted = await seedLink(ENG, MARKETING, 'accepted');
    expect(await code(act(tariq, accepted.linkId, MARKETING, 'resume'))).toBe('55000');
    expect(await code(act(tariq, accepted.linkId, MARKETING, 'delete'))).toBe('22023');
    await act(tariq, accepted.linkId, MARKETING, 'revoke');
    expect(await code(act(tariq, accepted.linkId, MARKETING, 'resume'))).toBe('55000');
    expect(await code(act(tariq, accepted.linkId, MARKETING, 'revoke'))).toBe('55000');
    // a waiting link can be turned down without the Approvals row
    expect((await act(tariq, waiting.linkId, MARKETING, 'revoke'))[0]).toMatchObject({ o_to: 'revoked', o_ended: 'by_team' });
  });

  it('the request role cannot change a link by hand', async () => {
    const { linkId } = await seedLink(ENG, MARKETING, 'accepted');
    const denied = await code(as(tariq, (tx) => tx.query(`UPDATE app.memory_share_links SET state = 'paused' WHERE id = $1`, [linkId])));
    expect(denied).toBe('42501');
    expect((await linkOf(linkId)).state).toBe('accepted');
  });
});

describe('the incoming view', () => {
  it('shows the receiving team’s people what other teams send them, and shows nothing to anyone who cannot read that team', async () => {
    const { linkId } = await seedLink(ENG, MARKETING, 'accepted');
    const mine = await incoming(tariq, MARKETING);
    expect(mine.map((r) => r['o_link_id'])).toContain(linkId);
    expect(mine.find((r) => r['o_link_id'] === linkId)).toMatchObject({ o_from_team_id: ENG, o_state: 'accepted', o_share_name: 'Release notes', o_deliveries: 0 });
    for (const p of [sameera, lena]) expect(await incoming(p, MARKETING), p.key).toEqual([]);
    // the sending team's people do not see the receiving team's side
    expect((await incoming(rafi, MARKETING)).map((r) => r['o_link_id'])).not.toContain(linkId);
  });

  it('leaves out a share its sender removed', async () => {
    const { linkId, shareId } = await seedLink(ENG, MARKETING, 'accepted');
    await sys((tx) => tx.query(`UPDATE app.memory_shares SET status = 'removed' WHERE id = $1`, [shareId]));
    expect((await incoming(tariq, MARKETING)).map((r) => r['o_link_id'])).not.toContain(linkId);
  });
});
