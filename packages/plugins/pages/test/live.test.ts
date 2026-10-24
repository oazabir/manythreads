import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedWorld, startTestServer, personas, ownerSql, TEAM_IDS, type TestServer } from '@manythreads/test-utils';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import WebSocket from 'ws';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { forgetLivePages } from '../src/live.ts';

// Live pages end to end (PLAN P6-09, criterion 7): two people edit one page over the real socket route, see each other's cursors, and the session
// becomes one commit with both as authors. The page is seeded through the ordinary pages route first, so the test also proves a live session and
// the writer agree on the file's bytes.

let server: TestServer;

interface Who {
  actorId: string;
  workspaceId: string;
  name: string;
}

const devHeaders = (who: Who): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }),
});

async function api(who: Who, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { ...devHeaders(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const waitFor = async (what: string, check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const decodeFrame = (data: Buffer | ArrayBuffer): Uint8Array => (data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data));

/** One Yjs client of the page, speaking the same sync and awareness protocol as the browser. */
class Editor {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly ws: WebSocket;
  closed: Promise<number> = Promise.resolve(0);
  notice: { type: string; sha?: string } | null = null;

  constructor(
    readonly who: Who,
    path: string,
    /** What the client puts in its awareness state: the browser sends the person id, not the actor id. */
    readonly stateActorId: string = who.actorId,
  ) {
    this.ws = new WebSocket(`${server.url.replace(/^http/, 'ws')}/api/teams/engineering/pages/live?path=${encodeURIComponent(path)}`, {
      headers: devHeaders(who),
    });
    this.ws.binaryType = 'arraybuffer';
    const closeCode = new Promise<number>((resolve) =>
      this.ws.on('close', (code: number) => resolve(code)),
    );
    this.closed = closeCode;
    this.ws.on('message', (raw: Buffer, isBinary: boolean) => {
      const data = decodeFrame(raw);
      if (!isBinary) {
        try {
          this.notice = JSON.parse(new TextDecoder().decode(data)) as { type: string; sha?: string };
        } catch {
          /* a notice we do not understand: the protocol frames are binary */
        }
        return;
      }
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'remote');
        if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
      } else if (type === 1) {
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), 'remote');
      }
    });
    this.ws.on('open', () => {
      this.awareness.setLocalStateField('actorId', this.stateActorId);
      this.awareness.setLocalStateField('user', { name: who.name });
      const step = encoding.createEncoder();
      encoding.writeVarUint(step, 0);
      syncProtocol.writeSyncStep1(step, this.doc);
      this.send(encoding.toUint8Array(step));
      this.sendAwareness([this.doc.clientID]);
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === 'remote') return;
      this.sendAwareness([...added, ...updated, ...removed]);
    });
  }

  get text(): string {
    return this.doc.getText('body').toString();
  }

  private send(bytes: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  private sendAwareness(clients: number[]): void {
    if (clients.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, clients));
    this.send(encoding.toUint8Array(encoder));
  }

  type(at: number, text: string): void {
    this.doc.getText('body').insert(at, text);
  }

  cursor(at: number): void {
    this.awareness.setLocalStateField('cursor', { anchor: at, head: at });
  }

  close(): void {
    this.ws.close();
  }
}

const lastCommit = async (path: string): Promise<{ sha: string; message: string; co_authors: string[]; author_id: string } | undefined> =>
  (
    await ownerSql<{ sha: string; message: string; co_authors: string[]; author_id: string }>(
      server.db.ownerUrl,
      'SELECT sha, message, co_authors, author_id FROM app.repo_commits WHERE team_id = $1 AND $2 = ANY(paths) ORDER BY seq DESC LIMIT 1',
      [TEAM_IDS.Engineering, path],
    )
  )[0];

const fileText = async (path: string): Promise<string> => {
  const res = await api(personas.omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body?.['content'] as string;
};

beforeAll(async () => {
  server = await startTestServer();
  await seedWorld(server.db);
}, 120_000);

afterAll(async () => {
  forgetLivePages();
  await server?.close();
});

describe('a page edited live (PLAN P6-09)', () => {
  it('merges two editors, shows each other’s cursor, keeps all text and commits once with both as authors', async () => {
    const path = 'pages/live/merge.md';
    const created = await api(personas.omar, 'POST', '/api/teams/engineering/pages/write', {
      mode: 'create',
      path,
      content: '# Merge\n\nstart\n',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const nadia = new Editor(personas.nadia, path);
    const rafi = new Editor(personas.rafi, path);
    await waitFor('both editors to receive the page', () => nadia.text.includes('start') && rafi.text.includes('start'));

    // Concurrent edits at different offsets: neither may be lost.
    nadia.type(nadia.text.length, 'Nadia was here.\n');
    rafi.type(0, 'Rafi was here.\n');
    await waitFor('both edits to converge', () => nadia.text === rafi.text && nadia.text.includes('Nadia was here.') && nadia.text.includes('Rafi was here.'));

    // Awareness: each client's actor travels with its cursor, and the other client sees it.
    nadia.cursor(0);
    rafi.cursor(4);
    type PeerState = { actorId?: string; user?: { name: string }; cursor?: { anchor: number; head: number } };
    const states = (awareness: Editor): PeerState[] => [...awareness.awareness.getStates().values()] as PeerState[];
    await waitFor('Rafi’s cursor to reach Nadia', () => states(nadia).some((s) => s.actorId === personas.rafi.actorId && s.cursor));
    await waitFor('Nadia’s cursor to reach Rafi', () => states(rafi).some((s) => s.actorId === personas.nadia.actorId && s.cursor));
    const rafiCursor = states(nadia).find((s) => s.actorId === personas.rafi.actorId)!;
    expect(rafiCursor, JSON.stringify([...nadia.awareness.getStates().values()])).toBeTruthy();
    expect(rafiCursor.cursor).toEqual({ anchor: 4, head: 4 });
    expect(rafiCursor.user?.name).toBe('Rafi');

    const expected = nadia.text;
    nadia.close();
    rafi.close();
    await Promise.all([nadia.closed, rafi.closed]);

    await waitFor(
      'the session commit',
      async () => /^Edit .+ live/.test((await lastCommit(path))?.message ?? ''),
      6000,
    );
    expect(await fileText(path)).toBe(expected);
    const commit = await lastCommit(path);
    expect(commit?.message.split('\n')[0]).toBe('Edit pages/live/merge.md live with 2 editors');
    expect(commit?.author_id).toBe(personas.nadia.actorId);
    expect(commit?.co_authors).toEqual([personas.rafi.actorId]);

    // A later session reads the committed page from the document snapshot, not a stale copy.
    const later = new Editor(personas.omar, path);
    await waitFor('the next session to load the committed text', () => later.text === expected);
    later.close();
    await later.closed;
  }, 30_000);

  it('takes the browser’s person id for awareness and stores the actor id', async () => {
    const path = 'pages/live/person-id.md';
    expect((await api(personas.omar, 'POST', '/api/teams/engineering/pages/write', { mode: 'create', path, content: 'hello\n' })).status).toBe(201);
    // The web client knows the signed-in person (`session.person.id`), which is not the `actors` row the person acts through.
    const nadia = new Editor(personas.nadia, path, personas.nadia.personId);
    const rafi = new Editor(personas.rafi, path);
    await waitFor('both editors to receive the page', () => nadia.text.includes('hello') && rafi.text.includes('hello'));
    nadia.cursor(1);
    rafi.cursor(0);
    type PeerState = { actorId?: string; cursor?: { anchor: number; head: number } };
    const states = (awareness: Editor): PeerState[] => [...awareness.awareness.getStates().values()] as PeerState[];
    await waitFor(
      'Nadia’s cursor to reach Rafi under her actor id',
      () => states(rafi).some((s) => s.actorId === personas.nadia.actorId && s.cursor?.anchor === 1),
    );
    await waitFor('Rafi’s cursor to reach Nadia', () => states(nadia).some((s) => s.actorId === personas.rafi.actorId));
    // The cursor row names the actor, so its foreign key holds.
    await waitFor(
      'the awareness row under the actor id',
      async () =>
        (
          await ownerSql<{ actor_id: string }>(
            server.db.ownerUrl,
            'SELECT actor_id FROM app.page_awareness WHERE team_id = $1 AND path = $2',
            [TEAM_IDS.Engineering, path],
          )
        ).some((r) => r.actor_id === personas.nadia.actorId),
      5000,
    );
    nadia.close();
    rafi.close();
    await Promise.all([nadia.closed, rafi.closed]);
  }, 30_000);

  it('commits a session that stays open after a minute of quiet (the idle path)', async () => {
    const path = 'pages/live/idle.md';
    expect((await api(personas.omar, 'POST', '/api/teams/engineering/pages/write', { mode: 'create', path, content: 'quiet\n' })).status).toBe(201);
    const previous = process.env['MANYTHREADS_PAGE_IDLE_MS'];
    process.env['MANYTHREADS_PAGE_IDLE_MS'] = '300';
    try {
      const editor = new Editor(personas.nadia, path);
      await waitFor('the page to load', () => editor.text === 'quiet\n');
      editor.type(0, 'still editing\n');
      await waitFor(
        'the idle commit',
        async () => /^Edit .+ live/.test((await lastCommit(path))?.message ?? ''),
        5000,
      );
      expect(await fileText(path)).toBe('still editing\nquiet\n');
      expect((await lastCommit(path))?.co_authors).toEqual([]);
      editor.close();
      await editor.closed;
    } finally {
      if (previous === undefined) delete process.env['MANYTHREADS_PAGE_IDLE_MS'];
      else process.env['MANYTHREADS_PAGE_IDLE_MS'] = previous;
    }
  }, 20_000);

  it('refuses a page that is not there, a path outside pages/, and a request with no session', async () => {
    const missing = new Editor(personas.nadia, 'pages/live/missing.md');
    expect(await missing.closed).toBe(4404);

    const guarded = new Editor(personas.nadia, 'bots/coder/BOT.md');
    expect(await guarded.closed).toBe(1008);

    const anonymous = new WebSocket(`${server.url.replace(/^http/, 'ws')}/api/teams/engineering/pages/live?path=pages%2Flive%2Fmerge.md`);
    const refused = new Promise<number>((resolve) => anonymous.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(await refused).toBe(401);
  }, 15_000);

  it('keeps the update ledger and the snapshot for the session it committed', async () => {
    const rows = await ownerSql<{ n: number }>(
      server.db.ownerUrl,
      'SELECT count(*)::int AS n FROM app.page_updates WHERE team_id = $1 AND path = $2',
      [TEAM_IDS.Engineering, 'pages/live/merge.md'],
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
    const doc = await ownerSql<{ last_commit_sha: string | null }>(
      server.db.ownerUrl,
      'SELECT last_commit_sha FROM app.page_docs WHERE team_id = $1 AND path = $2',
      [TEAM_IDS.Engineering, 'pages/live/merge.md'],
    );
    expect(doc[0]?.last_commit_sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
