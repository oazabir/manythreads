import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_DIGEST_SEND_TOOL, MEMORY_SHARE_ACCEPT_TOOL, ShareDefinition, ShareIncoming, type ShareView } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { switchWords } from '../src/screens/admin/memory/words';
import { fetchApprovals } from '../src/screens/approvals/api';
import { IncomingCard } from '../src/screens/memory/IncomingCard';
import { approvalRowLabel, acceptView, digestView, isShareApproval, selectWords, shareKind, shareOutcomeLine } from '../src/screens/approvals/shareApproval';
import { TABS, nextTab, tabFromParams } from '../src/screens/memory/memoryTabs';
import {
  actOnIncoming,
  createShare,
  decideRequest,
  fetchIncomingShares,
  fetchMemorySharing,
  fetchShareRun,
  fetchShares,
  previewShare,
  runShare,
  setMemorySharing,
} from '../src/screens/memory/shareApi';
import {
  ASKED_BY_YOU_WHY,
  CHOICE_WORDS,
  SCHEDULES,
  SHARING_OFF_WHY,
  acceptedLine,
  approvalWords,
  askedByMeIds,
  conceptsFromTeam,
  definitionYaml,
  destinationSentence,
  digestName,
  digestStateWords,
  digestsFrom,
  draftProblem,
  draftToDefinition,
  emptyDraft,
  incomingChoices,
  incomingLook,
  incomingSentence,
  leftOutGroups,
  leftOutLine,
  linkLook,
  modeWords,
  previewDiffLine,
  previewHeadline,
  proposalTitle,
  receivedLinks,
  requestedLinks,
  requestHold,
  runIsMoving,
  runLook,
  runNow,
  scheduleWords,
  shareFile,
  slugOfName,
  splitList,
  type ShareDraft,
} from '../src/screens/memory/shareWords';

/*
 * What the Memory screen's Sharing tab and the workspace Memory sharing switch send and say. The first part checks each call reaches the route the memory-share
 * plugin mounts (written out, not derived from the route objects the client uses). The second runs the same calls against the mock the screen uses offline: its answers
 * must parse with the shared schemas and refuse what the server refuses. The third reads the plain words, the New share form and the file it writes.
 */

const LINK = '00000000-0000-7000-8000-0000000a0001';
const RUN = '00000000-0000-7000-8000-0000000a0002';
const APPROVAL = '00000000-0000-7000-8000-0000000a0003';

describe('the sharing calls reach the routes the plugin mounts', () => {
  let seen: TransportRequest[] = [];
  beforeEach(() => {
    seen = [];
    setTransport(async (req) => {
      seen.push(req);
      return { status: 418, body: { error: { code: 'internal', message: 'stop' } } };
    });
  });
  const send = async (run: () => Promise<unknown>): Promise<TransportRequest> => {
    await run().catch(() => undefined);
    const req = seen.at(-1);
    if (!req) throw new Error('no request was sent');
    return req;
  };
  const cases: Array<{ name: string; run: () => Promise<unknown>; method: string; url: string; body?: unknown }> = [
    { name: 'lists the shares', run: () => fetchShares('engineering'), method: 'GET', url: '/api/teams/engineering/shares' },
    { name: 'previews a share', run: () => previewShare('engineering', 'release-notes'), method: 'GET', url: '/api/teams/engineering/shares/release-notes/preview' },
    { name: 'runs a share now', run: () => runShare('engineering', 'release-notes'), method: 'POST', url: '/api/teams/engineering/shares/release-notes/run' },
    { name: 'reads one run', run: () => fetchShareRun('engineering', 'release-notes', RUN), method: 'GET', url: `/api/teams/engineering/shares/release-notes/runs/${RUN}` },
    { name: 'lists the shares sent to the team', run: () => fetchIncomingShares('marketing'), method: 'GET', url: '/api/teams/marketing/shares/incoming' },
    { name: 'pauses a link', run: () => actOnIncoming('marketing', LINK, 'pause'), method: 'POST', url: `/api/teams/marketing/shares/incoming/${LINK}/pause` },
    { name: 'resumes a link', run: () => actOnIncoming('marketing', LINK, 'resume'), method: 'POST', url: `/api/teams/marketing/shares/incoming/${LINK}/resume` },
    { name: 'ends a link', run: () => actOnIncoming('marketing', LINK, 'revoke'), method: 'POST', url: `/api/teams/marketing/shares/incoming/${LINK}/revoke` },
    { name: 'accepts a request in its approval', run: () => decideRequest('marketing', APPROVAL, 'approve'), method: 'POST', url: `/api/teams/marketing/approvals/${APPROVAL}/approve` },
    { name: 'declines a request in its approval', run: () => decideRequest('marketing', APPROVAL, 'deny'), method: 'POST', url: `/api/teams/marketing/approvals/${APPROVAL}/deny` },
    { name: 'reads the workspace switch', run: () => fetchMemorySharing(), method: 'GET', url: '/api/workspace/memory-sharing' },
    { name: 'sets the workspace switch', run: () => setMemorySharing(false), method: 'PUT', url: '/api/workspace/memory-sharing', body: { enabled: false } },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const req = await send(c.run);
      expect(req.method).toBe(c.method);
      expect(req.url.split('?')[0]).toBe(c.url);
      if (c.body !== undefined) expect(JSON.parse(req.body ?? 'null')).toEqual(c.body);
    });
  }

  it('a New share is a proposal for the share’s file, applied at once, with no earlier version', async () => {
    const draft: ShareDraft = { ...emptyDraft(), name: 'Release notes', to: ['marketing'] };
    const req = await send(() => createShare('engineering', draft));
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/teams/engineering/proposals');
    const body = JSON.parse(req.body ?? 'null') as Record<string, unknown>;
    expect(body).toMatchObject({ path: 'routines/shares/release-notes.yaml', op: 'put', baseBlobSha: null, applyNow: true, title: 'Share “Release notes” with other teams' });
    expect(body['content']).toBe(definitionYaml(draftToDefinition(draft)));
  });

  it('refuses a switch value the schema does not know before it leaves the browser', async () => {
    let refused = false;
    try {
      await setMemorySharing('yes' as never);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe('the mock answers as the plugin does', () => {
  const as = (who: string) => setTransport(createMockTransport({ latencyMs: 0, as: who }));
  const named = (list: readonly ShareView[], slug: string): ShareView => {
    const found = list.find((s) => s.slug === slug);
    if (!found) throw new Error(`no share ${slug}`);
    return found;
  };
  const from = (list: readonly ShareIncoming[], slug: string): ShareIncoming => {
    const found = list.find((l) => l.fromSlug === slug);
    if (!found) throw new Error(`nothing from ${slug}`);
    return found;
  };

  it('a lead reads Engineering’s shares: each destination’s answer, the schedule, the last digest and the file that could not be read', async () => {
    as('omar');
    const { shares, canManage } = await fetchShares('engineering');
    expect(canManage).toBe(true);
    const notes = named(shares, 'release-notes');
    expect(notes).toMatchObject({ name: 'Release notes for Support and Marketing', status: 'active', cron: '0 8 * * 1', mode: 'summary', approvalEffective: 'review' });
    expect(notes.destinations.map((d) => [d.slug, d.link])).toEqual([['customer-support', 'accepted'], ['marketing', 'requested']]);
    expect(notes.lastRun?.state).toBe('sent');
    expect(acceptedLine(notes.destinations)).toBe('1 of 2 teams has accepted');
    expect(scheduleWords(notes.cron)).toBe('Every Monday at 08:00 UTC');
    const bad = named(shares, 'old-runbooks');
    expect(bad).toMatchObject({ status: 'invalid', invalidReason: expect.stringMatching(/ghost/) });
    expect(runNow(bad, true, true)).toEqual({ ok: false, reason: expect.stringMatching(/ghost/) });
  });

  it('a member reads the shares but cannot preview or run them', async () => {
    as('nadia');
    const { canManage } = await fetchShares('engineering');
    expect(canManage).toBe(false);
    await expect(previewShare('engineering', 'release-notes')).rejects.toThrow(/team lead or a workspace admin/);
    await expect(runShare('engineering', 'release-notes')).rejects.toThrow(/team lead or a workspace admin/);
  });

  it('a person outside the team is refused', async () => {
    as('sameera');
    await expect(fetchShares('engineering')).rejects.toThrow();
  });

  it('the live preview says how many concepts match and how many are left out, and why', async () => {
    as('omar');
    const { preview } = await previewShare('engineering', 'release-notes');
    expect(previewHeadline(preview)).toBe('Matches 12 concepts · 3 left out');
    expect(previewDiffLine(preview)).toBe('1 new, 2 changed, 1 retired · 6 unchanged');
    const groups = leftOutGroups(preview.excluded);
    expect(groups.map((g) => g.reason).sort()).toEqual(['personal', 'stale', 'team_only']);
    expect(leftOutLine(groups.find((g) => g.reason === 'personal') as { words: string; items: unknown[] })).toBe('1 concept: it is a note about a person');
    await expect(previewShare('engineering', 'old-runbooks')).rejects.toThrow(/ghost/);
  });

  it('Run now starts a digest; a second press is refused while it builds; the list then shows it waiting for approval, with the server’s reason', async () => {
    as('omar');
    const first = await runShare('engineering', 'release-notes');
    expect(first.run.state).toBe('building');
    await expect(runShare('engineering', 'release-notes')).rejects.toThrow(/already being built/);
    // reading the list moves it on one step
    const after = named((await fetchShares('engineering')).shares, 'release-notes');
    expect(after.lastRun?.state).toBe('awaiting_approval');
    const run = (await fetchShareRun('engineering', 'release-notes', after.lastRun?.id ?? '')).run;
    expect(run.reason).toMatch(/approve it in Approvals/);
    expect(runIsMoving(after.lastRun?.state)).toBe(false);
  });

  it('requests: Engineering sees Marketing’s and accepts it; the link opens and the request is gone', async () => {
    as('omar');
    const before = await fetchIncomingShares('engineering');
    expect(before.canManage).toBe(true);
    const request = from(before.incoming, 'marketing');
    expect(request).toMatchObject({ state: 'requested', shareName: 'Campaign calendar', mode: 'full' });
    expect(incomingChoices(request, true)).toEqual({ choices: ['accept', 'decline'], why: null });
    const approvalId = request.approvalId;
    expect(approvalId).not.toBeNull();
    const answer = await decideRequest('engineering', approvalId ?? '', 'approve');
    expect(answer.approval).toMatchObject({ status: 'approved', tool: MEMORY_SHARE_ACCEPT_TOOL, outcome: 'ran' });
    const after = await fetchIncomingShares('engineering');
    expect(from(after.incoming, 'marketing').state).toBe('accepted');
    expect(requestedLinks(after.incoming)).toHaveLength(0);
    await expect(decideRequest('engineering', approvalId ?? '', 'approve')).rejects.toThrow(/already been answered/);
  });

  it('declining ends the link for good; Pause and Resume move an open one; Stop receiving ends it and cannot be done twice', async () => {
    as('omar');
    const request = from((await fetchIncomingShares('engineering')).incoming, 'marketing');
    await decideRequest('engineering', request.approvalId ?? '', 'deny');
    const declined = from((await fetchIncomingShares('engineering')).incoming, 'marketing');
    expect(declined).toMatchObject({ state: 'revoked', endedReason: 'by_team' });
    expect(incomingChoices(declined, true)).toEqual({ choices: [], why: null });

    const open = from((await fetchIncomingShares('engineering')).incoming, 'customer-support');
    expect(open.state).toBe('accepted');
    await expect(actOnIncoming('engineering', open.id, 'resume')).rejects.toThrow(/only a paused share/);
    expect((await actOnIncoming('engineering', open.id, 'pause')).link.state).toBe('paused');
    await expect(actOnIncoming('engineering', open.id, 'pause')).rejects.toThrow(/only a share this team has accepted/);
    expect((await actOnIncoming('engineering', open.id, 'resume')).link.state).toBe('accepted');
    expect((await actOnIncoming('engineering', open.id, 'revoke')).link).toMatchObject({ state: 'revoked', endedReason: 'by_team' });
    await expect(actOnIncoming('engineering', open.id, 'revoke')).rejects.toThrow(/already ended/);
  });

  it('the person who wrote a share cannot answer for the team it asks; its lead can', async () => {
    as('omar');
    const mine = from((await fetchIncomingShares('marketing')).incoming, 'engineering');
    expect(mine.state).toBe('requested');
    await expect(decideRequest('marketing', mine.approvalId ?? '', 'approve')).rejects.toThrow(/someone else has to decide/);
    as('tariq');
    const theirs = from((await fetchIncomingShares('marketing')).incoming, 'engineering');
    expect((await decideRequest('marketing', theirs.approvalId ?? '', 'approve')).approval.status).toBe('approved');
  });

  it('a member of the receiving team reads what is sent to it but cannot answer', async () => {
    as('sameera');
    const { incoming, canManage } = await fetchIncomingShares('customer-support');
    expect(canManage).toBe(false);
    const open = from(incoming, 'engineering');
    expect(open).toMatchObject({ state: 'accepted', deliveries: 2 });
    expect(incomingChoices(open, canManage)).toEqual({ choices: [], why: expect.stringMatching(/lead of this team/) });
    await expect(actOnIncoming('customer-support', open.id, 'pause')).rejects.toThrow(/team lead or a workspace admin/);
  });

  it('a New share appears in the list with a request to each team named, and a name already used is refused', async () => {
    as('omar');
    const draft: ShareDraft = { ...emptyDraft(), name: 'Playbooks for Support', to: ['customer-support', 'marketing'], paths: 'playbooks/', schedule: 'daily' };
    expect(draftProblem(draft, new Set())).toBeNull();
    const made = await createShare('engineering', draft);
    expect(made.proposal.proposal).toMatchObject({ path: 'routines/shares/playbooks-for-support.yaml', status: 'applied', selfApplied: true });
    const share = named((await fetchShares('engineering')).shares, 'playbooks-for-support');
    expect(share).toMatchObject({ name: 'Playbooks for Support', cron: '0 8 * * *', status: 'active' });
    expect(share.destinations.map((d) => [d.slug, d.link])).toEqual([['customer-support', 'requested'], ['marketing', 'requested']]);
    expect(acceptedLine(share.destinations)).toBe('No team has accepted yet.');
    expect(runNow(share, true, true)).toEqual({ ok: false, reason: expect.stringMatching(/No team has accepted/) });
    await expect(createShare('engineering', draft)).rejects.toThrow(/already exists/);
  });

  it('only a lead or admin creates a share', async () => {
    as('nadia');
    await expect(createShare('engineering', { ...emptyDraft(), name: 'Mine', to: ['marketing'] })).rejects.toThrow(/team lead or a workspace admin/);
  });

  it('the workspace switch is on, an admin turns it off and on, Run now is refused while it is off, and anyone else only reads it', async () => {
    as('omar');
    expect(await fetchMemorySharing()).toEqual({ enabled: true, canChange: true, changedAt: null });
    const off = await setMemorySharing(false);
    expect(off).toMatchObject({ enabled: false, canChange: true, changedAt: expect.any(String) });
    await expect(runShare('engineering', 'release-notes')).rejects.toThrow(/switched off/);
    expect(runNow(named((await fetchShares('engineering')).shares, 'release-notes'), off.enabled, true)).toEqual({ ok: false, reason: 'Memory sharing is switched off for this workspace.' });
    expect((await setMemorySharing(true)).enabled).toBe(true);
    as('nadia');
    expect(await fetchMemorySharing()).toMatchObject({ enabled: true, canChange: false });
    await expect(setMemorySharing(false)).rejects.toThrow(/owners and admins/);
  });
});

describe('the words', () => {
  it('has the four link states in plain words, each with a shape as well as a colour', () => {
    expect(linkLook('requested')).toMatchObject({ label: 'Waiting for them', tone: 'warn' });
    expect(linkLook('accepted')).toMatchObject({ label: 'Accepted', tone: 'ok' });
    expect(linkLook('paused')).toMatchObject({ label: 'Paused by them', tone: 'idle' });
    expect(linkLook('revoked')).toMatchObject({ label: 'Ended', tone: 'bad' });
    for (const s of ['requested', 'accepted', 'paused', 'revoked'] as const) expect(linkLook(s).glyph).not.toBe('');
  });

  it('says what each destination state means for the sender', () => {
    const d = (link: ShareView['destinations'][number]['link']) => destinationSentence({ name: 'Marketing', slug: 'marketing', link });
    expect(d('requested')).toMatch(/has not said yes yet.*nothing is sent until they do/);
    expect(d('accepted')).toBe('Marketing receives every digest.');
    expect(d('paused')).toMatch(/paused this/);
    expect(d('revoked')).toBe('Marketing no longer receives this.');
    expect(destinationSentence({ name: '', slug: 'marketing', link: 'accepted' })).toBe('marketing receives every digest.');
    expect(acceptedLine([])).toBe('No team is named in this share.');
    expect(acceptedLine([{ link: 'requested' }])).toBe('The team has not accepted yet.');
    expect(acceptedLine([{ link: 'accepted' }, { link: 'accepted' }])).toBe('2 of 2 teams have accepted');
  });

  it('writes a schedule as words, and shows one it does not know as it is written', () => {
    expect(scheduleWords(null)).toBe('Only when someone presses Run now');
    expect(scheduleWords('0 8 * * *')).toBe('Every day at 08:00 UTC');
    expect(scheduleWords('30 14 * * 5')).toBe('Every Friday at 14:30 UTC');
    expect(scheduleWords('0 8 * * MON')).toBe('Every Monday at 08:00 UTC');
    expect(scheduleWords('0 8 * * 7')).toBe('Every Sunday at 08:00 UTC');
    expect(scheduleWords('*/15 * * * *')).toBe('On the schedule */15 * * * * (UTC)');
    expect(scheduleWords('0 25 * * *')).toBe('On the schedule 0 25 * * * (UTC)');
  });

  it('says who approves, including what the platform really does when automatic sending was asked for', () => {
    expect(approvalWords({ approval: 'review', approvalEffective: 'review' })).toBe('A lead approves each digest in Approvals');
    expect(approvalWords({ approval: 'auto', approvalEffective: 'auto' })).toBe('Goes out without a review');
    expect(approvalWords({ approval: 'auto', approvalEffective: 'review' })).toMatch(/needs a lead or admin to set it up/);
    expect(modeWords('summary')).toBe('A short summary only');
    expect(modeWords('full')).toBe('A summary and a copy of each concept');
  });

  it('has a word for every state of a digest, and asks again only while one is moving', () => {
    for (const s of ['building', 'empty', 'blocked', 'awaiting_approval', 'ready', 'denied', 'expired', 'failed', 'sent'] as const) expect(runLook(s).label).not.toBe('');
    expect(runLook('sent')).toMatchObject({ label: 'Sent', tone: 'ok' });
    expect(runLook('awaiting_approval').label).toBe('Waiting for approval');
    expect(runIsMoving('building')).toBe(true);
    expect(runIsMoving('ready')).toBe(true);
    expect(runIsMoving('awaiting_approval')).toBe(false);
    expect(runIsMoving('sent')).toBe(false);
    expect(runIsMoving(undefined)).toBe(false);
  });

  it('Run now says why it cannot be pressed', () => {
    const share = { status: 'active' as const, invalidReason: null, destinations: [{ link: 'accepted' as const }], lastRun: null };
    expect(runNow(share, true, true)).toEqual({ ok: true, reason: null });
    expect(runNow(share, true, false).reason).toMatch(/Only a team lead or a workspace admin/);
    expect(runNow(share, false, true).reason).toBe('Memory sharing is switched off for this workspace.');
    expect(runNow({ ...share, lastRun: { id: RUN as never, state: 'building', at: '2026-10-01T00:00:00.000Z' } }, true, true).reason).toMatch(/being built/);
    expect(runNow({ ...share, destinations: [{ link: 'paused' }] }, true, true).reason).toMatch(/No team has accepted/);
    expect(runNow({ ...share, status: 'invalid', invalidReason: null }, true, true).reason).toMatch(/could not be read/);
  });

  it('writes the left-out reasons in the plain words the platform uses', () => {
    const groups = leftOutGroups([
      { path: 'a', title: 'A', reason: 'stale' },
      { path: 'b', title: 'B', reason: 'trust' },
      { path: 'c', title: 'C', reason: 'trust' },
    ]);
    expect(groups.map((g) => [g.reason, g.items.length])).toEqual([['trust', 2], ['stale', 1]]);
    expect(leftOutLine(groups[0] as { words: string; items: unknown[] })).toBe('2 concepts: its trust is below what this share asks for');
    expect(previewHeadline({ headline: '', counts: { matched: 1, included: 1, leftOut: 0, unchanged: 0, retired: 0, redacted: 0 } })).toBe('Matches 1 concept · 0 left out');
    expect(previewDiffLine({ diff: { added: [], changed: [], retired: [], unchanged: 0 } })).toBe('Nothing new');
  });

  describe('the other side', () => {
    const link = (patch: Partial<ShareIncoming>): ShareIncoming =>
      ({ id: LINK, shareId: LINK, fromTeamId: LINK, fromSlug: 'engineering', fromName: 'Engineering', shareName: 'Release notes', mode: 'summary', state: 'accepted', endedReason: null, approvalId: null, requestedAt: '2026-10-01T00:00:00.000Z', acceptedAt: null, lastDeliveredAt: null, deliveries: 0, ...patch }) as ShareIncoming;

    it('offers Accept and Decline to a request, Pause and Stop receiving to an open link, Resume to a paused one, and nothing to an ended one', () => {
      expect(incomingChoices(link({ state: 'requested', approvalId: APPROVAL as never }), true).choices).toEqual(['accept', 'decline']);
      expect(incomingChoices(link({ state: 'requested' }), true)).toEqual({ choices: [], why: expect.stringMatching(/not in Approvals yet/) });
      expect(incomingChoices(link({ state: 'accepted' }), true).choices).toEqual(['pause', 'end']);
      expect(incomingChoices(link({ state: 'paused' }), true).choices).toEqual(['resume', 'end']);
      expect(incomingChoices(link({ state: 'revoked' }), true).choices).toEqual([]);
      expect(incomingChoices(link({ state: 'accepted' }), false)).toEqual({ choices: [], why: expect.stringMatching(/lead of this team or a workspace admin decides/) });
      for (const c of ['accept', 'decline', 'pause', 'resume', 'end'] as const) expect(CHOICE_WORDS[c].done('Engineering')).toMatch(/Engineering/);
    });

    it('describes each state, and who ended a link', () => {
      expect(incomingLook(link({ state: 'requested' })).label).toBe('Asking to share');
      expect(incomingLook(link({ state: 'accepted' })).label).toBe('Receiving');
      expect(incomingLook(link({ state: 'paused' })).label).toBe('Paused');
      expect(incomingLook(link({ state: 'revoked', endedReason: 'removed' })).label).toBe('Stopped by the sender');
      expect(incomingLook(link({ state: 'revoked', endedReason: 'by_team' })).label).toBe('Ended');
      expect(incomingSentence(link({ state: 'requested' }))).toMatch(/Nothing arrives unless you accept/);
      expect(incomingSentence(link({ state: 'accepted', deliveries: 1 }))).toBe('Engineering sends a short summary. 1 digest has arrived.');
      expect(incomingSentence(link({ state: 'accepted', deliveries: 3, mode: 'full' }))).toBe('Engineering sends a summary and a copy of each concept. 3 digests have arrived.');
      expect(incomingSentence(link({ state: 'accepted' }))).toMatch(/No digest has arrived yet/);
      expect(incomingSentence(link({ state: 'paused' }))).toMatch(/You paused this/);
      expect(incomingSentence(link({ state: 'revoked', endedReason: 'by_team' }))).toMatch(/This team ended it/);
    });

    it('splits requests from what is received; an ended link with no digests is not a “received from”', () => {
      const all = [link({ id: 'a' as never, state: 'requested' }), link({ id: 'b' as never, state: 'accepted' }), link({ id: 'c' as never, state: 'revoked' }), link({ id: 'd' as never, state: 'revoked', deliveries: 2 })];
      expect(requestedLinks(all).map((l) => l.id)).toEqual(['a']);
      expect(receivedLinks(all).map((l) => l.id)).toEqual(['b', 'd']);
    });

    it('reads the digests another team delivered from the inbox items, newest first', () => {
      expect(digestName('digests/engineering/2026-10-05')).toEqual({ from: 'engineering', period: '2026-10-05' });
      expect(digestName('digests/engineering/2026-10-05-ab12')).toEqual({ from: 'engineering', period: '2026-10-05-ab12' });
      expect(digestName('digests/Engineering/2026-10-05')).toBeNull();
      expect(digestName('Release notes.md')).toBeNull();
      const item = (name: string, at: string, over: Record<string, unknown> = {}) => ({ origin: 'share' as const, name, state: 'filed' as const, createdAt: at, filedPaths: ['memory/shared/team-engineering/a.md', 'memory/shared/team-engineering/b.md'], reason: null, ...over });
      const digests = digestsFrom(
        [
          item('digests/engineering/2026-10-05', '2026-10-05T08:00:00.000Z'),
          item('digests/engineering/2026-09-28', '2026-09-28T08:00:00.000Z', { state: 'held', filedPaths: [], reason: 'A lead has to look at it.' }),
          item('digests/marketing/2026-10-01', '2026-10-01T08:00:00.000Z'),
          item('digests/engineering/2026-10-06', '2026-10-06T08:00:00.000Z', { origin: 'person' }),
        ],
        'engineering',
      );
      expect(digests.map((d) => [d.period, d.state, d.concepts])).toEqual([['2026-10-05', 'filed', 2], ['2026-09-28', 'held', 0]]);
      expect(digestStateWords('filed')).toBe('Filed');
      expect(digestStateWords('held')).toBe('Held for a lead');
      expect(conceptsFromTeam([{ fromTeam: 'x' }, { fromTeam: 'y' }, { fromTeam: null }, { fromTeam: 'x' }], 'x')).toBe(2);
    });
  });
});

describe('the New share form and the file it writes', () => {
  const loadYaml = (text: string): unknown => {
    const require = createRequire(new URL('../../../packages/shared/package.json', import.meta.url));
    const { parseDocument } = require('yaml') as {
      parseDocument: (text: string, options: Record<string, unknown>) => { errors: unknown[]; toJS: (options: Record<string, unknown>) => unknown };
    };
    const doc = parseDocument(text, { uniqueKeys: true, version: '1.2', logLevel: 'silent' });
    expect(doc.errors).toEqual([]);
    return doc.toJS({ maxAliasCount: 0 });
  };
  const draft = (patch: Partial<ShareDraft>): ShareDraft => ({ ...emptyDraft(), name: 'Release notes', to: ['marketing'], ...patch });

  it('turns a name into a file name, and lists into entries', () => {
    expect(slugOfName('Release notes for Support & Marketing!')).toBe('release-notes-for-support-marketing');
    expect(slugOfName('  --Ünï--  ')).toBe('n');
    expect(slugOfName('!!!')).toBe('');
    expect(slugOfName('a'.repeat(100))).toHaveLength(63);
    expect(shareFile('release-notes')).toBe('routines/shares/release-notes.yaml');
    expect(splitList('decisions/, playbooks ,\n decisions/ ,,')).toEqual(['decisions/', 'playbooks']);
    expect(proposalTitle(' Notes ')).toBe('Share “Notes” with other teams');
  });

  it('says what is wrong with the form in plain words', () => {
    const taken = new Set(['release-notes']);
    expect(draftProblem(draft({ name: ' ' }), taken)).toBe('Give the share a name.');
    expect(draftProblem(draft({ name: '!!!' }), taken)).toBe('Use letters or digits in the name.');
    expect(draftProblem(draft({}), taken)).toMatch(/already exists/);
    expect(draftProblem(draft({ name: 'Another', to: [] }), taken)).toBe('Choose at least one team to send to.');
    expect(draftProblem(draft({ name: 'Another', schedule: 'custom', cron: '' }), taken)).toMatch(/Write the schedule/);
    expect(draftProblem(draft({ name: 'Another', schedule: 'custom', cron: 'every monday' }), taken)).toMatch(/not understood/);
    expect(draftProblem(draft({ name: 'Another', paths: '../secrets/' }), taken)).toMatch(/without "\.\."/);
    expect(draftProblem(draft({ name: 'Another' }), taken)).toBeNull();
    expect(draftProblem(draft({ name: 'Another', schedule: 'custom', cron: '0 6 * * 1-5' }), taken)).toBeNull();
  });

  it('the file a form writes is the definition the platform loads, for every choice the form has', () => {
    const forms: ShareDraft[] = [
      draft({}),
      draft({ name: 'Playbooks & "decisions": a test', to: ['marketing', 'customer-support'], paths: 'memory/decisions/, playbooks', types: 'Decision, Playbook', tags: 'release, customer-impact', minTrust: 'human-reviewed', skipStale: false, mode: 'full', schedule: 'weekly', approval: 'auto' }),
      draft({ name: 'Daily', schedule: 'daily' }),
      draft({ name: 'Own schedule', schedule: 'custom', cron: ' 30 6 * * mon-fri ' }),
      draft({ name: 'Quotes: #hash \\ and éè text', tags: 'a: b, #c' }),
    ];
    for (const f of forms) {
      const def = draftToDefinition(f);
      expect(ShareDefinition.parse(def)).toEqual(def);
      expect(ShareDefinition.parse(loadYaml(definitionYaml(def)))).toEqual(def);
    }
  });

  it('writes the plain form of a simple share', () => {
    expect(definitionYaml(draftToDefinition(draft({ paths: 'decisions/', schedule: 'weekly' })))).toBe(
      ['name: "Release notes"', 'to: [marketing]', 'select:', '  paths: ["decisions/"]', '  minTrust: unverified', '  skipStale: true', 'mode: summary', 'when: { cron: "0 8 * * 1" }', 'approval: review', 'approvers: [role:lead]', ''].join('\n'),
    );
    expect(definitionYaml(draftToDefinition(draft({})))).toContain('when: manual');
    expect(SCHEDULES.map((s) => s.id)).toEqual(['manual', 'daily', 'weekly', 'custom']);
  });

  it('a name cannot add a line to the file', () => {
    const def = draftToDefinition(draft({ name: 'Notes"\nto: [everyone]\napproval: auto' }));
    const loaded = ShareDefinition.parse(loadYaml(definitionYaml(def)));
    expect(loaded.name).toBe('Notes"\nto: [everyone]\napproval: auto');
    expect(loaded.to).toEqual(['marketing']);
    expect(loaded.approval).toBe('review');
  });
});

describe('the Approvals card for a share', () => {
  const accept = {
    from: 'Marketing',
    share: 'Campaign calendar',
    mode: 'full',
    select: { paths: ['campaigns/'], types: ['Plan'], minTrust: 'machine-confirmed', skipStale: true },
    when: { cron: '0 8 * * 1' },
    approval: 'review',
  };
  const digest = {
    share: 'Release notes',
    from: 'Engineering',
    to: [{ team: 'Support', link: 'accepted' }, { team: 'Marketing', link: 'paused' }],
    mode: 'summary',
    period: '2026-10-05',
    counts: { matched: 12, included: 3, leftOut: 3, unchanged: 6, retired: 1, redacted: 1 },
    included: [{ path: 'decisions/a', title: 'Upgrade test' }, { path: 'decisions/b', title: '' }],
    excluded: [{ path: 'people/x', title: 'The release captain', reason: 'personal' }, { path: 'p/y', title: 'Old', reason: 'stale' }, { path: 'p/z', title: 'Older', reason: 'stale' }, { path: 'q', title: 'Q', reason: 'mystery' }],
    diff: { added: [{ path: 'a', title: 'A' }], changed: [], retired: [{ path: 'o', title: 'o' }], unchanged: 6 },
    more: { included: 0, excluded: 2 },
  };

  it('knows the two sharing tools and no others', () => {
    expect(isShareApproval({ tool: MEMORY_SHARE_ACCEPT_TOOL })).toBe(true);
    expect(isShareApproval({ tool: MEMORY_DIGEST_SEND_TOOL })).toBe(true);
    expect(isShareApproval({ tool: 'email.send' })).toBe(false);
    expect(shareKind(MEMORY_SHARE_ACCEPT_TOOL)).toBe('Memory sharing · request to receive');
    expect(shareKind(MEMORY_DIGEST_SEND_TOOL)).toBe('Memory sharing · digest to send');
    expect(approvalRowLabel({ tool: MEMORY_DIGEST_SEND_TOOL, botName: null })).toBe('Memory sharing · digest to send');
    expect(approvalRowLabel({ tool: 'email.send', botName: 'Support responder' })).toBe('Support responder · email.send');
    expect(approvalRowLabel({ tool: 'email.send', botName: null })).toBe('email.send');
  });

  it('reads a request to receive: who it is from, what it picks, how often, and who approves', () => {
    const view = acceptView(accept);
    expect(Object.fromEntries(view.rows.map((r) => [r.label, r.value]))).toEqual({
      From: 'Marketing',
      Share: 'Campaign calendar',
      'It sends': 'a summary and a copy of each concept',
      'It picks': 'folders campaigns/ · kinds Plan · only concepts a check has confirmed · skips what is out of date',
      'How often': 'Every Monday at 08:00 UTC',
      'Before it goes': 'A lead of the sending team approves each digest',
    });
    expect(view.note).toMatch(/cannot decide a request you wrote yourself/);
    expect(selectWords({})).toBe('All of the team’s memory that may be shared · skips what is out of date');
    expect(selectWords({ skipStale: false })).toBe('All of the team’s memory that may be shared');
    expect(selectWords(null)).toBe('All of the team’s memory that may be shared');
    expect(acceptView({ ...accept, when: 'manual' }).rows.find((r) => r.label === 'How often')?.value).toBe('Only when someone presses Run now');
    expect(acceptView({}).rows.map((r) => r.label)).toEqual(['From', 'It sends', 'It picks', 'How often', 'Before it goes']);
  });

  it('reads a digest waiting to go: where, how much, what is left out and why, and what changed', () => {
    const view = digestView(digest);
    expect(view.to).toEqual([{ team: 'Support', link: 'accepted' }, { team: 'Marketing', link: 'paused' }]);
    expect(view.headline).toBe('Matches 12 concepts · 3 left out');
    expect(view.counts).toBe('3 new or updated · 6 unchanged · 1 concept had private details covered up');
    expect(view.included).toEqual(['Upgrade test', 'decisions/b']);
    expect(view.leftOut[0]).toEqual({ words: 'it is out of date', titles: ['Old', 'Older'] });
    expect(view.leftOut.map((g) => g.words)).toContain('it may not leave the team');
    expect(view.diff).toBe('1 new, 1 retired · 6 unchanged');
    expect(view.more).toBe('and 2 more not listed here');
    expect(view.mode).toBe('a short summary only');
    expect(digestView({}).to).toEqual([]);
    expect(digestView({}).diff).toBe('Nothing new');
  });

  it('puts its own words on the outcome, not a bot’s', () => {
    const line = (tool: string, status: 'approved' | 'denied' | 'expired', outcome: 'ran' | 'failed' | 'none' = 'ran') => shareOutcomeLine({ tool, status, outcome, outcomeDetail: 'the team is archived' });
    expect(line(MEMORY_SHARE_ACCEPT_TOOL, 'approved')).toMatch(/Accepted\. The sending team can now send/);
    expect(line(MEMORY_SHARE_ACCEPT_TOOL, 'denied', 'none')).toMatch(/Declined/);
    expect(line(MEMORY_SHARE_ACCEPT_TOOL, 'expired', 'none')).toMatch(/lapsed/);
    expect(line(MEMORY_DIGEST_SEND_TOOL, 'approved')).toMatch(/goes to each team that accepted it/);
    expect(line(MEMORY_DIGEST_SEND_TOOL, 'denied', 'none')).toMatch(/not sent/);
    expect(line(MEMORY_DIGEST_SEND_TOOL, 'approved', 'failed')).toBe('Approved, but it did not go through: the team is archived');
  });
});

describe('the Memory tabs and the workspace switch', () => {
  it('opens the tab the address names, and the concepts when a concept is linked', () => {
    expect(TABS.map((t) => t.label)).toEqual(['Concepts', 'Inbox', 'Sharing']);
    expect(tabFromParams('sharing', null)).toBe('sharing');
    expect(tabFromParams('inbox', null)).toBe('inbox');
    expect(tabFromParams('sharing', 'memory/facts/a.md')).toBe('concepts');
    expect(tabFromParams('nonsense', null)).toBe('concepts');
    expect(tabFromParams(null, null)).toBe('concepts');
  });

  it('moves between tabs with the arrow keys, wrapping, and with Home and End', () => {
    expect(nextTab('concepts', 'ArrowRight')).toBe('inbox');
    expect(nextTab('inbox', 'ArrowRight')).toBe('sharing');
    expect(nextTab('sharing', 'ArrowRight')).toBe('concepts');
    expect(nextTab('concepts', 'ArrowLeft')).toBe('sharing');
    expect(nextTab('sharing', 'Home')).toBe('concepts');
    expect(nextTab('concepts', 'End')).toBe('sharing');
    expect(nextTab('concepts', 'Enter')).toBeNull();
    expect(nextTab('concepts', 'a')).toBeNull();
  });

  it('words the switch both ways', () => {
    expect(switchWords(true).state).toBe('on');
    expect(switchWords(false).state).toBe('off');
    expect(switchWords(false).done).toMatch(/Nothing will be sent or received/);
    expect(switchWords(true).help).toMatch(/only after a lead approves it/);
  });
});

describe('a request is held up front when the person cannot answer it', () => {
  const as = (who: string) => setTransport(createMockTransport({ latencyMs: 0, as: who }));
  const request = (over: Partial<ShareIncoming> = {}): ShareIncoming =>
    ShareIncoming.parse({
      id: LINK, shareId: LINK, fromTeamId: LINK, fromSlug: 'engineering', fromName: 'Engineering', shareName: 'Release notes', mode: 'summary', state: 'requested',
      endedReason: null, approvalId: APPROVAL, requestedAt: '2026-10-01T08:00:00.000Z', acceptedAt: null, lastDeliveredAt: null, deliveries: 0, ...over,
    });
  const card = (props: { askedByMe?: boolean; sharingOn?: boolean; canManage?: boolean; link?: ShareIncoming }): string =>
    renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(IncomingCard, { slug: 'marketing', link: props.link ?? request(), canManage: props.canManage ?? true, onChanged: () => undefined, ...props })),
    );
  const button = (html: string, id: string): string => new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? '';

  it('says why, in the person’s words', () => {
    expect(ASKED_BY_YOU_WHY).toBe('You asked for this, so someone else has to decide it.');
    expect(requestHold({ sharingOn: true, askedByMe: true })).toBe(ASKED_BY_YOU_WHY);
    expect(requestHold({ sharingOn: false, askedByMe: false })).toBe(SHARING_OFF_WHY);
    expect(requestHold({ sharingOn: false, askedByMe: true })).toBe(ASKED_BY_YOU_WHY);
    expect(requestHold({ sharingOn: true, askedByMe: false })).toBeNull();
  });

  it('reads the requests this person filed from the waiting Approvals rows', () => {
    const rows = [
      { id: 'a', canDecide: false, blockReason: 'requester' },
      { id: 'b', canDecide: false, blockReason: 'not_approver' },
      { id: 'c', canDecide: true, blockReason: null },
    ];
    expect([...askedByMeIds(rows)]).toEqual(['a']);
  });

  it('disables Accept and Decline with the reason when the person filed the request themself', () => {
    const out = card({ askedByMe: true });
    expect(out).toContain('data-testid="incoming-hold"');
    expect(out).toContain(ASKED_BY_YOU_WHY);
    for (const id of ['incoming-accept', 'incoming-decline']) {
      expect(button(out, id)).toContain('disabled=""');
      expect(button(out, id)).toContain('aria-describedby=');
    }
  });

  it('disables them with the reason while workspace sharing is off', () => {
    const out = card({ sharingOn: false });
    expect(out).toContain(SHARING_OFF_WHY);
    expect(button(out, 'incoming-accept')).toContain('disabled=""');
    expect(button(out, 'incoming-decline')).toContain('disabled=""');
  });

  it('leaves them live for a lead when nothing holds the request', () => {
    const out = card({});
    expect(out).not.toContain('data-testid="incoming-hold"');
    expect(button(out, 'incoming-accept')).not.toContain('disabled');
    expect(button(out, 'incoming-decline')).not.toContain('disabled');
  });

  it('does not hold the buttons of a share that is already open', () => {
    const out = card({ link: request({ state: 'accepted', approvalId: null }), sharingOn: false });
    expect(out).not.toContain('data-testid="incoming-hold"');
    expect(button(out, 'incoming-pause')).not.toContain('disabled');
  });

  it('the mock marks the request the person filed as theirs, and not the one filed by another', async () => {
    as('omar');
    const mine = (await fetchApprovals('marketing', 'pending')).items;
    expect(askedByMeIds(mine).size).toBe(1);
    expect(mine[0]).toMatchObject({ canDecide: false, blockReason: 'requester' });
    const incoming = (await fetchIncomingShares('marketing')).incoming.find((l) => l.fromSlug === 'engineering');
    expect(askedByMeIds(mine).has(incoming?.approvalId ?? '')).toBe(true);
    as('tariq');
    const theirs = (await fetchApprovals('marketing', 'pending')).items;
    expect(theirs[0]).toMatchObject({ canDecide: true, blockReason: null });
    expect(askedByMeIds(theirs).size).toBe(0);
  });
});
