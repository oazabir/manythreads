import { BotDeployRequest, BotDeployResponse, type CreateConnectionResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// P8-34 (server): the bot page's Deploy action on a real server. One request commits the definition, makes the bot's knowledge bases ready and switches on its connection, and
// reports each. What it proves: every check runs before anything is written (a refusal changes nothing); a refusal names the part and what to do; a deploy that changed nothing is
// not a deploy; the commit is the asker's, as a proposal on record; a file someone else changed is not overwritten; only a workspace admin switches a connection on.

const { omar, nadia, tariq } = personas;
vi.setConfig({ testTimeout: 120_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const botMd = (extra = ''): string => `---
schema: 1
name: Desk
role: "Answers the desk's mail from the handbook"
kind: agent
runtime: hermes
triggers:
  - type: mention
capabilities:
  native: [messages.post, knowledge.search]
  connections:
    - name: desk-mail
      tools: [email.read]
knowledge:
  - base: handbook
    answer_only_from: true
---

# Desk

Answer from the handbook only.${extra}
`;

const connectionOnlyMd = `---
schema: 1
name: Quay
role: "Reads the quay mail"
kind: agent
runtime: hermes
triggers:
  - type: mention
capabilities:
  native: [messages.post]
  connections:
    - name: quay-mail
      tools: [email.read]
---

# Quay

Read the mail.
`;

type Who = typeof omar;
const deploy = (who: Who, team: string, bot: string, body: Record<string, unknown> = {}) =>
  w.call<BotDeployResponse & { error?: { message: string } }>(who, 'POST', `/api/teams/${team}/bots/${bot}/deploy`, body);
const blobOf = async (team: string, path: string): Promise<{ content: string; blobSha: string } | null> => {
  const res = await w.call<{ content: string; blobSha: string }>(omar, 'GET', `/api/teams/${team}/repo/blob?path=${encodeURIComponent(path)}`);
  return res.status === 200 ? res.body : null;
};
const statusOf = async (id: string): Promise<string> =>
  w.system(async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.connections WHERE id = $1::uuid', [id])).rows[0]!.status);
const states = (r: BotDeployResponse): string[] => r.outcomes.map((o) => `${o.step}:${o.state}`);
const makeBot = async (team: string, slug: string, content: string): Promise<void> => {
  const made = await w.commit(omar, team, [{ op: 'put', path: `bots/${slug}/BOT.md`, content }], `Bot ${slug} for the deploy tests`);
  expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
  await vi.waitFor(async () => expect((await w.call(omar, 'GET', `/api/teams/${team}/bots/${slug}`)).status).toBe(200), { timeout: 30_000, interval: 250 });
};
const makeConnection = async (team: string, slug: string): Promise<string> => {
  const res = await w.call<CreateConnectionResponse>(omar, 'POST', `/api/teams/${team}/connections`, { kind: 'email', name: slug, slug });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.connection.id;
};
const upload = async (name: string, text: string): Promise<number> => {
  const res = await fetch(`${w.server.url}/api/teams/engineering/knowledge/handbook/documents?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: omar.actorId, workspaceId: omar.workspaceId }), 'content-type': 'application/octet-stream' },
    body: Buffer.from(text) as unknown as RequestInit['body'],
  });
  return res.status;
};

describe('the Deploy action', () => {
  let connectionId = '';

  it('is a lead or admin act, on a bot that exists, with a definition that loads', async () => {
    await makeBot('engineering', 'desk', botMd());
    expect((await deploy(nadia, 'engineering', 'desk')).status).toBe(403);
    expect((await w.call(null, 'POST', '/api/teams/engineering/bots/desk/deploy', {})).status).toBe(401);
    expect((await deploy(omar, 'engineering', 'nobody')).status).toBe(404);
    const broken = await deploy(omar, 'engineering', 'desk', { content: 'not a bot file' });
    expect(broken.status).toBe(400);
    expect(broken.body.error?.message).toMatch(/does not load/);
    // the body is strict (checked on the schema: the route allows 10 presses a minute and this file is one person's)
    expect(BotDeployRequest.safeParse({ content: 'x', extra: 1 }).success).toBe(false);
  });

  it('refuses before changing anything when the base and the connection are not there, and says which part and why', async () => {
    const before = await blobOf('engineering', 'bots/desk/BOT.md');
    const res = await deploy(omar, 'engineering', 'desk', { content: botMd('\nMore.'), baseBlobSha: before!.blobSha });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = BotDeployResponse.parse(res.body);
    expect(r.deployed).toBe(false);
    expect(states(r)).toEqual(['definition:not_run', 'knowledge:refused', 'connection:refused']);
    expect(r.outcomes[1]!.message).toMatch(/no knowledge base called/);
    expect(r.outcomes[2]!.message).toMatch(/no connection called/);
    expect(r.summary).toMatch(/nothing was changed/i);
    expect((await blobOf('engineering', 'bots/desk/BOT.md'))!.blobSha).toBe(before!.blobSha);
  });

  it('refuses a base with no documents, and a connection with no credential, each in its own words', async () => {
    expect((await w.call(omar, 'POST', '/api/teams/engineering/knowledge', { slug: 'handbook', name: 'Handbook' })).status).toBe(201);
    connectionId = await makeConnection('engineering', 'desk-mail');
    const r = BotDeployResponse.parse((await deploy(omar, 'engineering', 'desk')).body);
    expect(states(r)).toEqual(['definition:not_run', 'knowledge:refused', 'connection:refused']);
    expect(r.outcomes[1]!.message).toMatch(/no documents yet/);
    expect(r.outcomes[2]!.message).toMatch(/credential/);
    expect(await statusOf(connectionId)).toBe('disabled');
  });

  it('a connection that is ready does not rescue a base that is not: still nothing is switched on', async () => {
    expect((await w.call(omar, 'PUT', `/api/connections/${connectionId}/credentials/password`, { value: 'placeholder-credential-1' })).status).toBe(200);
    const r = BotDeployResponse.parse((await deploy(omar, 'engineering', 'desk')).body);
    expect(states(r)).toEqual(['definition:not_run', 'knowledge:refused', 'connection:not_run']);
    expect(await statusOf(connectionId)).toBe('disabled');
  });

  it('deploys all three: the commit is the asker’s and is kept as a proposal, the base is ready, the connection is on', async () => {
    expect(await upload('Opening hours.md', '# Opening hours\n\nThe desk opens at nine and closes at five.\n')).toBeLessThan(300);
    const before = await blobOf('engineering', 'bots/desk/BOT.md');
    const res = await deploy(omar, 'engineering', 'desk', { content: botMd('\nBe brief.'), baseBlobSha: before!.blobSha });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = BotDeployResponse.parse(res.body);
    expect(r.deployed).toBe(true);
    expect(r.outcomes.map((o) => o.step)).toEqual(['definition', 'knowledge', 'connection']);
    expect(r.outcomes[0]!.state).toBe('changed');
    expect(r.outcomes[2]!.state).toBe('changed');
    expect(['changed', 'unchanged']).toContain(r.outcomes[1]!.state);
    expect(JSON.stringify(r)).not.toContain('placeholder-credential-1');
    expect((await blobOf('engineering', 'bots/desk/BOT.md'))!.content).toContain('Be brief.');
    expect(await statusOf(connectionId)).toBe('enabled');
    const proposals = await w.call<{ proposals: Array<{ title: string; status: string; path: string }> }>(omar, 'GET', '/api/teams/engineering/proposals?status=applied');
    expect(proposals.body.proposals.some((p) => p.title === 'Deploy desk' && p.path === 'bots/desk/BOT.md')).toBe(true);
  });

  it('a deploy that changes nothing says so and is not counted as one', async () => {
    const r = BotDeployResponse.parse((await deploy(omar, 'engineering', 'desk')).body);
    expect(r.deployed).toBe(false);
    expect(states(r)).toEqual(['definition:unchanged', 'knowledge:unchanged', 'connection:unchanged']);
    expect(r.summary).toMatch(/Nothing to deploy/);
  });

  it('a file someone else changed meanwhile is refused, never overwritten', async () => {
    const stale = (await blobOf('engineering', 'bots/desk/BOT.md'))!;
    await w.commit(omar, 'engineering', [{ op: 'put', path: 'bots/desk/BOT.md', content: botMd('\nChanged by someone else.') }], 'Someone else');
    const res = await deploy(omar, 'engineering', 'desk', { content: botMd('\nMine.'), baseBlobSha: stale.blobSha });
    const r = BotDeployResponse.parse(res.body);
    expect(r.deployed).toBe(false);
    expect(r.outcomes[0]!.state).toBe('refused');
    expect(r.outcomes[0]!.message).toMatch(/changed while you were working/);
    expect((await blobOf('engineering', 'bots/desk/BOT.md'))!.content).toContain('Changed by someone else.');
    expect((await blobOf('engineering', 'bots/desk/BOT.md'))!.content).not.toContain('Mine.');
  });
});

describe('the connection is a workspace admin’s to switch on', () => {
  it('a team lead who is not an admin is refused for it, in words, and the connection stays off', async () => {
    await makeBot('marketing', 'quay', connectionOnlyMd);
    const id = await makeConnection('marketing', 'quay-mail');
    expect((await w.call(omar, 'PUT', `/api/connections/${id}/credentials/password`, { value: 'placeholder-credential-2' })).status).toBe(200);
    const r = BotDeployResponse.parse((await deploy(tariq, 'marketing', 'quay')).body);
    expect(r.deployed).toBe(false);
    expect(states(r)).toEqual(['definition:not_run', 'knowledge:not_run', 'connection:refused']);
    expect(r.outcomes[2]!.message).toMatch(/workspace admin/);
    expect(await statusOf(id)).toBe('disabled');
    // the admin can; the base part is not used by this bot
    const doneRes = await deploy(omar, 'marketing', 'quay');
    expect(doneRes.status, JSON.stringify(doneRes.body)).toBe(200);
    const done = BotDeployResponse.parse(doneRes.body);
    expect(states(done)).toEqual(['definition:unchanged', 'knowledge:not_used', 'connection:changed']);
    expect(done.deployed).toBe(true);
    expect(await statusOf(id)).toBe('enabled');
  });
});
