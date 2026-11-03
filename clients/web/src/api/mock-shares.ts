import {
  Approval,
  ProposalResponse,
  actOnIncomingShareRoute,
  approveApprovalRoute,
  createProposalRoute,
  denyApprovalRoute,
  getMemorySharingRoute,
  getShareRoute,
  getShareRunRoute,
  listApprovalsRoute,
  listIncomingSharesRoute,
  listShareRunsRoute,
  listSharesRoute,
  previewShareRoute,
  runShareRoute,
  setMemorySharingRoute,
  shareHeadline,
  ShareRun,
  ShareView,
  type ShareLinkState,
  type ShareMode,
  type ShareRunState,
} from '@manythreads/shared';

/*
 * The mock of the Memory screen's Sharing tab and the workspace "Memory sharing" switch (P8-26): the same routes, shapes and words the memory-share plugin answers
 * with. Engineering sends "Release notes for Support and Marketing" (Support has accepted, Marketing has not); Marketing and Customer support send to Engineering
 * (one request waits, one is open and has delivered twice); one share has a file the platform could not read. A New share is the proposal for its file
 * (`POST /api/teams/:slug/proposals`), read for its `name` and `to` lines. Run now builds, then waits for approval, as the list is read again. A request is answered in
 * its Approvals row, as on the server: the person who wrote a share cannot answer for the team it asks.
 */

type Route = { method: string; path: string };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type On = (route: Route, handler: (c: Ctx) => unknown) => void;
type Reply = { status: number; body: unknown };

export type SharesMockHooks = {
  /** The team behind a slug, as the signed-in person may see it (the same refusals as every team route). */
  team(slug: string | undefined): { id: string; slug: string; name: string };
  /** Every team, whoever the person is, for the names on the other side of a link. */
  named(slug: string): { id: string; slug: string; name: string };
  me(): { actorId: string; name: string };
  /** A team lead or a workspace admin of the team. */
  canManage(slug: string): boolean;
  isAdmin(): boolean;
  nextId(): string;
  now: string;
  workspaceId: string;
  fail(status: number, code: 'not_found' | 'conflict' | 'forbidden' | 'validation_failed', message: string): never;
};

type Share = {
  id: string;
  team: string;
  slug: string;
  name: string;
  mode: ShareMode;
  cron: string | null;
  approval: 'review' | 'auto';
  status: 'active' | 'invalid';
  invalidReason: string | null;
  updatedAt: string;
};
type Link = { id: string; shareId: string; dest: string; state: ShareLinkState; ended: 'removed' | 'by_team' | null; approvalId: string | null; requester: string | null; deliveries: number; lastDeliveredAt: string | null };
type Run = { id: string; shareId: string; state: ShareRunState; reason: string | null; createdAt: string };

const created = (body: unknown): Reply => ({ status: 201, body });

export function installSharesMock(on: On, h: SharesMockHooks): void {
  const shares: Share[] = [];
  const links: Link[] = [];
  const runs: Run[] = [];
  /** The workspace switch. */
  let enabled = true;
  let changedAt: string | null = null;
  let seeded = false;

  const addShare = (team: string, slug: string, name: string, patch: Partial<Share> = {}): Share => {
    const s: Share = { id: h.nextId(), team, slug, name, mode: 'summary', cron: null, approval: 'review', status: 'active', invalidReason: null, updatedAt: h.now, ...patch };
    shares.push(s);
    return s;
  };
  const addLink = (share: Share, dest: string, state: ShareLinkState, patch: Partial<Link> = {}): Link => {
    const l: Link = {
      id: h.nextId(), shareId: share.id, dest, state, ended: null, approvalId: state === 'requested' ? h.nextId() : null, requester: null, deliveries: 0, lastDeliveredAt: null, ...patch,
    };
    links.push(l);
    return l;
  };
  const seed = (): void => {
    if (seeded) return;
    seeded = true;
    const notes = addShare('engineering', 'release-notes', 'Release notes for Support and Marketing', { cron: '0 8 * * 1' });
    addLink(notes, 'customer-support', 'accepted', { deliveries: 2, lastDeliveredAt: '2026-09-29T08:01:00.000Z' });
    addLink(notes, 'marketing', 'requested', { requester: 'Omar Al Zabir' });
    runs.push({ id: h.nextId(), shareId: notes.id, state: 'sent', reason: null, createdAt: '2026-09-29T08:00:00.000Z' });
    addShare('engineering', 'old-runbooks', 'Runbooks', { status: 'invalid', invalidReason: 'The team “ghost” does not exist, or you cannot see it.' });
    const calendar = addShare('marketing', 'campaign-calendar', 'Campaign calendar', { mode: 'full' });
    addLink(calendar, 'engineering', 'requested', { requester: 'Tariq H.' });
    const known = addShare('customer-support', 'known-issues', 'Known issues this week', { cron: '0 9 * * *' });
    addLink(known, 'engineering', 'accepted', { deliveries: 2, lastDeliveredAt: '2026-09-30T09:01:00.000Z' });
    runs.push({ id: h.nextId(), shareId: known.id, state: 'sent', reason: null, createdAt: '2026-09-30T09:00:00.000Z' });
  };

  const needManage = (slug: string): void => {
    if (!h.canManage(slug)) h.fail(403, 'forbidden', 'Only a team lead or a workspace admin can do that.');
  };
  const shareOf = (team: string, slug: string | undefined): Share => {
    const s = shares.find((x) => x.team === team && x.slug === slug);
    if (!s) h.fail(404, 'not_found', 'No such share in this team');
    return s;
  };
  const destinations = (s: Share) =>
    links
      .filter((l) => l.shareId === s.id)
      .map((l) => {
        const t = h.named(l.dest);
        return { teamId: t.id, slug: t.slug, name: t.name, link: l.state };
      });
  const lastRun = (s: Share): Run | undefined => runs.filter((r) => r.shareId === s.id).at(-1);
  /** A digest being built moves on one step each time the list is read: it then waits for a lead in Approvals. */
  const advance = (): void => {
    for (const r of runs) if (r.state === 'building') Object.assign(r, { state: 'awaiting_approval', reason: 'Waiting for a team lead or workspace admin to approve it in Approvals.' });
  };
  const view = (s: Share) => {
    const last = lastRun(s);
    return ShareView.parse({
      id: s.id, teamId: h.named(s.team).id, slug: s.slug, name: s.name, status: s.status, invalidReason: s.invalidReason, mode: s.mode, approval: s.approval, approvalEffective: 'review',
      cron: s.cron, nextRunAt: s.cron ? '2026-10-05T08:00:00.000Z' : null, destinations: destinations(s),
      lastRun: last ? { id: last.id, state: last.state, at: last.createdAt } : null, updatedAt: s.updatedAt,
    });
  };

  on(listSharesRoute, ({ params }) => {
    seed();
    advance();
    const team = h.team(params['slug']);
    return { shares: shares.filter((s) => s.team === team.slug).sort((a, b) => a.name.localeCompare(b.name)).map(view), canManage: h.canManage(team.slug) };
  });

  // the incoming routes are registered before the ones with a share name in the same place, as on the server
  on(listIncomingSharesRoute, ({ params }) => {
    seed();
    const team = h.team(params['slug']);
    const incoming = links
      .filter((l) => l.dest === team.slug)
      .flatMap((l) => {
        const s = shares.find((x) => x.id === l.shareId);
        if (!s || s.status !== 'active') return [];
        const from = h.named(s.team);
        return [
          {
            id: l.id, shareId: s.id, fromTeamId: from.id, fromSlug: from.slug, fromName: from.name, shareName: s.name, mode: s.mode, state: l.state, endedReason: l.ended,
            approvalId: l.approvalId, requestedAt: h.now, acceptedAt: l.state === 'accepted' || l.state === 'paused' ? h.now : null, lastDeliveredAt: l.lastDeliveredAt, deliveries: l.deliveries,
          },
        ];
      });
    return { incoming, canManage: h.canManage(team.slug) };
  });
  on(actOnIncomingShareRoute, ({ params }) => {
    seed();
    const team = h.team(params['slug']);
    needManage(team.slug);
    const link = links.find((l) => l.id === params['linkId'] && l.dest === team.slug);
    if (!link) h.fail(404, 'not_found', 'No such share for this team');
    const action = params['action'];
    if (action === 'pause') {
      if (link.state !== 'accepted') h.fail(409, 'conflict', 'only a share this team has accepted can be paused');
      link.state = 'paused';
    } else if (action === 'resume') {
      if (link.state !== 'paused') h.fail(409, 'conflict', 'only a paused share can be resumed');
      link.state = 'accepted';
    } else if (action === 'revoke') {
      if (link.state === 'revoked') h.fail(409, 'conflict', 'this share has already ended');
      link.state = 'revoked';
      link.ended = 'by_team';
    } else h.fail(400, 'validation_failed', 'An action is pause, resume or revoke.');
    const s = shares.find((x) => x.id === link.shareId);
    if (!s) h.fail(404, 'not_found', 'No such share for this team');
    const from = h.named(s.team);
    return {
      link: {
        id: link.id, shareId: s.id, fromTeamId: from.id, fromSlug: from.slug, fromName: from.name, shareName: s.name, mode: s.mode, state: link.state, endedReason: link.ended,
        approvalId: link.approvalId, requestedAt: h.now, acceptedAt: h.now, lastDeliveredAt: link.lastDeliveredAt, deliveries: link.deliveries,
      },
    };
  });

  on(getShareRoute, ({ params }) => {
    seed();
    const team = h.team(params['slug']);
    const v = view(shareOf(team.slug, params['shareSlug']));
    return { share: v, canManage: h.canManage(team.slug), destinations: v.destinations };
  });

  on(previewShareRoute, ({ params }) => {
    seed();
    const team = h.team(params['slug']);
    needManage(team.slug);
    const s = shareOf(team.slug, params['shareSlug']);
    if (s.status !== 'active') h.fail(409, 'conflict', s.invalidReason ?? 'This share’s file is not valid, so nothing can be previewed.');
    const ref = (path: string, title: string) => ({ path, title });
    return {
      preview: {
        shareId: s.id,
        counts: { matched: 12, included: 3, leftOut: 3, unchanged: 6, retired: 1, redacted: 0 },
        headline: shareHeadline(12, 3),
        included: [ref('decisions/upgrade-test-on-2-3', 'Run the upgrade test on a 2.3 fixture'), ref('playbooks/release', 'Release playbook'), ref('facts/release-process', 'Release process')],
        excluded: [
          { ...ref('people/release-captain', 'The release captain'), reason: 'personal' },
          { ...ref('decisions/pricing-draft', 'Pricing draft'), reason: 'team_only' },
          { ...ref('playbooks/old-rollback', 'Old rollback steps'), reason: 'stale' },
        ],
        diff: { added: [ref('playbooks/release', 'Release playbook')], changed: [ref('facts/release-process', 'Release process'), ref('decisions/upgrade-test-on-2-3', 'Run the upgrade test on a 2.3 fixture')], retired: [ref('decisions/old', 'decisions/old')], unchanged: 6 },
        destinations: destinations(s),
      },
    };
  });

  on(runShareRoute, ({ params }) => {
    seed();
    const team = h.team(params['slug']);
    needManage(team.slug);
    const s = shareOf(team.slug, params['shareSlug']);
    if (s.status !== 'active') h.fail(409, 'conflict', s.invalidReason ?? 'This share’s file is not valid, so it cannot run.');
    if (!enabled) h.fail(409, 'conflict', 'Memory sharing is switched off for this workspace.');
    if (lastRun(s)?.state === 'building') h.fail(409, 'conflict', 'A digest of this share is already being built. Wait for it to finish, then run it again.');
    const run: Run = { id: h.nextId(), shareId: s.id, state: 'building', reason: null, createdAt: h.now };
    runs.push(run);
    return { status: 202, body: { run: runBody(run, s, h.named(s.team).id, destinations(s)) } };
  });
  const runBody = (r: Run, s: Share, teamId: string, dests: ReturnType<typeof destinations>) =>
    ShareRun.parse({
      id: r.id, shareId: s.id, teamId, trigger: 'manual', state: r.state, reason: r.reason, mode: s.mode, period: null, digestSha: null, bundleBytes: 0, counts: null, included: [], excluded: [], diff: null,
      destinations: dests, approvalId: null, requestedBy: h.me().actorId, settledBy: null, createdAt: r.createdAt, builtAt: null, settledAt: null, sentAt: null,
    });
  on(listShareRunsRoute, ({ params }) => {
    seed();
    const team = h.team(params['slug']);
    needManage(team.slug);
    const s = shareOf(team.slug, params['shareSlug']);
    return { runs: runs.filter((r) => r.shareId === s.id).reverse().map((r) => runBody(r, s, h.named(s.team).id, destinations(s))) };
  });
  on(getShareRunRoute, ({ params }) => {
    seed();
    const team = h.team(params['slug']);
    needManage(team.slug);
    const s = shareOf(team.slug, params['shareSlug']);
    const r = runs.find((x) => x.id === params['runId'] && x.shareId === s.id);
    if (!r) h.fail(404, 'not_found', 'No such run for this share');
    return { run: runBody(r, s, h.named(s.team).id, destinations(s)) };
  });

  // a request to receive a share is an Approvals row of the receiving team; deciding it moves the link
  const decide = (decision: 'approved' | 'denied') => (c: Ctx): unknown => {
    seed();
    const team = h.team(c.params['slug']);
    const link = links.find((l) => l.approvalId === c.params['approvalId'] && l.dest === team.slug);
    if (!link) h.fail(404, 'not_found', 'No such approval in this team');
    needManage(team.slug);
    const s = shares.find((x) => x.id === link.shareId);
    if (!s) h.fail(404, 'not_found', 'No such approval in this team');
    if (link.requester === h.me().name) h.fail(403, 'forbidden', 'You asked for this, so someone else has to decide it.');
    if (link.state !== 'requested') h.fail(409, 'conflict', 'This request has already been answered.');
    link.state = decision === 'approved' ? 'accepted' : 'revoked';
    link.ended = decision === 'approved' ? null : 'by_team';
    const from = h.named(s.team);
    const me = h.me();
    return {
      approval: Approval.parse({
        id: link.approvalId, workspaceId: h.workspaceId, teamId: h.named(team.slug).id, source: 'grant', status: decision, outcome: decision === 'approved' ? 'ran' : 'none', outcomeDetail: '',
        expiresAt: '2026-10-08T14:02:00.000Z', startedAt: null, tool: 'memory.share.accept', summary: `Let ${from.name} share its memory with ${team.name}: “${s.name}”`,
        argsPreview: { from: from.name, share: s.name, mode: s.mode }, argsTruncated: false, botId: null, botSlug: null, botName: null, requesterId: me.actorId, requesterName: link.requester ?? 'someone',
        channelId: null, threadRootId: null, approvers: { roles: [], people: [], leads: true }, canDecide: false, blockReason: null,
        decision: { decision, deciderId: me.actorId, deciderName: me.name, note: '', decidedAt: h.now }, createdAt: h.now,
      }),
    };
  };
  // the team's waiting requests, as Approvals rows: who asked decides what the caller may do with each (the same rule as the answer above)
  on(listApprovalsRoute, ({ params, query }) => {
    seed();
    const team = h.team(params['slug']);
    if (query.get('status') === 'decided') return { items: [], waiting: 0 };
    const me = h.me();
    const items = links
      .filter((l) => l.dest === team.slug && l.state === 'requested' && l.approvalId !== null)
      .flatMap((l) => {
        const s = shares.find((x) => x.id === l.shareId);
        if (!s || s.status !== 'active') return [];
        const from = h.named(s.team);
        const mine = l.requester === me.name;
        const canDecide = !mine && h.canManage(team.slug);
        return [
          Approval.parse({
            id: l.approvalId, workspaceId: h.workspaceId, teamId: h.named(team.slug).id, source: 'grant', status: 'pending', outcome: 'none', outcomeDetail: '',
            expiresAt: '2026-10-08T14:02:00.000Z', startedAt: null, tool: 'memory.share.accept', summary: `Let ${from.name} share its memory with ${team.name}: “${s.name}”`,
            argsPreview: { from: from.name, share: s.name, mode: s.mode }, argsTruncated: false, botId: null, botSlug: null, botName: null, requesterId: me.actorId, requesterName: l.requester ?? 'someone',
            channelId: null, threadRootId: null, approvers: { roles: [], people: [], leads: true }, canDecide, blockReason: canDecide ? null : mine ? 'requester' : 'not_approver',
            decision: null, createdAt: h.now,
          }),
        ];
      });
    return { items, waiting: items.length };
  });
  on(approveApprovalRoute, decide('approved'));
  on(denyApprovalRoute, decide('denied'));

  // New share: the proposal for the share's file, applied at once. The mock reads the file's `name:` and `to:` lines.
  on(createProposalRoute, ({ params, body }) => {
    seed();
    const team = h.team(params['slug']);
    needManage(team.slug);
    const path = String(body['path'] ?? '');
    const file = /^routines\/shares\/([a-z0-9][a-z0-9-]{0,62})\.yaml$/.exec(path);
    if (!file) h.fail(400, 'validation_failed', 'Only share files can be proposed from this page.');
    const text = String(body['content'] ?? '');
    const name = /^name: (".*")$/m.exec(text)?.[1];
    const to = /^to: \[(.*)\]$/m.exec(text)?.[1];
    if (!name || !to) h.fail(400, 'validation_failed', 'The share file is not valid.');
    const slug = file[1] as string;
    if (shares.some((s) => s.team === team.slug && s.slug === slug)) h.fail(409, 'conflict', 'A share with that name already exists.');
    const cron = /^when: \{ cron: "(.*)" \}$/m.exec(text)?.[1] ?? null;
    const share = addShare(team.slug, slug, JSON.parse(name) as string, {
      cron,
      mode: /^mode: full$/m.test(text) ? 'full' : 'summary',
      approval: /^approval: auto$/m.test(text) ? 'auto' : 'review',
    });
    for (const dest of to.split(',').map((x) => x.trim()).filter((x) => x !== '')) addLink(share, dest, 'requested', { requester: h.me().name });
    const me = h.me();
    return created(
      ProposalResponse.parse({
        proposal: {
          proposal: {
            id: h.nextId(), teamId: team.id, path, op: 'put', title: String(body['title'] ?? 'Add a share'), note: '', status: 'applied', authorId: me.actorId, authorKind: 'person', authorName: me.name,
            baseBlobSha: null, baseCommitSha: 'a'.repeat(40), diff: '', added: text.split('\n').length, removed: 0, checks: [], createdAt: h.now, decidedAt: h.now, decidedByName: me.name,
            decisionNote: null, appliedCommitSha: 'b'.repeat(40), selfApplied: true,
          },
          stale: false, staleReason: null, canApply: false, cannotApplyReason: null, canReject: false, canWithdraw: false,
        },
      }),
    );
  });

  on(getMemorySharingRoute, () => ({ enabled, canChange: h.isAdmin(), changedAt }));
  on(setMemorySharingRoute, ({ body }) => {
    if (!h.isAdmin()) h.fail(403, 'forbidden', 'Only workspace owners and admins can switch memory sharing on or off.');
    if (typeof body['enabled'] !== 'boolean') h.fail(400, 'validation_failed', 'Say whether memory sharing is on or off.');
    if (enabled !== body['enabled']) changedAt = h.now;
    enabled = body['enabled'];
    return { enabled, canChange: true, changedAt };
  });
}
