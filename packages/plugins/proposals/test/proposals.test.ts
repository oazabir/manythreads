import { randomUUID } from 'node:crypto';
import { eventToRaw } from '@manythreads/kernel';
import { parseEvent, ProposalsProposalAppliedEvent, ProposalsProposalCreatedEvent, ProposalsProposalRejectedEvent, type ProposalDetail } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// Proposals (PLAN P7-01): a change to bots/, TEAM.md, skills/ or routines/ is a proposal; a lead or admin applies it and the commit is theirs.
// Personas: Omar is Engineering's lead and the workspace admin; Nadia, Rafi and Priya are Engineering members; Tariq leads Marketing (no admin right).

const { omar, nadia, priya, tariq, lena } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

type Who = typeof omar;
const text = (n: number, tag = 'a'): string => `# Team ${tag}\n\nLine ${n}\n`;
const botMd = (name: string): string => `---
schema: 1
name: ${name}
role: Answers questions in the proposals tests
kind: agent
runtime: hermes
triggers:
  - type: mention
capabilities:
  native: [messages.post]
---

# ${name}

Soul text.
`;

const propose = (who: Who, team: string, body: Record<string, unknown>) =>
  w.call<{ proposal: ProposalDetail; error?: { code: string; message: string } }>(who, 'POST', `/api/teams/${team}/proposals`, body);
const view = async (who: Who, team: string, id: string): Promise<ProposalDetail> => {
  const res = await w.call<{ proposal: ProposalDetail }>(who, 'GET', `/api/teams/${team}/proposals/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.proposal;
};
const act = (who: Who, team: string, id: string, verb: 'approve' | 'reject' | 'withdraw', body: Record<string, unknown> = {}) =>
  w.call<{ proposal: ProposalDetail; error?: { code: string; message: string } }>(who, 'POST', `/api/teams/${team}/proposals/${id}/${verb}`, body);
const blobOf = async (team: string, path: string): Promise<{ content: string; blobSha: string } | null> => {
  const res = await w.call<{ content: string; blobSha: string }>(omar, 'GET', `/api/teams/${team}/repo/blob?path=${encodeURIComponent(path)}`);
  return res.status === 200 ? res.body : null;
};
/** Stored events of one type, rebuilt and parsed (they were validated on the way in); the schema argument only types the result. */
const eventsOf = <T>(type: string, schema: { parse(v: unknown): T }): Promise<T[]> =>
  w.system(async (tx) => {
    const res = await tx.query<{ type: string; schema_version: number; workspace_id: string; payload: Record<string, unknown> }>(
      'SELECT type, schema_version, workspace_id, payload FROM app.events WHERE type = $1 ORDER BY id',
      [type],
    );
    return res.rows.map((row) => schema.parse(parseEvent(eventToRaw(row))));
  });

describe('making a proposal', () => {
  it('a member proposes a change to TEAM.md; it is open with a diff, and the file is untouched', async () => {
    const before = await blobOf('engineering', 'TEAM.md');
    const res = await propose(priya, 'engineering', { path: 'TEAM.md', content: text(1), title: 'Say what we do', note: 'Short and plain' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const p = res.body.proposal;
    expect(p.proposal).toMatchObject({ path: 'TEAM.md', op: 'put', status: 'open', title: 'Say what we do', note: 'Short and plain', authorKind: 'person', authorName: 'Priya', selfApplied: false });
    expect(p.proposal.diff).toContain('--- a/TEAM.md');
    expect(p.proposal.diff).toContain('+Line 1');
    expect(p.proposal.added).toBeGreaterThan(0);
    expect(p.proposal.baseBlobSha).toBe(before?.blobSha);
    expect(p.stale).toBe(false);
    expect(p.canApply).toBe(false);
    expect(p.cannotApplyReason).toMatch(/team lead or a workspace admin/);
    expect(p.canWithdraw).toBe(true);
    expect((await blobOf('engineering', 'TEAM.md'))?.blobSha).toBe(before?.blobSha);
    const created = (await eventsOf('proposals.proposal.created', ProposalsProposalCreatedEvent)).find((e) => e.proposalId === p.proposal.id);
    expect(created).toMatchObject({ path: 'TEAM.md', authorKind: 'person', checksOk: true });
  });

  it('refuses a direct commit to the four places, for a member and for a lead', async () => {
    for (const who of [priya, omar]) {
      const res = await w.call<{ error: { message: string } }>(who, 'POST', '/api/teams/engineering/repo/commit', { changes: [{ op: 'put', path: 'skills/x/SKILL.md', content: 'x' }], message: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/Propose the change/);
    }
  });

  it('only the four places go through proposals; other files, bad paths, empty changes and guests are refused', async () => {
    expect((await propose(priya, 'engineering', { path: 'pages/a.md', content: 'x' })).status).toBe(400);
    expect((await propose(priya, 'engineering', { path: 'skills/../pages/a.md', content: 'x' })).status).toBe(400);
    expect((await propose(priya, 'engineering', { path: 'TEAM.md' })).status).toBe(400);
    const same = (await blobOf('engineering', 'TEAM.md'))!.content;
    const noop = await propose(priya, 'engineering', { path: 'TEAM.md', content: same });
    expect(noop.status).toBe(400);
    expect(noop.body.error?.message).toMatch(/does not change the file/);
    expect((await propose(lena, 'engineering', { path: 'TEAM.md', content: 'x' })).status).toBe(403);
    expect((await propose(tariq, 'engineering', { path: 'TEAM.md', content: 'x' })).status).toBe(403);
    expect((await propose(priya, 'engineering', { path: 'TEAM.md', content: 'a\0b' })).status).toBe(422);
    expect((await propose(priya, 'engineering', { path: 'skills/gone.md', op: 'delete' })).status).toBe(404);
  });

  it('a base the author names must still be current', async () => {
    const res = await propose(priya, 'engineering', { path: 'TEAM.md', content: text(2), baseBlobSha: 'a'.repeat(40) });
    expect(res.status).toBe(409);
    const exists = await propose(priya, 'engineering', { path: 'TEAM.md', content: text(2), baseBlobSha: null });
    expect(exists.status).toBe(409);
    expect(exists.body.error?.message).toMatch(/already exists/);
  });
});

describe('applying', () => {
  it('a lead applies a member’s proposal: the commit is the lead’s, the author is a co-author, the proposal records it', async () => {
    const made = await propose(priya, 'engineering', { path: 'skills/review/SKILL.md', content: '# Review\n\nRead the diff first.\n', title: 'A review skill' });
    expect(made.status).toBe(201);
    const id = made.body.proposal.proposal.id;
    expect(made.body.proposal.proposal.baseBlobSha).toBeNull();
    const res = await act(omar, 'engineering', id, 'approve', { note: 'Good' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const done = res.body.proposal.proposal;
    expect(done).toMatchObject({ status: 'applied', decidedByName: 'Omar', decisionNote: 'Good', selfApplied: false });
    expect(done.appliedCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect((await blobOf('engineering', 'skills/review/SKILL.md'))?.content).toContain('Read the diff first');
    const history = await w.call<{ commits: Array<{ sha: string; authorId: string; coAuthorIds: string[]; subject: string }> }>(omar, 'GET', '/api/teams/engineering/repo/history?path=skills%2Freview%2FSKILL.md');
    const commit = history.body.commits.find((c) => c.sha === done.appliedCommitSha);
    expect(commit).toMatchObject({ authorId: omar.actorId, subject: 'A review skill' });
    expect(commit?.coAuthorIds).toContain(priya.actorId);
    const applied = (await eventsOf('proposals.proposal.applied', ProposalsProposalAppliedEvent)).find((e) => e.proposalId === id);
    expect(applied).toMatchObject({ actorId: omar.actorId, authorId: priya.actorId, selfApplied: false, commitSha: done.appliedCommitSha });
    // applied once: the second time says so
    const again = await act(omar, 'engineering', id, 'approve');
    expect(again.status).toBe(403);
    expect(again.body.error?.message).toMatch(/already applied/);
  });

  it('a member cannot apply; a lead of another team cannot apply; a bot-style direct database apply is refused', async () => {
    const made = await propose(priya, 'engineering', { path: 'routines/daily.md', content: '# Daily\n' });
    const id = made.body.proposal.proposal.id;
    expect((await act(nadia, 'engineering', id, 'approve')).status).toBe(403);
    expect((await act(priya, 'engineering', id, 'approve')).status).toBe(403);
    // Tariq leads Marketing only: Engineering's proposal is not even visible to him
    expect((await act(tariq, 'engineering', id, 'approve')).status).toBe(403);
    expect((await w.call(tariq, 'GET', `/api/teams/engineering/proposals/${id}`)).status).toBe(403);
    expect((await view(omar, 'engineering', id)).proposal.status).toBe('open');
  });

  it('refuses when the file moved since, shows why, and applies nothing', async () => {
    const first = await propose(priya, 'engineering', { path: 'skills/moved/SKILL.md', content: '# One\n' });
    const second = await propose(nadia, 'engineering', { path: 'skills/moved/SKILL.md', content: '# Two\n' });
    expect((await act(omar, 'engineering', first.body.proposal.proposal.id, 'approve')).status).toBe(200);
    const res = await act(omar, 'engineering', second.body.proposal.proposal.id, 'approve');
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toMatch(/has been added since this proposal was made/);
    const seen = await view(omar, 'engineering', second.body.proposal.proposal.id);
    expect(seen).toMatchObject({ stale: true, canApply: false });
    expect(seen.staleReason).toMatch(/skills\/moved\/SKILL\.md/);
    expect((await blobOf('engineering', 'skills/moved/SKILL.md'))?.content).toBe('# One\n');
    // a changed (not added) file says "changed"
    const third = await propose(nadia, 'engineering', { path: 'skills/moved/SKILL.md', content: '# Three\n' });
    expect((await propose(omar, 'engineering', { path: 'skills/moved/SKILL.md', content: '# Four\n', applyNow: true })).status).toBe(201);
    const late = await act(omar, 'engineering', third.body.proposal.proposal.id, 'approve');
    expect(late.status).toBe(409);
    expect(late.body.error?.message).toMatch(/has changed since this proposal was made/);
  });

  it('a bot definition is checked with the loader’s reader: an invalid BOT.md is recorded with its error and cannot be applied', async () => {
    const bad = await propose(priya, 'engineering', { path: 'bots/checked/BOT.md', content: '# no frontmatter\n' });
    expect(bad.status).toBe(201);
    const p = bad.body.proposal;
    expect(p.proposal.checks).toEqual([expect.objectContaining({ name: 'BOT.md loads', ok: false, message: expect.stringContaining('BOT.md must open with a --- frontmatter block') })]);
    const asLead = await view(omar, 'engineering', p.proposal.id);
    expect(asLead.canApply).toBe(false);
    expect(asLead.cannotApplyReason).toMatch(/A check failed/);
    const res = await act(omar, 'engineering', p.proposal.id, 'approve');
    expect(res.status).toBe(422);
    expect(res.body.error?.message).toContain('BOT.md must open with a --- frontmatter block');
    expect(await blobOf('engineering', 'bots/checked/BOT.md')).toBeNull();
    const created = (await eventsOf('proposals.proposal.created', ProposalsProposalCreatedEvent)).find((e) => e.proposalId === p.proposal.id);
    expect(created?.checksOk).toBe(false);
    // propose-and-apply of an invalid file records nothing at all
    const before = (await w.call<{ proposals: unknown[] }>(omar, 'GET', '/api/teams/engineering/proposals')).body.proposals.length;
    const quick = await propose(omar, 'engineering', { path: 'bots/checked/BOT.md', content: 'nope', applyNow: true });
    expect(quick.status).toBe(422);
    expect((await w.call<{ proposals: unknown[] }>(omar, 'GET', '/api/teams/engineering/proposals')).body.proposals.length).toBe(before);
    // a slug the loader would refuse
    const slug = await propose(priya, 'engineering', { path: 'bots/Bad Slug/BOT.md', content: botMd('x') });
    expect(slug.body.proposal.proposal.checks[0]).toMatchObject({ ok: false, message: expect.stringContaining('lowercase slug') });
  });

  it('adding a bot is a workspace admin’s: a lead who is not an admin cannot apply it, an admin can; a lead can change a bot that exists', async () => {
    // Marketing: Tariq leads, Omar is the workspace admin
    const add = await propose(tariq, 'marketing', { path: 'bots/newcomer/BOT.md', content: botMd('Newcomer') });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const id = add.body.proposal.proposal.id;
    expect(add.body.proposal.proposal.checks[0]).toMatchObject({ ok: true });
    const asTariq = await view(tariq, 'marketing', id);
    expect(asTariq.canApply).toBe(false);
    expect(asTariq.cannotApplyReason).toMatch(/workspace admin/);
    expect((await act(tariq, 'marketing', id, 'approve')).status).toBe(403);
    const asOmar = await view(omar, 'marketing', id);
    expect(asOmar.canApply).toBe(true);
    expect((await act(omar, 'marketing', id, 'approve')).status).toBe(200);
    expect((await blobOf('marketing', 'bots/newcomer/BOT.md'))?.content).toContain('name: Newcomer');
    // now it exists: its lead changes it without an admin
    const edit = await propose(priya, 'marketing', { path: 'bots/newcomer/BOT.md', content: botMd('Newcomer Two') });
    expect(edit.status).toBe(201);
    const ok = await act(tariq, 'marketing', edit.body.proposal.proposal.id, 'approve');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // removing it is an admin's again
    const rm = await propose(tariq, 'marketing', { path: 'bots/newcomer/BOT.md', op: 'delete' });
    expect(rm.status).toBe(201);
    expect((await act(tariq, 'marketing', rm.body.proposal.proposal.id, 'approve')).status).toBe(403);
    expect((await act(omar, 'marketing', rm.body.proposal.proposal.id, 'approve')).status).toBe(200);
    expect(await blobOf('marketing', 'bots/newcomer/BOT.md')).toBeNull();
  });
});

describe('the author and the approver', () => {
  it('a lead cannot apply a proposal they saved for review while another lead or admin could; propose-and-apply stays open to them', async () => {
    // Marketing: Tariq (lead) saves it for review; Omar (admin) is another eligible approver
    const saved = await propose(tariq, 'marketing', { path: 'TEAM.md', content: text(3, 'mkt') });
    expect(saved.status).toBe(201);
    const id = saved.body.proposal.proposal.id;
    const mine = await view(tariq, 'marketing', id);
    expect(mine).toMatchObject({ canApply: false, canWithdraw: true, canReject: false });
    expect(mine.cannotApplyReason).toMatch(/another team lead or workspace admin/);
    const refused = await act(tariq, 'marketing', id, 'approve');
    expect(refused.status).toBe(403);
    expect((await act(omar, 'marketing', id, 'approve')).status).toBe(200);
    // the explicit one-step path records that the author applied it
    const quick = await propose(tariq, 'marketing', { path: 'TEAM.md', content: text(4, 'mkt'), applyNow: true });
    expect(quick.status).toBe(201);
    expect(quick.body.proposal.proposal).toMatchObject({ status: 'applied', selfApplied: true, decidedByName: 'Tariq' });
  });

  it('the only eligible approver may apply their own saved proposal; a second lead takes that away', async () => {
    // Engineering: Omar is the only lead and the only admin
    const saved = await propose(omar, 'engineering', { path: 'routines/solo.md', content: '# Solo\n' });
    const id = saved.body.proposal.proposal.id;
    expect((await view(omar, 'engineering', id)).canApply).toBe(true);
    const another = await propose(omar, 'engineering', { path: 'routines/solo2.md', content: '# Solo 2\n' });
    // Nadia becomes a second lead
    await w.system((tx) => tx.query("UPDATE app.team_members SET role = 'lead' WHERE team_id = $1 AND actor_id = $2", [TEAM_IDS.Engineering, nadia.actorId]));
    try {
      const v = await view(omar, 'engineering', another.body.proposal.proposal.id);
      expect(v.canApply).toBe(false);
      expect((await act(omar, 'engineering', another.body.proposal.proposal.id, 'approve')).status).toBe(403);
      // Nadia, now a lead, applies Omar's
      expect((await act(nadia, 'engineering', another.body.proposal.proposal.id, 'approve')).status).toBe(200);
    } finally {
      await w.system((tx) => tx.query("UPDATE app.team_members SET role = 'member' WHERE team_id = $1 AND actor_id = $2", [TEAM_IDS.Engineering, nadia.actorId]));
    }
    expect((await act(omar, 'engineering', id, 'approve')).status).toBe(200);
  });

  it('a member cannot propose-and-apply', async () => {
    const res = await propose(priya, 'engineering', { path: 'TEAM.md', content: text(9), applyNow: true });
    expect(res.status).toBe(403);
  });
});

describe('rejecting and withdrawing', () => {
  it('a lead rejects with a note; the author withdraws their own; nobody else can; nothing is committed', async () => {
    const a = await propose(priya, 'engineering', { path: 'skills/no/SKILL.md', content: '# No\n' });
    const b = await propose(priya, 'engineering', { path: 'skills/withdrawn/SKILL.md', content: '# W\n' });
    const idA = a.body.proposal.proposal.id;
    const idB = b.body.proposal.proposal.id;
    expect((await act(nadia, 'engineering', idA, 'reject')).status).toBe(403);
    expect((await act(omar, 'engineering', idB, 'withdraw')).status).toBe(403);
    const rejected = await act(omar, 'engineering', idA, 'reject', { note: 'Not now' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.proposal.proposal).toMatchObject({ status: 'rejected', decisionNote: 'Not now', decidedByName: 'Omar' });
    const gone = await act(priya, 'engineering', idB, 'withdraw');
    expect(gone.status).toBe(200);
    expect(gone.body.proposal.proposal.status).toBe('withdrawn');
    expect(await blobOf('engineering', 'skills/no/SKILL.md')).toBeNull();
    expect((await act(omar, 'engineering', idA, 'approve')).status).toBe(403);
    const evs = await eventsOf('proposals.proposal.rejected', ProposalsProposalRejectedEvent);
    expect(evs.find((e) => e.proposalId === idA)).toMatchObject({ reason: 'rejected', actorId: omar.actorId });
    expect(evs.find((e) => e.proposalId === idB)).toMatchObject({ reason: 'withdrawn', actorId: priya.actorId });
  });
});

describe('two decisions at once', () => {
  it('an apply racing a decline ends one way: the file and the proposal agree', async () => {
    for (let round = 0; round < 3; round += 1) {
      const path = `skills/race-${round}/SKILL.md`;
      const made = await propose(priya, 'engineering', { path, content: `# Race ${round}\n` });
      const id = made.body.proposal.proposal.id;
      const [apply, reject] = await Promise.all([act(omar, 'engineering', id, 'approve'), act(omar, 'engineering', id, 'reject')]);
      const status = (await view(omar, 'engineering', id)).proposal.status;
      // exactly one of the two won; the proposal says what happened to the file
      expect([apply.status === 200, reject.status === 200].filter(Boolean)).toHaveLength(1);
      if (status === 'applied') expect(await blobOf('engineering', path)).not.toBeNull();
      else {
        expect(status).toBe('rejected');
        expect(await blobOf('engineering', path)).toBeNull();
      }
    }
  });

  it('a double click on Apply commits once', async () => {
    const path = 'skills/double/SKILL.md';
    const made = await propose(priya, 'engineering', { path, content: '# Double\n' });
    const id = made.body.proposal.proposal.id;
    const both = await Promise.all([act(omar, 'engineering', id, 'approve'), act(omar, 'engineering', id, 'approve')]);
    expect(both.filter((r) => r.status === 200)).toHaveLength(1);
    const history = await w.call<{ commits: Array<{ sha: string }> }>(omar, 'GET', `/api/teams/engineering/repo/history?path=${encodeURIComponent(path)}`);
    expect(history.body.commits).toHaveLength(1);
  });
});

describe('the list', () => {
  it('lists the open ones first, filters by status and path, counts the open ones, and shows a team only its own', async () => {
    await propose(priya, 'engineering', { path: 'skills/listed/SKILL.md', content: '# L\n' });
    const all = await w.call<{ proposals: Array<{ status: string; path: string }>; openCount: number }>(omar, 'GET', '/api/teams/engineering/proposals');
    expect(all.status).toBe(200);
    expect(all.body.proposals[0]?.status).toBe('open');
    expect(all.body.openCount).toBe(all.body.proposals.filter((p) => p.status === 'open').length);
    const applied = await w.call<{ proposals: Array<{ status: string }> }>(omar, 'GET', '/api/teams/engineering/proposals?status=applied');
    expect(applied.body.proposals.length).toBeGreaterThan(0);
    expect(applied.body.proposals.every((p) => p.status === 'applied')).toBe(true);
    const byPath = await w.call<{ proposals: Array<{ path: string }> }>(omar, 'GET', '/api/teams/engineering/proposals?path=skills%2Flisted%2FSKILL.md');
    expect(byPath.body.proposals.map((p) => p.path)).toEqual(['skills/listed/SKILL.md']);
    expect((await w.call<{ proposals: unknown[] }>(tariq, 'GET', '/api/teams/marketing/proposals')).body.proposals.every((p) => (p as { teamId: string }).teamId === TEAM_IDS.Marketing)).toBe(true);
    expect((await w.call(tariq, 'GET', '/api/teams/engineering/proposals')).status).toBe(403);
    expect((await w.call(null, 'GET', '/api/teams/engineering/proposals')).status).toBe(401);
    expect((await w.call(omar, 'GET', `/api/teams/engineering/proposals/${randomUUID()}`)).status).toBe(404);
  });
});
