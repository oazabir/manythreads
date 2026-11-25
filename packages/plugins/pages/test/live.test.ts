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
    // The two edits arrive together, so whichever the server saw first is the author and the other is the co-author.
    const pair = [personas.nadia.actorId, personas.rafi.actorId];
    expect(pair).toContain(commit?.author_id);
    expect(commit?.co_authors).toEqual(pair.filter((id) => id !== commit?.author_id));

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

  it('starts from the file, not the last session, when the page was changed outside the live editor (P17-05 step 2)', async () => {
    const path = 'pages/live/idle.md';
    // the idle test left a session snapshot; once its room is gone (the short grace after the last editor left), the file is changed outside the editor
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const changed = await api(personas.omar, 'POST', '/api/teams/engineering/repo/commit', { changes: [{ op: 'put', path, content: 'changed outside\n' }], message: 'Outside the editor' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(201);
    const editor = new Editor(personas.nadia, path);
    await waitFor('the page to load from the file', () => editor.text === 'changed outside\n');
    editor.type(0, 'and live\n');
    editor.close();
    await editor.closed;
    await waitFor('the session commit', async () => /^Edit .+ live/.test((await lastCommit(path))?.message ?? ''), 8000);
    expect(await fileText(path)).toBe('and live\nchanged outside\n');
  }, 20_000);

  // A session whose live edits were never committed (a commit that failed, a restart): the ledger holds updates after the snapshot. Written here the way the room
  // writes them, from the snapshot the last session left.
  async function sessionWithUnsavedTail(path: string, start: string, edit: (text: Y.Text) => void): Promise<void> {
    expect((await api(personas.omar, 'POST', '/api/teams/engineering/pages/write', { mode: 'create', path, content: start })).status).toBe(201);
    const first = new Editor(personas.nadia, path);
    await waitFor('the page', () => first.text === start);
    first.type(start.length, 'committed line\n');
    first.close();
    await first.closed;
    await waitFor('the first session commit', async () => /^Edit .+ live/.test((await lastCommit(path))?.message ?? ''), 8000);
    // the room is gone after the grace (and its snapshot remembered)
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const row = (await ownerSql<{ snapshot: Buffer }>(server.db.ownerUrl, 'SELECT snapshot FROM app.page_docs WHERE team_id = $1 AND path = $2', [TEAM_IDS.Engineering, path]))[0]!;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.snapshot));
    const before = Y.encodeStateVector(doc);
    edit(doc.getText('body'));
    const update = Y.encodeStateAsUpdate(doc, before);
    doc.destroy();
    await ownerSql(server.db.ownerUrl, 'INSERT INTO app.page_updates (team_id, path, actor_id, update) VALUES ($1, $2, $3, $4)', [TEAM_IDS.Engineering, path, personas.rafi.actorId, Buffer.from(update)]);
  }
  /** The series' late-notes check (meetings series.ts addLateNotes): updates after the snapshot mean someone's live edits are pending. */
  const tailPending = async (path: string): Promise<boolean> =>
    (
      await ownerSql(
        server.db.ownerUrl,
        `SELECT 1 FROM app.page_updates u WHERE u.team_id = $1 AND u.path = $2
            AND u.id > coalesce((SELECT d.last_update_id FROM app.page_docs d WHERE d.team_id = $1 AND d.path = $2), 0)`,
        [TEAM_IDS.Engineering, path],
      )
    ).length > 0;

  it('replays unsaved live edits onto a file changed outside the editor, commits them as their author, and folds the ledger (P17-05 step 2)', async () => {
    const path = 'pages/live/tail-merge.md';
    await sessionWithUnsavedTail(path, 'top\n', (t) => t.insert(0, 'UNSAVED-LIVE\n'));
    expect(await tailPending(path)).toBe(true);
    const outside = await api(personas.omar, 'POST', '/api/teams/engineering/repo/commit', {
      changes: [{ op: 'put', path, content: 'top\ncommitted line\nadded outside\n' }],
      message: 'Outside the editor',
    });
    expect(outside.status, JSON.stringify(outside.body)).toBe(201);
    const editor = new Editor(personas.nadia, path);
    await waitFor('the merged page', () => editor.text === 'UNSAVED-LIVE\ntop\ncommitted line\nadded outside\n');
    expect(editor.notice).toBeNull();
    // nobody types: the replayed edits still commit when the last editor leaves
    editor.close();
    await editor.closed;
    await waitFor('the replayed edits to commit', async () => (await fileText(path)) === 'UNSAVED-LIVE\ntop\ncommitted line\nadded outside\n', 8000);
    expect((await lastCommit(path))?.author_id).toBe(personas.rafi.actorId);
    await waitFor('the ledger to fold', async () => !(await tailPending(path)), 4000);
  }, 30_000);

  it('a tail that cannot be replayed: the session keeps the file, says the unsaved edits were discarded, and folds the ledger', async () => {
    const path = 'pages/live/tail-discard.md';
    await sessionWithUnsavedTail(path, 'base\n', (t) => t.insert(0, 'x'));
    // an update whose base is in no snapshot (made from a document the server never saw) can never be integrated
    const orphan = new Y.Doc();
    orphan.getText('body').insert(0, 'a document the server never had');
    const lost = new Y.Doc();
    Y.applyUpdate(lost, Y.encodeStateAsUpdate(orphan));
    const sv = Y.encodeStateVector(lost);
    lost.getText('body').insert(3, 'LOST-WORDS');
    await ownerSql(server.db.ownerUrl, 'INSERT INTO app.page_updates (team_id, path, actor_id, update) VALUES ($1, $2, $3, $4)', [
      TEAM_IDS.Engineering,
      path,
      personas.rafi.actorId,
      Buffer.from(Y.encodeStateAsUpdate(lost, sv)),
    ]);
    orphan.destroy();
    lost.destroy();
    const outside = await api(personas.omar, 'POST', '/api/teams/engineering/repo/commit', { changes: [{ op: 'put', path, content: 'from the file\n' }], message: 'Outside the editor' });
    expect(outside.status, JSON.stringify(outside.body)).toBe(201);
    const editor = new Editor(personas.nadia, path);
    await waitFor('the page from the file', () => editor.text === 'from the file\n');
    await waitFor('the notice', () => editor.notice?.type === 'discarded');
    expect(await tailPending(path)).toBe(false);
    editor.close();
    await editor.closed;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await fileText(path)).toBe('from the file\n');
  }, 30_000);

  it('refuses a page that is not there, a path outside pages/, and a request with no session', async () => {
    const missing = new Editor(personas.nadia, 'pages/live/missing.md');
    expect(await missing.closed).toBe(4404);

    const guarded = new Editor(personas.nadia, 'bots/coder/BOT.md');
    expect(await guarded.closed).toBe(1008);

    const anonymous = new WebSocket(`${server.url.replace(/^http/, 'ws')}/api/teams/engineering/pages/live?path=pages%2Flive%2Fmerge.md`);
    const refused = new Promise<number>((resolve) => anonymous.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(await refused).toBe(401);
  }, 15_000);

  it('opens a meeting series\' agenda page (P17-05): the one file under meetings/ the team edits live, committed as the person; another file there is refused', async () => {
    const start = new Date(Date.now() + 3 * 3600_000);
    const made = await api(personas.nadia, 'POST', '/api/teams/engineering/meeting-series', {
      title: 'Live agenda',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 1800_000).toISOString(),
      frequency: 'weekly',
      timeZone: 'UTC',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const path = `meetings/series/live-agenda/${start.toISOString().slice(0, 10)}-agenda.md`;
    await waitFor('the platform to write the agenda', async () => (await api(personas.omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`)).status === 200, 20_000);
    const before = await fileText(path);
    const editor = new Editor(personas.rafi, path);
    await waitFor('the agenda to load', () => editor.text === before);
    editor.type(editor.text.indexOf('## Notes'), '- [ ] Order the cake — Rafi\n\n');
    editor.close();
    await editor.closed;
    await waitFor('the session commit', async () => /^Edit .+ live/.test((await lastCommit(path))?.message ?? ''), 8000);
    expect(await fileText(path)).toContain('- [ ] Order the cake — Rafi');
    expect((await lastCommit(path))?.author_id).toBe(personas.rafi.actorId);
    const readme = new Editor(personas.rafi, 'meetings/series/live-agenda/README.md');
    expect(await readme.closed).toBe(1008);
  }, 40_000);

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
