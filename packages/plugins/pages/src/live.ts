import type { HttpCaller, HttpRequest, PluginContext, PluginSocket, PluginTx, RepoProvider, RepoWriteResult } from '@manythreads/sdk';
import { PagePath, isGuardedRepoPath } from '@manythreads/shared';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

// Live pages (PLAN P6-09, SPEC §5.2, §6.4): a page is edited as a Yjs document held by the server, and git still gets one commit per editing
// session — when every editor has left, or after a minute with no edit. Every editor of the session is a `Co-authored-by` on that commit, so the
// history reads like the page was written together, because it was.
//
//  * The document's text is the markdown source (frontmatter stays outside it, untouched), so what a person sees in the live editor is byte for
//    byte what the commit holds; rich rendering still works on the committed file.
//  * A socket authenticates exactly like an HTTP request (the platform's hooks run first). Only people on the team may open a page; a bot reaches
//    the same document through `pages.write` (`applyLiveWrite`), so a bot and a person editing at once converge instead of overwriting.
//  * Updates are appended to `page_updates` (the audit and the crash-replay tail) and folded into `page_docs` on every commit. Awareness (cursors)
//    is broadcast and kept in the UNLOGGED `page_awareness` table.
//  * The room is in this process. Two replicas editing the same page are two documents; the second commit loses the race and the writer keeps the
//    session open, which is the honest limit of a single-node hub (P10 puts the hub on one replica per team, or moves it to a provider).

export const LIVE_PAGE_PATH = '/api/teams/:slug/pages/live';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** Frontmatter is not part of the document: it is carried as the session's head and re-attached on commit. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_LEAVE_MS = 2_000;

export interface LiveEditor {
  actorId: string;
  /** The person behind the actor (the browser knows this id, not the actors row). Null for a bot or a dev-header actor. */
  personId: string | null;
  kind: 'person' | 'bot';
  workspaceId: string;
  name: string;
}

interface Room {
  key: string;
  teamId: string;
  teamSlug: string;
  path: string;
  doc: Y.Doc;
  text: Y.Text;
  awareness: Awareness;
  frontmatter: string;
  /** The blob the session started from (and the one its last commit produced): the base of the next write. */
  blobSha: string | null;
  /** The page as last committed (or loaded): a session that ends where it started writes nothing. */
  committedText: string;
  lastCommitSha: string | null;
  sockets: Map<PluginSocket, LiveEditor>;
  /** Who edited since the last commit, by actor id, for the co-author trailers. */
  editors: Map<string, LiveEditor>;
  dirty: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  leaveTimer?: ReturnType<typeof setTimeout>;
  awarenessTimer?: ReturnType<typeof setTimeout>;
  committing: Promise<RepoWriteResult | null> | null;
}

const rooms = new Map<string, Room>();
const loading = new Map<string, Promise<Room>>();

/** The idle window before a session commits with its editors still present (env override for tests and operators). */
const idleMs = (): number => Number(process.env['MANYTHREADS_PAGE_IDLE_MS'] ?? DEFAULT_IDLE_MS) || DEFAULT_IDLE_MS;
/** The grace after the last socket closes: a reload reconnects, and the commit still lands within the five seconds the phase asks for. */
const leaveMs = (): number => Number(process.env['MANYTHREADS_PAGE_LEAVE_MS'] ?? DEFAULT_LEAVE_MS) || DEFAULT_LEAVE_MS;

/** Tests only: empty the in-process room registry. */
export function forgetLivePages(): void {
  for (const room of rooms.values()) {
    if (room.idleTimer) clearTimeout(room.idleTimer);
    if (room.leaveTimer) clearTimeout(room.leaveTimer);
    if (room.awarenessTimer) clearTimeout(room.awarenessTimer);
    room.doc.destroy();
  }
  rooms.clear();
  loading.clear();
}

/** The page's frontmatter and its body, split the way the editor splits them. */
export function splitPage(text: string): { frontmatter: string; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: '', body: text };
  return { frontmatter: match[0], body: text.slice(match[0].length) };
}

const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');
const callerOf = (editor: LiveEditor): HttpCaller => ({
  actorId: editor.actorId,
  kind: editor.kind,
  workspaceId: editor.workspaceId,
  personId: editor.kind === 'person' ? null : null,
  sessionId: null,
});

/** A repo failure as the socket's close reason (the RepoError carries its status). */
function closeReason(err: unknown): { code: number; reason: string } {
  const e = err as { status?: number };
  if (e?.status === 404) return { code: 4404, reason: 'page not found' };
  if (e?.status === 403) return { code: 4403, reason: 'not allowed' };
  if (e?.status === 409) return { code: 4409, reason: 'page changed' };
  return { code: 1011, reason: 'live editing is unavailable' };
}

async function teamOf(tx: PluginTx, slug: string): Promise<{ id: string; slug: string } | null> {
  return (await tx.query<{ id: string; slug: string }>('SELECT id, slug FROM app.teams WHERE slug = $1', [slug])).rows[0] ?? null;
}

/** The editor behind a caller: the bot's name, or the person's name **and** id (a dev-header person has no session person id). */
async function identityOf(tx: PluginTx, caller: HttpCaller): Promise<{ name: string; personId: string | null }> {
  if (caller.kind === 'bot') {
    const row = (await tx.query<{ name: string }>('SELECT name FROM app.bots WHERE id = (SELECT ref_id FROM app.actors WHERE id = $1)', [caller.actorId])).rows[0];
    return { name: row?.name ?? 'A bot', personId: null };
  }
  const row = (await tx.query<{ name: string; person_id: string | null }>(
    'SELECT p.display_name AS name, p.id AS person_id FROM app.people p WHERE p.id = (SELECT ref_id FROM app.actors WHERE id = $1)',
    [caller.actorId],
  )).rows[0];
  return { name: row?.name ?? 'Someone', personId: row?.person_id ?? null };
}

/** Load the document for (team, path): the snapshot plus the updates it does not hold yet, or the repository's file. */
async function loadDocument(
  ctx: PluginContext,
  tx: PluginTx,
  teamId: string,
  path: string,
): Promise<{ doc: Y.Doc; frontmatter: string; blobSha: string | null; text: string }> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('the team repository is not available');
  const blob = await repo.blob(tx, teamId, path, 'main');
  const file = decode(blob.content);
  const { frontmatter, body } = splitPage(file);
  const doc = new Y.Doc();
  const text = doc.getText('body');
  const snapshot = (
    await tx.query<{ snapshot: Buffer; last_update_id: string }>('SELECT snapshot, last_update_id FROM app.page_docs WHERE team_id = $1 AND path = $2', [teamId, path])
  ).rows[0];
  if (snapshot && snapshot.snapshot.length > 0) {
    Y.applyUpdate(doc, new Uint8Array(snapshot.snapshot), 'server');
    const tail = (
      await tx.query<{ update: Buffer }>('SELECT update FROM app.page_updates WHERE team_id = $1 AND path = $2 AND id > $3 ORDER BY id', [
        teamId,
        path,
        Number(snapshot.last_update_id),
      ])
    ).rows;
    for (const row of tail) Y.applyUpdate(doc, new Uint8Array(row.update), 'server');
  } else {
    text.insert(0, body, 'server');
  }
  return { doc, frontmatter, blobSha: blob.sha, text: text.toString() };
}

function broadcast(room: Room, frame: Uint8Array, except?: PluginSocket): void {
  for (const socket of room.sockets.keys()) if (socket !== except) socket.send(frame);
}

function broadcastAwareness(room: Room, clients: number[], except?: PluginSocket): void {
  if (clients.length === 0) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(room.awareness, clients));
  broadcast(room, encoding.toUint8Array(encoder), except);
}

function scheduleIdle(ctx: PluginContext, room: Room): void {
  if (room.idleTimer) clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(() => void commitRoom(ctx, room), idleMs());
  room.idleTimer.unref?.();
}

/** Persist the snapshot and the newest update id, so a process that dies mid-session replays from here. */
async function remember(ctx: PluginContext, room: Room, commitSha: string | null): Promise<void> {
  const snapshot = Buffer.from(Y.encodeStateAsUpdate(room.doc));
  await ctx.db.system(async (tx) => {
    const max = (await tx.query<{ id: string | null }>('SELECT max(id)::text AS id FROM app.page_updates WHERE team_id = $1 AND path = $2', [room.teamId, room.path])).rows[0];
    await tx.query(
      `INSERT INTO app.page_docs (team_id, path, snapshot, last_update_id, last_commit_sha, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (team_id, path) DO UPDATE SET snapshot = EXCLUDED.snapshot, last_update_id = EXCLUDED.last_update_id,
         last_commit_sha = coalesce(EXCLUDED.last_commit_sha, app.page_docs.last_commit_sha), updated_at = now()`,
      [room.teamId, room.path, snapshot, Number(max?.id ?? 0), commitSha],
    );
  });
}

/**
 * One session's commit: the document as markdown, authored by the first person who edited (or the first bot), with every other editor as a
 * co-author. A commit that would change nothing is skipped. A 409 (someone committed the page outside the session) leaves the room dirty for the
 * next attempt: git is the truth, and a live session never overwrites what it did not see.
 */
export function commitRoom(ctx: PluginContext, room: Room): Promise<RepoWriteResult | null> {
  if (room.committing) return room.committing;
  const content = room.frontmatter + room.text.toString();
  const editors = [...room.editors.values()];
  if (content === room.committedText || editors.length === 0) {
    room.dirty = false;
    return Promise.resolve(null);
  }
  const author = editors.find((e) => e.kind === 'person') ?? editors[0]!;
  const coAuthors = editors.filter((e) => e.actorId !== author.actorId).map((e) => ({ actorId: e.actorId, name: e.name }));
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return Promise.resolve(null);
  room.committing = (async (): Promise<RepoWriteResult | null> => {
    try {
      const written = await ctx.db.as(callerOf(author), async (tx) => {
        const result = await repo.write(
          tx,
          room.teamId,
          { id: author.actorId, kind: author.kind, name: author.name },
          [{ path: room.path, op: 'put', content, ...(room.blobSha ? { baseBlobSha: room.blobSha } : {}) }],
          `Edit ${room.path} live${editors.length > 1 ? ` with ${editors.length} editors` : ''}`,
          coAuthors,
          { capability: 'pages.write' },
        );
        if (!result.noop) {
          const path = result.paths.find((p) => p.path === room.path);
          if (path?.blobSha) {
            await ctx.audit.emit(tx, {
              type: 'pages.page.written',
              teamId: room.teamId,
              path: room.path,
              mode: 'replace',
              sha: result.sha,
              blobSha: path.blobSha,
              size: path.size ?? Buffer.byteLength(content),
              authorId: author.actorId,
              actorKind: author.kind,
            });
          }
        }
        return result;
      });
      room.committedText = content;
      room.blobSha = written.paths.find((p) => p.path === room.path)?.blobSha ?? room.blobSha;
      room.lastCommitSha = written.sha;
      room.editors.clear();
      room.dirty = false;
      await remember(ctx, room, written.noop ? null : written.sha);
      if (!written.noop) broadcast(room, new TextEncoder().encode(JSON.stringify({ type: 'committed', path: room.path, sha: written.sha, editors: editors.length })));
      return written;
    } catch (err) {
      // A conflict is the page moving under the session; anything else is a real failure. Both leave the room dirty for the next attempt.
      const status = (err as { status?: number }).status;
      process.stderr.write(`pages: live commit of ${room.path} failed${status ? ` (${status})` : ''}: ${err instanceof Error ? err.message : String(err)}\n`);
      room.dirty = true;
      return null;
    } finally {
      room.committing = null;
    }
  })();
  return room.committing;
}

/** Append one client update to the ledger and remember who made it. */
function trackUpdate(ctx: PluginContext, room: Room, update: Uint8Array, editor: LiveEditor): void {
  room.dirty = true;
  room.editors.set(editor.actorId, editor);
  void ctx.db
    .as(callerOf(editor), (tx) => tx.query('INSERT INTO app.page_updates (team_id, path, actor_id, update) VALUES ($1, $2, $3, $4)', [room.teamId, room.path, editor.actorId, Buffer.from(update)]))
    .catch((err: unknown) => process.stderr.write(`pages: an update to ${room.path} was not recorded: ${err instanceof Error ? err.message : String(err)}\n`));
  scheduleIdle(ctx, room);
}

function scheduleAwareness(ctx: PluginContext, room: Room): void {
  if (room.awarenessTimer) clearTimeout(room.awarenessTimer);
  room.awarenessTimer = setTimeout(() => {
    const states = [...room.awareness.getStates().entries()].filter(([clientId]) => clientId !== room.doc.clientID);
    void ctx.db
      .system(async (tx) => {
        for (const [, state] of states) {
          const actorId = (state as { actorId?: unknown }).actorId;
          if (typeof actorId !== 'string') continue;
          await tx.query(
            `INSERT INTO app.page_awareness (team_id, path, actor_id, state, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 seconds')
             ON CONFLICT (team_id, path, actor_id) DO UPDATE SET state = EXCLUDED.state, expires_at = EXCLUDED.expires_at`,
            [room.teamId, room.path, actorId, state],
          );
        }
      })
      .catch(() => undefined);
  }, 500);
  room.awarenessTimer.unref?.();
}

function roomFor(teamId: string, slug: string, path: string, loaded: { doc: Y.Doc; frontmatter: string; blobSha: string | null; text: string }): Room {
  const room: Room = {
    key: `${teamId}:${path}`,
    teamId,
    teamSlug: slug,
    path,
    doc: loaded.doc,
    text: loaded.doc.getText('body'),
    awareness: new Awareness(loaded.doc),
    frontmatter: loaded.frontmatter,
    blobSha: loaded.blobSha,
    committedText: loaded.text,
    lastCommitSha: null,
    sockets: new Map(),
    editors: new Map(),
    dirty: false,
    committing: null,
  };
  room.awareness.setLocalStateField('server', true);
  return room;
}

/** The room is created once per page: concurrent opens share the load, so two people arriving together see one document. */
function openRoom(ctx: PluginContext, caller: HttpCaller, slug: string, path: string): Promise<Room> {
  const pendingKey = `${slug}:${path}`;
  const pending = loading.get(pendingKey);
  if (pending) return pending;
  const load = ctx.db.as(caller, async (tx) => {
    const team = await teamOf(tx, slug);
    if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
    const existing = rooms.get(`${team.id}:${path}`);
    if (existing) return existing;
    const loaded = await loadDocument(ctx, tx, team.id, path);
    const room = roomFor(team.id, team.slug, path, loaded);
    room.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'server') return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      broadcast(room, encoding.toUint8Array(encoder), origin instanceof Object ? (origin as PluginSocket) : undefined);
      const editor = origin instanceof Object ? room.sockets.get(origin as PluginSocket) : undefined;
      if (editor) trackUpdate(ctx, room, update, editor);
    });
    room.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      broadcastAwareness(room, [...added, ...updated], origin instanceof Object ? (origin as PluginSocket) : undefined);
      broadcastAwareness(room, removed);
      scheduleAwareness(ctx, room);
    });
    rooms.set(room.key, room);
    return room;
  }).finally(() => loading.delete(pendingKey));
  loading.set(pendingKey, load);
  return load;
}

/** Handle one binary frame: the standard Yjs sync and awareness protocol, nothing invented. */
function frame(room: Room, socket: PluginSocket, editor: LiveEditor, data: Uint8Array): void {
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);
  if (type === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket);
    if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
    return;
  }
  if (type === MESSAGE_AWARENESS) {
    // The state a client sends is its own; a state that names somebody else is refused rather than trusted (the cursor would claim to be them).
    // The browser knows the signed-in person, not the `actors` row that person acts through, so a state naming its own person is rewritten to
    // the actor id: peers and `page_awareness.actor_id` (a foreign key to `actors`) name the actor, as every other row does.
    const update = decoding.readVarUint8Array(decoder);
    let encoded = update;
    const ids: number[] = [];
    const probe = new Awareness(room.doc);
    try {
      applyAwarenessUpdate(probe, update, null);
      let rewrite = false;
      for (const [clientId, state] of probe.getStates()) {
        const actorId = (state as { actorId?: unknown }).actorId;
        if (typeof actorId === 'string' && actorId !== editor.actorId) {
          if (editor.personId === null || actorId !== editor.personId) return;
          probe.states.set(clientId, { ...state, actorId: editor.actorId });
          rewrite = true;
        }
        ids.push(clientId);
      }
      if (rewrite) encoded = encodeAwarenessUpdate(probe, ids);
    } catch {
      return;
    } finally {
      probe.destroy();
    }
    applyAwarenessUpdate(room.awareness, encoded, socket);
    return;
  }
  socket.close(1008, 'unknown frame');
}

async function serveSocket(ctx: PluginContext, socket: PluginSocket, request: HttpRequest): Promise<void> {
  // Cookies are SameSite=Lax; a cross-site page could still open a socket with them. Refuse another origin, like the platform's own hub.
  const origin = request.headers['origin'];
  const host = request.headers['host'];
  if (origin && host && new URL(origin).host.toLowerCase() !== host.toLowerCase()) {
    socket.close(1008, 'origin not allowed');
    return;
  }
  const caller = request.caller;
  if (!caller || caller.kind !== 'person') {
    socket.close(1008, 'sign in to edit a page live');
    return;
  }
  const slug = request.params['slug'] ?? '';
  const parsed = PagePath.safeParse(request.query['path'] ?? '');
  if (!parsed.success) {
    socket.close(1008, 'a live page is a path under pages/');
    return;
  }
  const path = parsed.data;
  if (isGuardedRepoPath(path)) {
    socket.close(1008, 'change configuration by pull request');
    return;
  }
  // Frames can arrive while the room is still loading (a client sends its sync step as soon as the socket opens, and loading a page reads git):
  // buffer them rather than lose the handshake in that window.
  const early: Uint8Array[] = [];
  let ready = false;
  let gone = false;
  socket.on('message', (data) => {
    if (typeof data === 'string') return;
    if (!ready) early.push(data);
    else handle(data);
  });
  socket.on('close', () => {
    gone = true;
  });
  let room: Room;
  try {
    room = await openRoom(ctx, caller, slug, path);
  } catch (err) {
    const { code, reason } = closeReason(err);
    socket.close(code, reason);
    return;
  }
  if (gone) return;
  const identity = await ctx.db.as(caller, (tx) => identityOf(tx, caller)).catch(() => ({ name: 'Someone', personId: null }));
  const editor: LiveEditor = {
    actorId: caller.actorId,
    // A session names the person; a dev-header actor does not, so the row's `ref_id` stands in.
    personId: caller.personId ?? identity.personId,
    kind: 'person',
    workspaceId: caller.workspaceId,
    name: identity.name,
  };
  room.sockets.set(socket, editor);
  if (room.leaveTimer) {
    clearTimeout(room.leaveTimer);
    room.leaveTimer = undefined;
  }
  // Hand over the document's state vector, then everyone's cursor.
  const step = encoding.createEncoder();
  encoding.writeVarUint(step, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(step, room.doc);
  socket.send(encoding.toUint8Array(step));
  const clients = [...room.awareness.getStates().keys()].filter((id) => id !== room.doc.clientID);
  if (clients.length > 0) {
    const awareness = encoding.createEncoder();
    encoding.writeVarUint(awareness, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(awareness, encodeAwarenessUpdate(room.awareness, clients));
    socket.send(encoding.toUint8Array(awareness));
  }
  ready = true;
  for (const buffered of early.splice(0)) handle(buffered);
  function handle(data: Uint8Array): void {
    try {
      frame(room, socket, editor, data);
    } catch {
      socket.close(1011, 'bad frame');
    }
  }
  socket.on('close', () => {
    room.sockets.delete(socket);
    // A client's awareness state names its actor; when that socket is gone, so is its cursor.
    const mine = [...room.awareness.getStates().entries()]
      .filter(([, state]) => (state as { actorId?: unknown }).actorId === editor.actorId)
      .map(([clientId]) => clientId);
    if (mine.length > 0) removeAwarenessStates(room.awareness, mine, socket);
    if (room.sockets.size > 0) return;
    // The last editor left: one short grace for a reload, then the session's commit (well inside the five seconds the phase asks for).
    room.leaveTimer = setTimeout(() => {
      void commitRoom(ctx, room).finally(() => {
        rooms.delete(room.key);
        room.awareness.destroy();
        room.doc.destroy();
      });
    }, leaveMs());
    room.leaveTimer.unref?.();
  });
  socket.on('error', () => undefined);
}

export function registerLivePageRoute(ctx: PluginContext): void {
  ctx.http.route({ method: 'GET', path: LIVE_PAGE_PATH, ws: (socket, request) => serveSocket(ctx, socket, request) });
}

export interface LiveWriteInput {
  teamId: string;
  path: string;
  mode: 'create' | 'replace' | 'append';
  content: string;
  baseBlobSha?: string;
  actor: { id: string; kind: 'person' | 'bot' | 'system'; workspaceId: string };
}

/**
 * A bot's `pages.write` into a page a person has open: the change goes into the same document, is broadcast to the people editing, and is committed
 * at once as the bot (with the session's people as co-authors when they edited too). Answers null when no live session holds the page, so the
 * ordinary writer takes it — one path, chosen by whether somebody is editing.
 */
export async function applyLiveWrite(ctx: PluginContext, input: LiveWriteInput): Promise<RepoWriteResult | null> {
  const room = rooms.get(`${input.teamId}:${input.path}`);
  if (!room || room.sockets.size === 0 || input.mode === 'create') return null;
  if (input.baseBlobSha !== undefined && input.baseBlobSha !== room.blobSha) return null;
  // An earlier commit of this room is still writing: a change applied now would be outside it. Wait, then apply.
  if (room.committing) await room.committing;
  const before = { text: room.text.toString(), frontmatter: room.frontmatter, dirty: room.dirty };
  const split = splitPage(input.content);
  const next = input.mode === 'append' ? before.text + input.content : split.body;
  const frontmatter = input.mode === 'append' ? before.frontmatter : split.frontmatter || before.frontmatter;
  const previousEditors = new Map(room.editors);
  const name = await ctx.db
    .system(async (tx) => {
      if (input.actor.kind === 'bot') {
        return (await tx.query<{ name: string }>('SELECT name FROM app.bots WHERE id = (SELECT ref_id FROM app.actors WHERE id = $1)', [input.actor.id])).rows[0]?.name ?? 'A bot';
      }
      return (await tx.query<{ name: string }>('SELECT display_name AS name FROM app.people WHERE id = (SELECT ref_id FROM app.actors WHERE id = $1)', [input.actor.id])).rows[0]?.name ?? 'Someone';
    })
    .catch(() => 'Someone');
  room.frontmatter = frontmatter;
  room.doc.transact(() => {
    if (room.text.length > 0) room.text.delete(0, room.text.length);
    if (next.length > 0) room.text.insert(0, next);
  }, 'api');
  room.editors.set(input.actor.id, {
    actorId: input.actor.id,
    // An API write knows only the actor (the bot or the person it made the change for); no awareness state comes from it.
    personId: null,
    kind: input.actor.kind === 'system' ? 'person' : input.actor.kind,
    workspaceId: input.actor.workspaceId,
    name,
  });
  room.dirty = true;
  const written = await commitRoom(ctx, room);
  if (written === null) {
    // The page moved under the session (or the commit failed): undo the document change and let the ordinary writer answer with the real reason.
    room.frontmatter = before.frontmatter;
    room.doc.transact(() => {
      if (room.text.length > 0) room.text.delete(0, room.text.length);
      if (before.text.length > 0) room.text.insert(0, before.text);
    }, 'api');
    room.dirty = before.dirty;
    room.editors = previousEditors;
    return null;
  }
  return written;
}

/** The persisted snapshot of a page (tests, the file viewer's "resume where the session ended" hint). */
export async function pageSnapshot(ctx: PluginContext, teamId: string, path: string): Promise<{ snapshot: Uint8Array; commitSha: string | null } | null> {
  return ctx.db.system(async (tx) => {
    const row = (await tx.query<{ snapshot: Buffer; last_commit_sha: string | null }>('SELECT snapshot, last_commit_sha FROM app.page_docs WHERE team_id = $1 AND path = $2', [teamId, path])).rows[0];
    return row ? { snapshot: new Uint8Array(row.snapshot), commitSha: row.last_commit_sha } : null;
  });
}
