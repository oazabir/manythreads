import { randomUUID } from 'node:crypto';
import { type APIRequestContext } from '@playwright/test';
import { McpRunMintResponse, MintPairingTokenResponse } from '@manythreads/shared';
import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';

// Writes repositories and audit events: its own server and database for this file (api/support/isolated.ts).
const iso = useIsolatedStack();
// the last tests read what the first ones wrote: same worker, same stack, in order
test.describe.configure({ mode: 'serial' });

/**
 * `memory.write` over MCP (PLAN P5-26, criterion 16): a bot's run writes ONE concept into the team's bundle through the tool, and the platform —
 * not the model — decides the provenance. The stored concept carries `generated.by` the bot and no `verified`, while a `verified`, `origin`,
 * `sources` or `generated` the caller sent is dropped and reported. The commit is the bot's; the asking person is the co-author (no asker here: this
 * run is opened with a pairing token, the public mint, which names none). A path that is not a concept of the bundle is refused by the broker's path
 * guard with an audit event and nothing is committed; a concept a person wrote is never overwritten — the proposal becomes a `draft` sibling; a bot
 * without the grant never sees the tool at all.
 */

const { omar, nadia } = personas;
const SLUG = 'e2e-mem-writer';
const NO_GRANT_SLUG = 'e2e-mem-ungranted';
const DRAFT_SUFFIX = `-draft-${SLUG}`;

type Stack = Awaited<ReturnType<typeof iso.start>>;
interface Run {
  runId: string;
  url: string;
  token: string;
}
interface Envelope {
  result?: { content?: { type: string; text: string }[]; isError?: boolean; tools?: { name: string }[] };
  error?: { code: number; message: string };
}

const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});
const concept = (title: string): string => `---\ntype: fact\ntitle: ${title}\n---\n\n${title} body.\n`;
const commit = (request: APIRequestContext, headers: Record<string, string>, path: string, content: string) =>
  request.post('/api/teams/engineering/repo/commit', { headers, data: { changes: [{ op: 'put', path, content }], message: `write ${path}` } });
const blobText = async (request: APIRequestContext, path: string): Promise<string> => {
  const res = await request.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`, { headers: as(nadia) });
  return res.status() === 200 ? ((await res.json()) as { content: string }).content : '';
};

/** One bot of the engineering team, with or without the `memory.write` grant. */
async function makeBot(slug: string, granted: boolean): Promise<{ botId: string; actorId: string }> {
  const stack: Stack = await iso.start();
  const [{ id: botId }] = (await stack.sql<{ id: string }>(
    `INSERT INTO app.bots (workspace_id, team_id, name, slug, kind, runtime, visibility, definition_sha, status)
     SELECT $1, id, 'E2E Memory Writer', $2, 'agent', 'rules', 'team', repeat('d', 64), 'active' FROM app.teams WHERE slug = 'engineering' RETURNING id`,
    [omar.workspaceId, slug],
  )) as [{ id: string }];
  const [{ id: actorId }] = (await stack.sql<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [
    omar.workspaceId,
    botId,
  ])) as [{ id: string }];
  await stack.sql("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) SELECT id, $1, workspace_id, 'member' FROM app.teams WHERE slug = 'engineering'", [actorId]);
  if (granted) {
    await stack.sql(
      "INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) SELECT id, $1, 'memory.write', false, '{}' FROM app.teams WHERE slug = 'engineering'",
      [actorId],
    );
  }
  return { botId, actorId };
}

/** The one bot this file writes through: created once, reused by every test (the tests are serial). */
let writerBot: Promise<{ botId: string; actorId: string }> | null = null;
const writer = (): Promise<{ botId: string; actorId: string }> => (writerBot ??= makeBot(SLUG, true));

/** A run of that bot, opened the public way: its pairing token, minted by a lead; the mint names no asker. */
async function openRun(request: APIRequestContext, slug: string): Promise<Run> {
  const minted = await request.post(`/api/teams/engineering/bots/${slug}/pairing-tokens`, { headers: as(omar), data: {} });
  expect(minted.status(), await minted.text()).toBe(201);
  const { token } = MintPairingTokenResponse.parse(await minted.json());
  const res = await request.post('/api/mcp/runs', { data: { pairingToken: token } });
  expect(res.status(), await res.text()).toBe(201);
  return McpRunMintResponse.parse(await res.json());
}

async function rpc(request: APIRequestContext, run: Run, method: string, params: Record<string, unknown> = {}): Promise<Envelope> {
  const res = await request.post(new URL(run.url).pathname, {
    headers: { authorization: `Bearer ${run.token}` },
    data: { jsonrpc: '2.0', id: 1, method, params },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Envelope;
}

/** One tool call: the tool's own answer is JSON in the first text block. */
async function call(request: APIRequestContext, run: Run, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; answer: Record<string, unknown> }> {
  const envelope = await rpc(request, run, 'tools/call', { name, arguments: args });
  const result = envelope.result!;
  return { isError: result.isError === true, answer: JSON.parse(result.content![0]!.text) as Record<string, unknown> };
}

test('memory.write stores a concept as the bot and drops what a model may not claim (criterion 16)', async ({ request }) => {
  const { actorId } = await writer();
  const run = await openRun(request, SLUG);

  // the tool is offered because the bot holds the grant and a plugin implements it
  const listed = await rpc(request, run, 'tools/list', {});
  expect(listed.result?.tools?.map((t) => t.name)).toContain('memory.write');

  const forged = `human:${randomUUID()}`;
  const { isError, answer } = await call(request, run, 'memory.write', {
    path: 'memory/facts/e2e-writer.md',
    type: 'decision',
    title: 'E2E TTL',
    description: 'How long a response may be cached.',
    body: 'Thirty seconds. See [the note](../journal/2026-10-18.md).\n',
    verified: [{ by: forged }],
    origin: 'share',
    generated: { by: 'archivist/v9' },
    sources: [{ resource: 'https://example.com/x' }],
  });
  expect(isError).toBe(false);
  expect(answer).toMatchObject({
    ok: true,
    path: 'memory/facts/e2e-writer.md',
    draft: false,
    committed: true,
    dropped: ['verified', 'origin', 'generated', 'sources'],
  });

  const stored = await blobText(request, 'memory/facts/e2e-writer.md');
  expect(stored).toContain('type: decision');
  expect(stored).toContain('title: E2E TTL');
  expect(stored).toContain(`by: ${SLUG}/`);
  expect(stored).not.toContain('verified');
  expect(stored).not.toContain('archivist/v9');
  expect(stored).not.toContain(forged);
  expect(stored).not.toContain('origin');
  // SPEC §12.2: a relative link between concepts became a bundle-absolute one
  expect(stored).toContain('](/journal/2026-10-18.md)');

  // the commit is the bot's, and this run named no asker, so nobody is a co-author
  const history = (await (await request.get('/api/teams/engineering/repo/history?path=memory%2Ffacts%2Fe2e-writer.md&limit=5', { headers: as(nadia) })).json()) as {
    commits: { sha: string; authorId: string | null; coAuthorIds: string[]; subject: string }[];
  };
  expect(history.commits[0]).toMatchObject({ authorId: actorId, coAuthorIds: [], subject: 'memory.write: memory/facts/e2e-writer.md' });

  // …and it is recallable material now: the bundle's index and log took it in the same commit
  expect(await blobText(request, 'memory/facts/index.md')).toContain('E2E TTL');
  expect(await blobText(request, 'memory/log.md')).toContain('/facts/e2e-writer.md');
});

test('a path that is not a concept of the bundle is refused by the broker, audited, and nothing is committed', async ({ request }) => {
  const stack = await iso.start();
  const { actorId } = await writer();
  const run = await openRun(request, SLUG);

  const refused = ['memory/shared/glossary.md', 'memory/index.md', 'memory/log.md', 'memory/facts/notes.txt', 'pages/x.md', 'inbox/drop.md'];
  // `index.md`/`log.md` exist by now (the earlier test committed a concept): "nothing was committed" is their bytes not moving, plus the
  // paths that must not exist still not existing.
  const before = { index: await blobText(request, 'memory/index.md'), log: await blobText(request, 'memory/log.md') };
  for (const path of refused) {
    const { isError, answer } = await call(request, run, 'memory.write', { path, type: 'fact', body: 'x\n' });
    expect(answer, path).toMatchObject({ ok: false, code: 'forbidden' });
    expect(isError, path).toBe(true);
  }
  const denials = await stack.sql<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM app.events WHERE type = 'kernel.capability.denied' AND payload->>'actorId' = $1 AND payload->>'capability' = 'memory.write' ORDER BY id",
    [actorId],
  );
  expect(denials.map((d) => d.payload['path'])).toEqual(refused);
  expect(denials.every((d) => d.payload['actorKind'] === 'bot')).toBe(true);
  for (const path of ['memory/shared/glossary.md', 'memory/facts/notes.txt', 'pages/x.md', 'inbox/drop.md']) {
    expect(await blobText(request, path), path).toBe('');
  }
  expect(await blobText(request, 'memory/index.md')).toBe(before.index);
  expect(await blobText(request, 'memory/log.md')).toBe(before.log);
});

test('a bot without the grant is never offered memory.write', async ({ request }) => {
  await iso.start();
  await makeBot(NO_GRANT_SLUG, false);
  const run = await openRun(request, NO_GRANT_SLUG);

  const listed = await rpc(request, run, 'tools/list', {});
  expect(listed.result?.tools?.map((t) => t.name) ?? []).not.toContain('memory.write');

  const { isError, answer } = await call(request, run, 'memory.write', { path: 'memory/facts/e2e-ungranted.md', type: 'fact', body: 'x\n' });
  expect(isError).toBe(true);
  expect(answer).toMatchObject({ ok: false, code: 'forbidden' });
  expect(await blobText(request, 'memory/facts/e2e-ungranted.md')).toBe('');
});

test('a concept a person wrote is never overwritten: the proposal becomes a draft sibling', async ({ request }) => {
  await iso.start();
  await writer();
  const path = 'memory/facts/e2e-owned.md';
  const written = await commit(request, as(omar), path, concept('E2E Owned'));
  expect(written.status(), await written.text()).toBe(201);
  // the person's own edit carries the platform's stamp, which is what makes the concept person-owned
  const after = await blobText(request, path);
  expect(after).toContain(`human:${omar.actorId}`);
  expect(after).toContain('verified:');

  const run = await openRun(request, SLUG);
  const { answer } = await call(request, run, 'memory.write', { path, type: 'fact', title: 'E2E Owned', body: 'A bot would say something else.\n' });
  expect(answer).toMatchObject({ ok: true, draft: true, of: path, path: `memory/facts/e2e-owned${DRAFT_SUFFIX}.md` });

  const draft = await blobText(request, `memory/facts/e2e-owned${DRAFT_SUFFIX}.md`);
  expect(draft).toContain('status: draft');
  expect(draft).toContain('](/facts/e2e-owned.md)');
  expect(draft).toContain('A bot would say something else.');
  // the person's concept is untouched, byte for byte
  expect(await blobText(request, path)).toBe(after);
});

test('a proposal with no `type` is refused by the parser; a forged bank key is refused before anything else', async ({ request }) => {
  await iso.start();
  await writer();
  const run = await openRun(request, SLUG);

  const noType = await call(request, run, 'memory.write', { path: 'memory/facts/e2e-notype.md', body: 'a body but no type\n' });
  expect(noType.answer).toMatchObject({ ok: false, status: 422, code: 'okf_invalid' });
  expect(String(noType.answer['message'])).toContain('memory/facts/e2e-notype.md');
  expect(String(noType.answer['message'])).toMatch(/no `type`/);
  expect(await blobText(request, 'memory/facts/e2e-notype.md')).toBe('');

  const bank = await call(request, run, 'memory.write', { path: 'memory/facts/e2e-bank.md', type: 'fact', body: 'x\n', bankId: 'team:other' });
  expect(bank.answer).toMatchObject({ ok: false, code: 'bank_not_allowed' });
  expect(await blobText(request, 'memory/facts/e2e-bank.md')).toBe('');
});
