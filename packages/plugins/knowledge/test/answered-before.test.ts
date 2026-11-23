import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type FilesWorld } from '../../files/test/world.ts';
import { closeEnough, termsHeld } from '../src/answered-before.ts';
import { queryTerms } from '../src/search.ts';

// P18-09 (P35-06), through the real server: a lead marks #general a help channel (a member cannot); while a question is written there, the composer is
// shown an earlier answered thread with its answer and a knowledge passage; an unrelated question shows no thread; a channel that is not a help channel
// shows nothing; a person outside the team is refused. Nothing is posted by asking.

const { omar, nadia, tariq } = personas;
vi.setConfig({ testTimeout: 90_000 });

let world: FilesWorld;
let general = '';

type Item = { kind: 'thread'; rootId: string; title: string; answer: string | null; replyCount: number } | { kind: 'knowledge'; document: string; text: string };
const ask = (who: typeof omar, q: string, channel = general) => world.call<{ help: boolean; items: Item[] }>(who, 'GET', `/api/channels/${channel}/answered-before?q=${encodeURIComponent(q)}`);
const messageCount = async (): Promise<number> =>
  Number((await world.system((tx) => tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.messages WHERE channel_id = $1', [general]))).rows[0]!.n);

beforeAll(async () => {
  world = await createWorld();
  await world.call(omar, 'GET', '/api/teams/engineering/channels');
  general = (
    await world.system((tx) =>
      tx.query<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.kind = 'channel' AND NOT c.private ORDER BY c.name LIMIT 1`),
    )
  ).rows[0]!.id;
  const root = await world.call<{ id: string }>(nadia, 'POST', `/api/channels/${general}/messages`, { channelId: general, body: 'How do I rotate the deploy token for the preview cluster?', threadRootId: null });
  expect(root.status, JSON.stringify(root.body)).toBe(201);
  const reply = await world.call(omar, 'POST', `/api/channels/${general}/messages`, { channelId: general, body: 'Run the rotate script in tools/devbox, then restart the preview job.', threadRootId: root.body.id });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  // a question nobody answered is not an earlier answer
  await world.call(nadia, 'POST', `/api/channels/${general}/messages`, { channelId: general, body: 'Where does the preview cluster keep its deploy token?', threadRootId: null });
  expect((await world.call(omar, 'POST', '/api/teams/engineering/knowledge', { slug: 'runbook', name: 'Runbook' })).status).toBe(201);
  const up = await fetch(`${world.server.url}/api/teams/engineering/knowledge/runbook/documents?name=tokens.md`, {
    method: 'POST',
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: omar.actorId, workspaceId: omar.workspaceId }), 'content-type': 'application/octet-stream' },
    body: Buffer.from('# Tokens\n\nThe preview deploy token is rotated every ninety days with the rotate script.\n') as unknown as RequestInit['body'],
  });
  expect(up.status).toBeLessThan(300);
}, 180_000);

afterAll(async () => {
  await world?.close();
});

describe('answered before (P18-09)', () => {
  it('needs enough of the question in common', () => {
    const terms = queryTerms('how can I rotate the preview deploy token?');
    expect(terms).toEqual(['rotate', 'preview', 'deploy', 'token']);
    expect(termsHeld('Rotate the deploy token for the preview cluster', terms)).toBe(4);
    expect(closeEnough(1, 4)).toBe(false);
    expect(closeEnough(2, 4)).toBe(true);
    expect(closeEnough(2, 5)).toBe(false);
    expect(closeEnough(3, 6)).toBe(true);
  });

  it('a channel that is not a help channel shows nothing; a member cannot mark one, a lead can', async () => {
    const before = await ask(nadia, 'how can I rotate the preview deploy token?');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ help: false, items: [] });
    expect((await world.call(nadia, 'PATCH', `/api/channels/${general}`, { help: true })).status).toBe(403);
    const marked = await world.call<{ channel: { help: boolean }; changed: boolean }>(omar, 'PATCH', `/api/channels/${general}`, { help: true });
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    expect(marked.body).toMatchObject({ channel: { help: true }, changed: true });
    expect((await world.call<{ channel: { help: boolean } }>(nadia, 'GET', `/api/channels/${general}`)).body.channel.help).toBe(true);
  });

  it('shows the earlier answered thread with its answer and a knowledge passage, and posts nothing', async () => {
    const n = await messageCount();
    const res = await ask(nadia, 'how can I rotate the preview deploy token?');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.help).toBe(true);
    const threads = res.body.items.filter((i) => i.kind === 'thread');
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ title: expect.stringContaining('rotate the deploy token'), answer: expect.stringContaining('rotate script'), replyCount: 1 });
    expect(res.body.items.some((i) => i.kind === 'knowledge' && i.document === 'tokens.md')).toBe(true);
    expect(await messageCount()).toBe(n);
  });

  it('an unrelated question shows no thread; too short a question is refused; an outsider is refused', async () => {
    const other = await ask(nadia, 'what time is the design review on friday afternoon?');
    expect(other.status).toBe(200);
    expect(other.body.items.filter((i) => i.kind === 'thread')).toEqual([]);
    expect((await ask(nadia, 'token?')).status).toBe(400);
    expect((await ask(tariq, 'how can I rotate the preview deploy token?')).status).toBe(403);
  });
});
