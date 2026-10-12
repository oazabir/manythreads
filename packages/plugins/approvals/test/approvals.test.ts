import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool, withActor } from '@manythreads/kernel';
import { NoEligibleApproverError, requestToolApproval, type ApprovalProvider, type BotRunHandle, type PluginRuns, type PluginTx } from '@manythreads/sdk';
import { Approval, GetApprovalArgsResponse, ListApprovalsResponse, ListThreadApprovalsResponse, GetApprovalsSummaryResponse, previewArgsDetailed } from '@manythreads/shared';
import { personaActor, type Persona } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// The approvals plugin against a real database and the real server (PLAN P5-20): the one handler files a pending approval for a run, the
// inbox lists it with the answer to "may I decide this?", the requester never can, the approver scope decides who can, a decision is final,
// and approving a tool call re-runs it once, as the bot. The unit-level shape of the pieces is in the rls and events suites.

const { omar, nadia, rafi, priya, sameera } = personas;
vi.setConfig({ testTimeout: 180_000 });

let w: RepoWorld;
let appPool: pg.Pool;
let systemPool: pg.Pool;
let runs: PluginRuns;
let provider: ApprovalProvider;
let channelId = '';
let rootId = '';
let scoped: { botId: string; actorId: string }; // approvers: role:on-call
let leadsOnly: { botId: string; actorId: string }; // no approvers named

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const botMd = (name: string, approvers: string[]): string =>
  [
    '---',
    'schema: 1',
    `name: ${name}`,
    'role: Asks before it writes',
    'kind: automation',
    'runtime: rules',
    'triggers:',
    '  - type: mention',
    'capabilities:',
    '  native: [pages.write]',
    'approvals:',
    '  needsApproval: [pages.write]',
    ...(approvers.length > 0 ? [`  approvers: [${approvers.join(', ')}]`] : []),
    '---',
    '',
    `# ${name}`,
    '',
    'Prose.',
    '',
  ].join('\n');

async function loadBot(slug: string, md: string): Promise<{ botId: string; actorId: string }> {
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: md }], `Add ${slug}`);
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  const botId = await until(
    () =>
      w.system(async (tx) => {
        const r = await tx.query<{ id: string }>(`SELECT b.id FROM app.bots b WHERE b.team_id = $1 AND b.slug = $2 AND b.status = 'active'`, [TEAM_IDS.Engineering, slug]);
        return r.rows[0]?.id ?? null;
      }),
    20_000,
    `the loader to load ${slug}`,
  );
  const actorId = await until(
    () => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId])).rows[0]?.id ?? null),
    5_000,
    `the actor of ${slug}`,
  );
  return { botId, actorId };
}

/** A run of a bot asked by a person (or nobody), answering in #dev under `rootId`. */
async function openRun(bot: { botId: string }, asker: { actorId: string } | null, where: { channelId?: string; replyRootId?: string } = {}): Promise<BotRunHandle> {
  const { run } = await runs.open({
    botId: bot.botId,
    teamId: TEAM_IDS.Engineering,
    workspaceId: omar.workspaceId,
    trigger: 'mention',
    askerActorId: asker?.actorId ?? null,
    channelId: where.channelId ?? channelId,
    replyRootId: where.replyRootId ?? rootId,
  });
  return run;
}

const PAGE = (path: string, content = 'written after approval', extra: Record<string, unknown> = {}) => ({ team: TEAM_IDS.Engineering, mode: 'create', path, content, ...extra });

/** File a grant-source approval for a `pages.write` call, the way the MCP gateway does: in the run's own transaction, as its bot. */
function request(run: BotRunHandle, path: string, extra: { dedupeKey?: string; content?: string; args?: Record<string, unknown> } = {}) {
  const args = extra.args ?? PAGE(path, extra.content);
  const { preview, truncated } = previewArgsDetailed(args);
  return runs.asBot(run, (tx) =>
    provider.request(tx, {
      runId: run.runId,
      source: 'grant',
      tool: 'pages.write',
      summary: `pages.write · ${path}`,
      argsPreview: preview,
      argsTruncated: truncated,
      resume: { kind: 'tool', capability: 'pages.write', args, trigger: 'mention' },
      ...(extra.dedupeKey ? { dedupeKey: extra.dedupeKey } : {}),
    }),
  );
}

const rowOf = (id: string) =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ status: string; outcome: string; outcome_detail: string; source: string; requester_id: string; approver_scope: { roles: string[]; people: string[]; leads: boolean }; resume: { kind: string } }>(
          'SELECT status, outcome, outcome_detail, source, requester_id, approver_scope, resume FROM app.approvals WHERE id = $1',
          [id],
        )
      ).rows[0],
  );

const list = async (who: Persona, status: 'pending' | 'decided' = 'pending') => {
  const res = await w.call(who, 'GET', `/api/teams/engineering/approvals?status=${status}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListApprovalsResponse.parse(res.body);
};
const decide = (who: Persona, id: string, verb: 'approve' | 'deny', note = '') => w.call(who, 'POST', `/api/teams/engineering/approvals/${id}/${verb}`, { note });

const eventsOf = (type: string): Promise<Array<Record<string, unknown>>> =>
  w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));

beforeAll(async () => {
  w = await createRepoWorld();
  appPool = createAppPool(w.server.db.appUrl, 4);
  systemPool = createSystemPool(w.server.db.systemUrl, 2);
  const registry = new CapabilityRegistry();
  const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) });
  runs = createRunService({ pool: appPool, systemPool, registry, broker, handlers: new Map() });
  provider = w.server.host.registries.providers.approvals.values()[0] as ApprovalProvider;
  expect(provider, 'the approvals plugin registers its provider').toBeDefined();

  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  channelId = await w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT c.id FROM app.channels c WHERE c.team_id = $1 AND c.name = 'dev'`, [TEAM_IDS.Engineering])).rows[0]!.id);
  const posted = await w.call(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'Please publish the weekly page.', threadRootId: null });
  expect(posted.status).toBe(201);
  rootId = (posted.body as { id: string }).id;

  scoped = await loadBot('page-writer', botMd('PageWriter', ['role:on-call']));
  leadsOnly = await loadBot('page-writer-leads', botMd('PageWriterLeads', []));
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await systemPool?.end();
  await w?.close();
});

describe('the one handler', () => {
  it('files a pending approval for the run, from the run\'s own bot, with the asker as requester and the thread it answers in', async () => {
    // the loader projected BOT.md's approvers onto the row the handler reads
    expect(await w.system(async (tx) => (await tx.query<{ approvers: string[] }>('SELECT approvers FROM app.bots WHERE id = $1', [scoped.botId])).rows[0]?.approvers)).toEqual(['role:on-call']);

    const run = await openRun(scoped, nadia);
    const filed = await request(run, 'pages/first.md');
    expect(filed.created).toBe(true);

    const row = await rowOf(filed.approvalId);
    expect(row).toMatchObject({ status: 'pending', outcome: 'none', source: 'grant', requester_id: nadia.actorId });
    expect(row?.approver_scope).toEqual({ roles: ['role:on-call'], people: [], leads: false });
    expect(row?.resume).toMatchObject({ kind: 'tool', capability: 'pages.write', trigger: 'mention' });

    // the thread it answers in is read from the run, and the event says an approval was requested (ids and the tool name, no arguments)
    const where = await w.system(async (tx) => (await tx.query<{ channel_id: string; thread_root_id: string; bot_id: string; run_id: string }>('SELECT channel_id, thread_root_id, bot_id, run_id FROM app.approvals WHERE id = $1', [filed.approvalId])).rows[0]);
    expect(where).toEqual({ channel_id: channelId, thread_root_id: rootId, bot_id: scoped.botId, run_id: run.runId });
    const requested = (await eventsOf('approvals.approval.requested')).find((e) => e['approvalId'] === filed.approvalId);
    expect(requested).toMatchObject({ source: 'grant', tool: 'pages.write', botId: scoped.botId, requesterId: nadia.actorId, runId: run.runId });
    expect(JSON.stringify(requested)).not.toContain('written after approval');
  });

  it('a run nobody asked is requested by the bot itself', async () => {
    const run = await openRun(scoped, null);
    const filed = await request(run, 'pages/nobody.md');
    expect((await rowOf(filed.approvalId))?.requester_id).toBe(scoped.actorId);
  });

  it('asking twice for the same pending thing is one approval', async () => {
    const run = await openRun(scoped, nadia);
    const first = await request(run, 'pages/dedupe.md', { dedupeKey: 'same-call' });
    const again = await request(await openRun(scoped, nadia), 'pages/dedupe.md', { dedupeKey: 'same-call' });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ approvalId: first.approvalId, created: false });
  });

  it('asking for the same call is one approval per asker: a second person gets a request of their own, which the first cannot be approved through', async () => {
    const byNadia = await request(await openRun(leadsOnly, nadia), 'pages/two-askers.md', { dedupeKey: 'identical-call' });
    const byOmar = await request(await openRun(leadsOnly, omar), 'pages/two-askers.md', { dedupeKey: 'identical-call' });
    expect(byOmar.created).toBe(true);
    expect(byOmar.approvalId).not.toBe(byNadia.approvalId);
    expect((await rowOf(byNadia.approvalId))?.requester_id).toBe(nadia.actorId);
    expect((await rowOf(byOmar.approvalId))?.requester_id).toBe(omar.actorId);
    // Omar leads the team and so decides Nadia's; he cannot decide his own, which the identical call would have been merged into
    expect((await decide(omar, byOmar.approvalId, 'approve')).status).toBe(403);
    expect((await decide(omar, byNadia.approvalId, 'deny')).status).toBe(200);
    // once Nadia's is settled the same asker may file the same call again, and it is a new approval (no stale NULL id, no conflict)
    const again = await request(await openRun(leadsOnly, nadia), 'pages/two-askers.md', { dedupeKey: 'identical-call' });
    expect(again.created).toBe(true);
    expect(again.approvalId).not.toBe(byNadia.approvalId);
  });

  it('refuses anyone but the run\'s own bot or the system: a person, another bot, a run that is not the transaction\'s', async () => {
    const run = await openRun(scoped, nadia);
    const input = {
      runId: run.runId,
      source: 'grant' as const,
      tool: 'pages.write',
      summary: 'pages.write · pages/forged.md',
      argsPreview: {},
      resume: { kind: 'tool' as const, capability: 'pages.write', args: PAGE('pages/forged.md'), trigger: 'mention' as const },
    };
    // a person, in a request transaction
    await expect(withActor(personaActor(nadia), (tx) => provider.request(tx as unknown as PluginTx, input), { pool: appPool })).rejects.toMatchObject({ code: '42501' });
    // another bot of the same team, with a run of its own: the run named is not its
    const other = await openRun(leadsOnly, nadia);
    await expect(runs.asBot(other, (tx) => provider.request(tx, input))).rejects.toMatchObject({ code: '42501' });
    // nothing was filed for either
    expect(await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.approvals WHERE summary = 'pages.write · pages/forged.md'")).rows[0]?.n)).toBe(0);
  });

  it('the row\'s real arguments are not readable by the request role, and the role cannot write the table', async () => {
    const run = await openRun(scoped, nadia);
    const filed = await request(run, 'pages/hidden.md');
    const read = (sql: string) =>
      withActor(personaActor(omar), (tx) => tx.query(sql, [filed.approvalId]), { pool: appPool }).then(
        () => undefined,
        (e: { code?: string }) => e.code,
      );
    expect(await read('SELECT resume FROM app.approvals WHERE id = $1')).toBe('42501');
    expect(await read('SELECT dedupe_key FROM app.approvals WHERE id = $1')).toBe('42501');
    expect(await read("UPDATE app.approvals SET status = 'approved' WHERE id = $1")).toBe('42501');
    expect(await read('DELETE FROM app.approvals WHERE id = $1')).toBe('42501');
  });
});

describe('who may decide', () => {
  let pending: string;
  beforeAll(async () => {
    pending = (await request(await openRun(scoped, nadia), 'pages/decide.md')).approvalId;
  });

  it('every team member sees it; only a holder of the named role tag may decide it; the requester never, even holding the tag', async () => {
    const asNadia = (await list(nadia)).items.find((a) => a.id === pending)!;
    expect(asNadia).toMatchObject({ canDecide: false, blockReason: 'requester', requesterName: 'Nadia', botName: 'PageWriter', source: 'grant' });
    const asRafi = (await list(rafi)).items.find((a) => a.id === pending)!;
    expect(asRafi).toMatchObject({ canDecide: true, blockReason: null });
    // a team lead and workspace admin is not a named approver: a scope that names a tag means the tag
    const asOmar = (await list(omar)).items.find((a) => a.id === pending)!;
    expect(asOmar).toMatchObject({ canDecide: false, blockReason: 'not_approver' });
    expect((await list(priya)).items.find((a) => a.id === pending)).toMatchObject({ canDecide: false, blockReason: 'not_approver' });
    // someone outside the team does not see it at all
    expect((await list(sameera).catch(() => ({ items: [] }))).items.find((a) => a.id === pending)).toBeUndefined();
    // the preview is what the approver sees; the secret-named key is hidden and the real arguments are nowhere in the answer
    expect(asRafi.argsPreview).toMatchObject({ path: 'pages/decide.md' });
    expect(asRafi).not.toHaveProperty('resume');
  });

  it('the requester gets 403 on approve and on deny, a non-approver gets 403, and nothing changes', async () => {
    for (const who of [nadia, omar, priya]) {
      for (const verb of ['approve', 'deny'] as const) {
        const res = await decide(who, pending, verb);
        expect(res.status, `${who.key} ${verb}: ${JSON.stringify(res.body)}`).toBe(403);
      }
    }
    expect((await rowOf(pending))?.status).toBe('pending');
    expect((await eventsOf('approvals.approval.decided')).filter((e) => e['approvalId'] === pending)).toEqual([]);
  });

  it('a team without the approvals of another team: a member of Customer support cannot decide or read it', async () => {
    const res = await w.call(sameera, 'POST', `/api/teams/engineering/approvals/${pending}/approve`, { note: '' });
    expect([403, 404]).toContain(res.status);
    expect((await rowOf(pending))?.status).toBe('pending');
  });

  it('the sidebar summary counts what waits and what the caller may decide', async () => {
    const asRafi = GetApprovalsSummaryResponse.parse((await w.call(rafi, 'GET', '/api/teams/engineering/approvals/summary')).body);
    const asNadia = GetApprovalsSummaryResponse.parse((await w.call(nadia, 'GET', '/api/teams/engineering/approvals/summary')).body);
    expect(asRafi.waiting).toBeGreaterThanOrEqual(1);
    expect(asRafi.mine).toBeGreaterThanOrEqual(1);
    expect(asNadia.waiting).toBe(asRafi.waiting);
    expect(asNadia.mine).toBeLessThan(asRafi.mine);
  });

  it('with no approver named, the team\'s leads and workspace admins decide, and others do not', async () => {
    const id = (await request(await openRun(leadsOnly, nadia), 'pages/leads.md')).approvalId;
    expect((await rowOf(id))?.approver_scope).toEqual({ roles: [], people: [], leads: true });
    expect((await list(omar)).items.find((a) => a.id === id)).toMatchObject({ canDecide: true });
    expect((await list(rafi)).items.find((a) => a.id === id)).toMatchObject({ canDecide: false, blockReason: 'not_approver' });
    expect((await list(nadia)).items.find((a) => a.id === id)).toMatchObject({ canDecide: false, blockReason: 'requester' });
    const denied = await decide(omar, id, 'deny', 'not this week');
    expect(denied.status, JSON.stringify(denied.body)).toBe(200);
  });

  it('shows the card in the thread the run answered in, to the team and to nobody else', async () => {
    const mine = ListThreadApprovalsResponse.parse((await w.call(rafi, 'GET', `/api/threads/${rootId}/approvals`)).body);
    expect(mine.items.map((a) => a.id)).toContain(pending);
    const theirs = await w.call(sameera, 'GET', `/api/threads/${rootId}/approvals`);
    expect(theirs.status).toBe(200);
    expect(ListThreadApprovalsResponse.parse(theirs.body).items).toEqual([]);
  });
});

describe('deciding', () => {
  it('approving re-runs the stopped call once, as the bot, and records what became of it; a second decision is refused', async () => {
    const id = (await request(await openRun(scoped, nadia), 'pages/approved.md')).approvalId;
    const res = await decide(rafi, id, 'approve', 'looks right');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const settled = Approval.parse((res.body as { approval: unknown }).approval);
    expect(settled).toMatchObject({ status: 'approved', canDecide: false, decision: { decision: 'approved', deciderName: 'Rafi', note: 'looks right' } });

    // the stored call ran, as the bot: the page exists and the commit's author is the bot's actor
    const done = await until(async () => {
      const row = await rowOf(id);
      return row?.outcome === 'ran' || row?.outcome === 'failed' ? row : null;
    }, 30_000, 'the approved call to run');
    expect(done, JSON.stringify(done)).toMatchObject({ outcome: 'ran' });
    const blob = await w.call(omar, 'GET', '/api/teams/engineering/repo/blob?path=pages/approved.md');
    expect(blob.status, JSON.stringify(blob.body)).toBe(200);
    expect((blob.body as { content: string }).content).toBe('written after approval');

    // exactly the events the contract lists, and a finished run for the re-run
    expect((await eventsOf('approvals.approval.decided')).filter((e) => e['approvalId'] === id)).toEqual([
      expect.objectContaining({ decision: 'approved', deciderId: rafi.actorId, requesterId: nadia.actorId, source: 'grant', tool: 'pages.write' }),
    ]);
    expect((await eventsOf('approvals.approval.resumed')).filter((e) => e['approvalId'] === id)).toEqual([expect.objectContaining({ outcome: 'ran' })]);

    // final: nobody decides it again, not even the same person the other way round
    expect((await decide(rafi, id, 'deny')).status).toBe(409);
    expect((await decide(rafi, id, 'approve')).status).toBe(409);
    // the page is written once: a later list shows it under Decided with the outcome
    const decided = (await list(nadia, 'decided')).items.find((a) => a.id === id)!;
    expect(decided).toMatchObject({ status: 'approved', outcome: 'ran' });
  });

  it('denying settles it without running anything', async () => {
    const id = (await request(await openRun(scoped, nadia), 'pages/denied.md')).approvalId;
    const res = await decide(rafi, id, 'deny', 'not now');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await rowOf(id))).toMatchObject({ status: 'denied', outcome: 'none' });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await w.call(omar, 'GET', '/api/teams/engineering/repo/blob?path=pages/denied.md')).status).toBe(404);
    expect((await eventsOf('approvals.approval.resumed')).filter((e) => e['approvalId'] === id)).toEqual([]);
  });

  it('an approved call the bot may no longer make ends failed, with the reason, and writes nothing', async () => {
    const id = (await request(await openRun(scoped, nadia), 'pages/revoked.md')).approvalId;
    // the grant is revoked between the request and the approval
    await w.system((tx) => tx.query("DELETE FROM app.capability_grants WHERE actor_id = $1 AND capability = 'pages.write'", [scoped.actorId]));
    expect((await decide(rafi, id, 'approve')).status).toBe(200);
    const done = await until(async () => {
      const row = await rowOf(id);
      return row?.outcome === 'ran' || row?.outcome === 'failed' ? row : null;
    }, 30_000, 'the approved call to settle');
    expect(done).toMatchObject({ status: 'approved', outcome: 'failed' });
    expect(done?.outcome_detail).toContain('no longer');
    expect((await w.call(omar, 'GET', '/api/teams/engineering/repo/blob?path=pages/revoked.md')).status).toBe(404);
  });

  it('two people deciding at once: exactly one wins', async () => {
    const id = (await request(await openRun(leadsOnly, nadia), 'pages/race.md')).approvalId;
    const [a, b] = await Promise.all([decide(omar, id, 'deny'), decide(omar, id, 'approve')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.approval_decisions WHERE approval_id = $1', [id])).rows[0]?.n))).toBe(1);
  });
});

describe('a hand-back approval', () => {
  // The source is `environment`, not `dlp`: runtime-hermes listens for approved `dlp` approvals and claims them itself, and this test must be the one claiming.
  it('is taken back once by the plugin that asked, for its own bot and source only', async () => {
    const run = await openRun(scoped, nadia);
    const filed = await runs.asBot(run, (tx) =>
      provider.request(tx, {
        runId: run.runId,
        source: 'environment',
        tool: 'llm.call',
        summary: 'Model call held · api-key found in the message',
        argsPreview: { rules: ['api-key'] },
        resume: { kind: 'handoff', payload: { note: 'the stopped job' } },
      }),
    );
    const claim = (botId: string, source: 'dlp' | 'grant' | 'environment') => w.system((tx) => provider.claim(tx as unknown as PluginTx, filed.approvalId, { botId, source }));
    // not approved yet: nothing to take back
    expect(await claim(scoped.botId, 'environment')).toBeNull();
    expect((await decide(rafi, filed.approvalId, 'approve')).status).toBe(200);
    // a hand-back is not run by the approvals plugin: it waits for the asker, and it is not another bot's to take
    expect(await claim(leadsOnly.botId, 'environment')).toBeNull();
    expect(await claim(scoped.botId, 'grant')).toBeNull();
    expect(await claim(scoped.botId, 'environment')).toEqual({ note: 'the stopped job' });
    expect(await claim(scoped.botId, 'environment')).toBeNull(); // spent
    expect(await rowOf(filed.approvalId)).toMatchObject({ status: 'approved', outcome: 'ran' });
    // and a person's transaction cannot take it either
    const again = await withActor(personaActor(rafi), (tx) => provider.claim(tx as unknown as PluginTx, filed.approvalId, { botId: scoped.botId, source: 'environment' }), { pool: appPool });
    expect(again).toBeNull();
  });

  it('pendingForRun counts what a run is waiting on', async () => {
    const run = await openRun(scoped, nadia);
    expect(await w.system((tx) => provider.pendingForRun(tx as unknown as PluginTx, run.runId))).toBe(0);
    await request(run, 'pages/waits.md');
    expect(await w.system((tx) => provider.pendingForRun(tx as unknown as PluginTx, run.runId))).toBe(1);
  });
});

describe('a long call', () => {
  it('is clipped in the preview, flagged, and readable in full by the people who may decide it, with secrets still hidden', async () => {
    const long = 'x'.repeat(1_200);
    const filed = await request(await openRun(scoped, nadia), 'pages/long.md', { args: PAGE('pages/long.md', long, { apiToken: 'sk-live-real' }) });
    const asRafi = (await list(rafi)).items.find((a) => a.id === filed.approvalId)!;
    expect(asRafi.argsTruncated).toBe(true);
    expect((asRafi.argsPreview['content'] as string).length).toBe(301);
    expect(asRafi.argsPreview['apiToken']).toBe('[hidden]');
    // the whole call, for the approver
    const full = await w.call(rafi, 'GET', `/api/teams/engineering/approvals/${filed.approvalId}/args`);
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    const args = GetApprovalArgsResponse.parse(full.body).args!;
    expect(args['content']).toBe(long);
    expect(args['apiToken']).toBe('[hidden]');
    // not for the requester, a non-approver, a lead who is not named, or someone off the team
    for (const who of [nadia, priya, omar, sameera]) {
      expect([403, 404], `${who.key}`).toContain((await w.call(who, 'GET', `/api/teams/engineering/approvals/${filed.approvalId}/args`)).status);
    }
    // a short call is not flagged
    const short = await request(await openRun(scoped, nadia), 'pages/short.md');
    expect((await list(rafi)).items.find((a) => a.id === short.approvalId)?.argsTruncated).toBe(false);
  });
});

describe('time', () => {
  const enqueue = (queue: string, payload: object, attempts = 0): Promise<string> =>
    w.system(async (tx) => {
      const job = (await tx.query<{ id: string }>("SELECT (app.enqueue_job($1, $2::jsonb, now() + interval '1 hour', NULL)).id AS id", [queue, JSON.stringify(payload)])).rows[0]!.id;
      await tx.query("UPDATE app.jobs SET attempts = $2, run_at = now() WHERE id = $1", [job, attempts]);
      await tx.query("SELECT pg_notify('manythreads_jobs', $1)", [queue]);
      return job;
    });
  const jobState = (id: string) => w.system(async (tx) => (await tx.query<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [id])).rows[0]?.state);
  const finished = async (id: string) => until(async () => ((await jobState(id)) === 'done' || (await jobState(id)) === 'dead' ? true : null), 30_000, 'the job to finish');

  it('a pending approval lapses: it cannot be decided, the sweep calls it expired, and it is history', async () => {
    const id = (await request(await openRun(scoped, nadia), 'pages/lapses.md')).approvalId;
    await w.system((tx) => tx.query("UPDATE app.approvals SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]));
    // lapsed but not yet swept: the list says it cannot be decided, and deciding is refused
    expect((await list(rafi)).items.find((a) => a.id === id)).toMatchObject({ status: 'pending', canDecide: false });
    expect((await decide(rafi, id, 'approve')).status).toBe(409);
    await finished(await enqueue('approvals.sweep', {}));
    expect(await rowOf(id)).toMatchObject({ status: 'expired', outcome: 'none' });
    const settled = (await list(rafi, 'decided')).items.find((a) => a.id === id)!;
    expect(settled).toMatchObject({ status: 'expired', decision: null, canDecide: false });
    expect((await decide(rafi, id, 'deny')).status).toBe(409);
    expect(await w.call(omar, 'GET', '/api/teams/engineering/repo/blob?path=pages/lapses.md').then((r) => r.status)).toBe(404);
  });

  it('an approved call that never started, or started and never reported back, is called failed by the sweep and is never re-run', async () => {
    const queued = (await request(await openRun(scoped, nadia), 'pages/never-started.md')).approvalId;
    const running = (await request(await openRun(scoped, nadia), 'pages/never-reported.md')).approvalId;
    await w.system(async (tx) => {
      await tx.query("UPDATE app.approvals SET status = 'approved', decided_at = now() - interval '40 minutes', outcome = 'queued' WHERE id = $1", [queued]);
      await tx.query("UPDATE app.approvals SET status = 'approved', decided_at = now() - interval '40 minutes', outcome = 'running', started_at = now() - interval '39 minutes' WHERE id = $1", [running]);
    });
    await finished(await enqueue('approvals.sweep', {}));
    expect(await rowOf(queued)).toMatchObject({ status: 'approved', outcome: 'failed', outcome_detail: 'It was approved but never started.' });
    expect((await rowOf(running))?.outcome).toBe('failed');
    expect((await rowOf(running))?.outcome_detail).toContain('may or may not');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    for (const path of ['pages/never-started.md', 'pages/never-reported.md']) {
      expect((await w.call(omar, 'GET', `/api/teams/engineering/repo/blob?path=${path}`)).status).toBe(404);
    }
  });

  it('the call is made once: a second delivery of either job, or a retry of the execute job, makes nothing', async () => {
    // the grant an earlier test revoked is given back: this one is about the call being made once, not about being allowed to
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, 'pages.write', true, '{}')
         ON CONFLICT (actor_id, capability) DO UPDATE SET needs_approval = true`,
        [TEAM_IDS.Engineering, scoped.actorId],
      ),
    );
    const id = (await request(await openRun(scoped, nadia), 'pages/once.md')).approvalId;
    expect((await decide(rafi, id, 'approve')).status).toBe(200);
    await until(async () => ((await rowOf(id))?.outcome === 'ran' ? true : null), 30_000, 'the call to run');
    const commitsOf = () => w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.repo_commits WHERE 'pages/once.md' = ANY (paths)")).rows[0]!.n);
    expect(await commitsOf()).toBe(1);
    // the claim job delivered again: the row is no longer `queued`, so nothing is queued
    await finished(await enqueue('approvals.resume', { approvalId: id }));
    // the execute job delivered again, as a first attempt and as a retry, while the row says `running`: the retry refuses, and nothing is written
    await w.system((tx) => tx.query("UPDATE app.approvals SET outcome = 'running' WHERE id = $1", [id]));
    await finished(await enqueue('approvals.execute', { approvalId: id }, 1)); // attempts 1 -> this run is attempt 2
    expect(await rowOf(id)).toMatchObject({ outcome: 'failed' });
    expect((await rowOf(id))?.outcome_detail).toContain('interrupted');
    expect(await commitsOf()).toBe(1);
  });

  it('a retry of an execute job whose first attempt never reported back does not make the call', async () => {
    const id = (await request(await openRun(scoped, nadia), 'pages/crashed.md')).approvalId;
    await w.system((tx) => tx.query("UPDATE app.approvals SET status = 'approved', decided_at = now(), outcome = 'running', started_at = now() WHERE id = $1", [id]));
    await finished(await enqueue('approvals.execute', { approvalId: id }, 1));
    expect(await rowOf(id)).toMatchObject({ status: 'approved', outcome: 'failed' });
    expect((await w.call(omar, 'GET', '/api/teams/engineering/repo/blob?path=pages/crashed.md')).status).toBe(404);
  });
});

describe('review round 3', () => {
  let secret = '';
  beforeAll(async () => {
    // a private channel of Engineering that only Nadia is in (yet)
    secret = await w.system(async (tx) => {
      const id = (await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'war-room', 'channel', true) RETURNING id", [omar.workspaceId, TEAM_IDS.Engineering])).rows[0]!.id;
      await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, nadia.personId]);
      return id;
    });
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, 'pages.write', true, '{}')
         ON CONFLICT (actor_id, capability) DO UPDATE SET needs_approval = true`,
        [TEAM_IDS.Engineering, scoped.actorId],
      ),
    );
  });

  it('a repeat after the first one lapsed (and was not swept yet) files a fresh approval', async () => {
    const first = await request(await openRun(scoped, nadia), 'pages/repeat.md', { dedupeKey: 'repeat-after-lapse' });
    await w.system((tx) => tx.query("UPDATE app.approvals SET expires_at = now() - interval '1 minute' WHERE id = $1", [first.approvalId]));
    const again = await request(await openRun(scoped, nadia), 'pages/repeat.md', { dedupeKey: 'repeat-after-lapse' });
    expect(again.created).toBe(true);
    expect(again.approvalId).not.toBe(first.approvalId);
    expect((await rowOf(first.approvalId))?.status).toBe('expired');
    expect((await rowOf(again.approvalId))?.status).toBe('pending');
  });

  it('the same call asked from another conversation is an approval of its own', async () => {
    const here = await request(await openRun(scoped, nadia), 'pages/two-places.md', { dedupeKey: 'two-places' });
    const there = await request(await openRun(scoped, nadia, { replyRootId: '00000000-0000-7000-8000-00000000beef' }), 'pages/two-places.md', { dedupeKey: 'two-places' });
    expect(there.created).toBe(true);
    expect(there.approvalId).not.toBe(here.approvalId);
    const sameAgain = await request(await openRun(scoped, nadia), 'pages/two-places.md', { dedupeKey: 'two-places' });
    expect(sameAgain).toMatchObject({ approvalId: here.approvalId, created: false });
  });

  it('in a private conversation nobody else could decide, nothing is filed and the model is told why', async () => {
    const run = await openRun(scoped, nadia, { channelId: secret });
    // approvers are role:on-call (Rafi), who is not in the war room: nobody but Nadia, who asked, could decide
    await expect(runs.asBot(run, (tx) => provider.request(tx, {
      runId: run.runId, source: 'grant', tool: 'pages.write', summary: 's', argsPreview: {},
      resume: { kind: 'tool', capability: 'pages.write', args: PAGE('pages/secret.md'), trigger: 'mention' },
    }))).rejects.toBeInstanceOf(NoEligibleApproverError);
    const answered = await requestToolApproval({ providers: { get: () => provider }, runs } as never, run, 'pages.write', PAGE('pages/secret.md'));
    expect(answered).toMatchObject({ refused: expect.stringContaining('Nobody but you') });
    expect(await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.approvals WHERE channel_id = $1', [secret])).rows[0]?.n)).toBe(0);
  });

  it('once a person who could decide is in it, it is filed for that conversation only: visible to its people, pushed to them, resumed without text', async () => {
    await w.system((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [secret, rafi.personId]));
    const run = await openRun(scoped, nadia, { channelId: secret, replyRootId: rootId });
    const filed = await request(run, 'pages/secret.md');
    expect(filed).toMatchObject({ created: true, visibleTo: 'conversation' });
    // who can see it: the war room's people, not Priya, not Omar (a lead and admin who is not in it)
    expect((await list(rafi)).items.map((a) => a.id)).toContain(filed.approvalId);
    expect((await list(priya)).items.map((a) => a.id)).not.toContain(filed.approvalId);
    expect((await list(omar)).items.map((a) => a.id)).not.toContain(filed.approvalId);
    // who a push would go to
    const audience = await w.system(async (tx) => (await tx.query<{ o_people: string[] }>('SELECT o_people FROM app.approvals_audience($1)', [filed.approvalId])).rows[0]!.o_people);
    expect([...audience].sort()).toEqual([nadia.personId, rafi.personId].sort());
    // approving it runs the call; its resumed event is team-wide, so it carries no sentence
    expect((await decide(rafi, filed.approvalId, 'approve')).status).toBe(200);
    await until(async () => ((await rowOf(filed.approvalId))?.outcome === 'ran' ? true : null), 30_000, 'the call to run');
    const resumed = (await eventsOf('approvals.approval.resumed')).find((e) => e['approvalId'] === filed.approvalId);
    expect(resumed).toMatchObject({ outcome: 'ran', detail: '' });
    // a public approval's event keeps its sentence
    const open = await request(await openRun(scoped, nadia), 'pages/public-detail.md');
    expect((await decide(rafi, open.approvalId, 'approve')).status).toBe(200);
    await until(async () => ((await rowOf(open.approvalId))?.outcome === 'ran' ? true : null), 30_000, 'the call to run');
    expect((await eventsOf('approvals.approval.resumed')).find((e) => e['approvalId'] === open.approvalId)?.['detail']).not.toBe('');
  });
});
