import { BlobTooLargeError, HttpError, conflict, invalid, json, notFound, requireManage, requireTeam, route, type BlobStorage, type PluginContext, type PluginTx, type TeamRow } from '@manythreads/sdk';
import {
  CreateKnowledgeBaseRequest,
  DeleteKnowledgeBaseResponse,
  DeleteKnowledgeDocumentResponse,
  GetKnowledgeBaseResponse,
  GetKnowledgeChunkResponse,
  KnowledgeBaseParams,
  KnowledgeBaseResponse,
  KnowledgeChunkParams,
  KnowledgeDocumentParams,
  KnowledgeTeamParams,
  ListKnowledgeBasesResponse,
  ResyncKnowledgeBaseResponse,
  SearchKnowledgeQuery,
  SearchKnowledgeResponse,
  UploadKnowledgeDocumentQuery,
  UploadKnowledgeDocumentResponse,
  createKnowledgeBaseRoute,
  deleteKnowledgeBaseRoute,
  deleteKnowledgeDocumentRoute,
  getKnowledgeBaseRoute,
  getKnowledgeChunkRoute,
  listKnowledgeBasesRoute,
  resyncKnowledgeBaseRoute,
  searchKnowledgeRoute,
  uploadKnowledgeDocumentRoute,
} from '@manythreads/shared';
import { ingest, kindOfName, removeFromRepo, type BaseRef } from './ingest.ts';
import { maxExtractBytes } from './extract/index.ts';
import { BASE_SELECT, DOC_COLUMNS, DOC_FROM, toBase, toDocument, type BaseRow, type DocRow } from './rows.ts';
import { getChunk, searchKnowledge } from './search.ts';
import { readBlob, resyncBase } from './sync.ts';

// The routes of a team's knowledge bases (PLAN P8-07, P8-08, P8-33). Everyone who can read the team reads; a team lead or a workspace admin writes.

const tooLarge = (message: string): HttpError => new HttpError(413, 'validation_failed', message);

const intEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
};
const uploadIdleMs = (): number => intEnv('MANYTHREADS_UPLOAD_IDLE_MS', 20_000);
const uploadMaxMs = (): number => intEnv('MANYTHREADS_UPLOAD_MAX_MS', 600_000);
const MAX_UPLOADS_PER_ACTOR = 2;
const MAX_UPLOADS_IN_FLIGHT = 4;

// Upload slots: a body being read holds a connection, so each person and the process as a whole may have only a few at once.
const uploadsByActor = new Map<string, number>();
let uploadsInFlight = 0;
function takeUploadSlot(actorId: string): (() => void) | null {
  const mine = uploadsByActor.get(actorId) ?? 0;
  if (uploadsInFlight >= MAX_UPLOADS_IN_FLIGHT || mine >= MAX_UPLOADS_PER_ACTOR) return null;
  uploadsInFlight += 1;
  uploadsByActor.set(actorId, mine + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    uploadsInFlight -= 1;
    const left = (uploadsByActor.get(actorId) ?? 1) - 1;
    if (left <= 0) uploadsByActor.delete(actorId);
    else uploadsByActor.set(actorId, left);
  };
}

type ReadableLike = AsyncIterable<Uint8Array> & {
  iterator?: (options: { destroyOnReturn: boolean }) => AsyncIterator<Uint8Array>;
  resume?: () => unknown;
  destroy?: () => unknown;
};

class UploadStalledError extends Error {
  constructor() {
    super('The upload stalled or took too long');
  }
}

/** The request body for the blob store: gives up when the sender stalls or takes too long, and does not destroy the socket when the reader stops early, so a refusal can still be sent. */
function tapped(source: AsyncIterable<Uint8Array>): { stream: AsyncIterable<Uint8Array>; drain: () => void } {
  const src = source as ReadableLike;
  const deadline = Date.now() + uploadMaxMs();
  const idle = uploadIdleMs();
  const it = src.iterator ? src.iterator({ destroyOnReturn: false }) : source[Symbol.asyncIterator]();
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        const wait = Math.min(idle, deadline - Date.now());
        let timer: NodeJS.Timeout | undefined;
        const stalled = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new UploadStalledError()), Math.max(wait, 0));
        });
        try {
          return await Promise.race([it.next(), stalled]);
        } catch (err) {
          if (err instanceof UploadStalledError) src.destroy?.();
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
      return: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };
  return { stream, drain: () => void src.resume?.() };
}

/** The file name as the person gave it, made safe to show and to store: no folders, no control characters, at most 200 characters. */
function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  // eslint-disable-next-line no-control-regex
  name = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (name.length > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name.length > 0 && name !== '.' && name !== '..' ? name : null;
}

async function requireBase(tx: PluginTx, team: TeamRow, slug: string): Promise<BaseRow> {
  const res = await tx.query<BaseRow>(`${BASE_SELECT} WHERE b.team_id = $1 AND b.slug = $2`, [team.id, slug]);
  const base = res.rows[0];
  if (!base) throw notFound(`This team has no knowledge base called “${slug}”.`);
  return base;
}

const refOf = (team: TeamRow, base: BaseRow): BaseRef => ({ id: base.id, teamId: team.id, workspaceId: team.workspace_id, slug: base.slug });

async function canWrite(tx: PluginTx, team: TeamRow): Promise<boolean> {
  return (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1, 'manage') AS ok", [team.id])).rows[0]?.ok === true;
}

async function documentsOf(tx: PluginTx, baseId: string): Promise<DocRow[]> {
  return (await tx.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${DOC_FROM} WHERE d.base_id = $1 ORDER BY lower(d.name), d.id`, [baseId])).rows;
}

function requireWritable(team: TeamRow): void {
  if (team.archived_at) throw conflict('This team is archived, so its knowledge cannot be changed.');
}

export function registerRoutes(ctx: PluginContext): void {
  const storageOf = (): BlobStorage => {
    const storage = ctx.providers.get<BlobStorage>('storage');
    if (!storage) throw new HttpError(503, 'internal', 'File storage is not available');
    return storage;
  };
  const now = (): string => ctx.runtime.now().toISOString();

  ctx.http.route({
    ...listKnowledgeBasesRoute,
    schema: { response: ListKnowledgeBasesResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = KnowledgeTeamParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const rows = await tx.query<BaseRow>(`${BASE_SELECT} WHERE b.team_id = $1 ORDER BY lower(b.name), b.id`, [team.id]);
      return json({ bases: rows.rows.map(toBase), canWrite: await canWrite(tx, team), searchMode: 'lexical' });
    }),
  });

  ctx.http.route({
    ...createKnowledgeBaseRoute,
    schema: { body: CreateKnowledgeBaseRequest, response: KnowledgeBaseResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug: teamSlug } = KnowledgeTeamParams.parse(req.params);
      const body = CreateKnowledgeBaseRequest.parse(req.body);
      const team = await requireTeam(tx, teamSlug);
      await requireManage(tx, team);
      requireWritable(team);
      const taken = await tx.query('SELECT 1 FROM app.knowledge_bases WHERE team_id = $1 AND slug = $2', [team.id, body.slug]);
      if (taken.rows.length > 0) throw conflict(`This team already has a knowledge base called “${body.slug}”.`);
      const made = (
        await tx.query<{ id: string }>(
          'INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [team.workspace_id, team.id, body.slug, body.name ?? body.slug, tx.actor.id],
        )
      ).rows[0] as { id: string };
      await tx.query(
        `INSERT INTO app.knowledge_sources (base_id, team_id, kind) VALUES ($1, $2, 'upload'), ($1, $2, 'repo')`,
        [made.id, team.id],
      );
      await ctx.audit.emit(tx, {
        type: 'knowledge.base.created',
        workspaceId: team.workspace_id,
        teamId: team.id,
        baseId: made.id,
        slug: body.slug,
        createdBy: tx.actor.id,
        at: now(),
      });
      const row = (await tx.query<BaseRow>(`${BASE_SELECT} WHERE b.id = $1`, [made.id])).rows[0] as BaseRow;
      return json({ base: toBase(row) }, 201);
    }),
  });

  ctx.http.route({
    ...getKnowledgeBaseRoute,
    schema: { response: GetKnowledgeBaseResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = KnowledgeBaseParams.parse(req.params);
      const team = await requireTeam(tx, params.slug);
      const base = await requireBase(tx, team, params.base);
      return json({ base: toBase(base), documents: (await documentsOf(tx, base.id)).map(toDocument), canWrite: await canWrite(tx, team), searchMode: 'lexical' });
    }),
  });

  ctx.http.route({
    ...deleteKnowledgeBaseRoute,
    schema: { response: DeleteKnowledgeBaseResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = KnowledgeBaseParams.parse(req.params);
      const team = await requireTeam(tx, params.slug);
      await requireManage(tx, team);
      const base = await requireBase(tx, team, params.base);
      const blobs = (await tx.query<{ blob_key: string }>('SELECT blob_key FROM app.knowledge_documents WHERE base_id = $1 AND blob_key IS NOT NULL', [base.id])).rows;
      await tx.query('DELETE FROM app.knowledge_bases WHERE id = $1', [base.id]);
      await ctx.audit.emit(tx, {
        type: 'knowledge.base.deleted',
        workspaceId: team.workspace_id,
        teamId: team.id,
        baseId: base.id,
        slug: base.slug,
        documents: base.document_count,
        deletedBy: tx.actor.id,
        at: now(),
      });
      const storage = ctx.providers.get<BlobStorage>('storage');
      if (storage) for (const b of blobs) await storage.delete(b.blob_key).catch(() => false);
      return json({ removed: true, documents: base.document_count });
    }),
  });

  ctx.http.route({
    ...uploadKnowledgeDocumentRoute,
    rawBody: true,
    schema: { query: UploadKnowledgeDocumentQuery, response: UploadKnowledgeDocumentResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = KnowledgeBaseParams.parse(req.params);
      const query = UploadKnowledgeDocumentQuery.parse(req.query);
      const team = await requireTeam(tx, params.slug);
      await requireManage(tx, team);
      requireWritable(team);
      const base = await requireBase(tx, team, params.base);
      const source = req.stream;
      if (!source) throw invalid('The body must be the file');
      const drain = (): void => void (source as ReadableLike).resume?.();
      const name = cleanName(req.headers['x-file-name']) ?? cleanName(query.name);
      if (!name) {
        drain();
        throw invalid('Say what the file is called (the name= part of the address).');
      }
      const kind = kindOfName(name);
      if (!kind) {
        drain();
        throw new HttpError(415, 'validation_failed', 'Only Markdown, text, CSV and PDF files can be added so far.');
      }
      const limit = maxExtractBytes();
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        drain();
        throw tooLarge(`That file is larger than the ${Math.floor(limit / 1024 / 1024)} MB limit.`);
      }
      const storage = storageOf();
      const release = takeUploadSlot(tx.actor.id);
      if (!release) {
        drain();
        throw new HttpError(429, 'rate_limited', 'Too many uploads at once: wait for one to finish.');
      }
      const body = tapped(source);
      let stored;
      try {
        stored = await storage.put(body.stream, { maxBytes: limit });
      } catch (err) {
        body.drain();
        if (err instanceof BlobTooLargeError) throw tooLarge(`That file is larger than the ${Math.floor(limit / 1024 / 1024)} MB limit.`);
        throw invalid('The upload was interrupted.');
      } finally {
        release();
      }
      try {
        if (stored.size === 0) throw invalid('That file is empty.');
        const bytes = await readBlob(storage, stored.blobKey, limit);
        if (!bytes) throw invalid('The upload could not be read back. Try again.');
        const result = await ingest(ctx, tx, refOf(team, base), {
          name,
          kind,
          bytes,
          sha256: stored.sha256,
          size: stored.size,
          blobKey: stored.blobKey,
          source: 'upload',
        });
        for (const key of result.blobsToDelete) await storage.delete(key).catch(() => false);
        return json({ outcome: result.outcome, document: toDocument(result.document) });
      } catch (err) {
        // The row never committed (the transaction rolls back): do not leave bytes nobody can reach.
        await storage.delete(stored.blobKey).catch(() => false);
        throw err;
      }
    }),
  });

  ctx.http.route({
    ...deleteKnowledgeDocumentRoute,
    schema: { response: DeleteKnowledgeDocumentResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = KnowledgeDocumentParams.parse(req.params);
      const team = await requireTeam(tx, params.slug);
      await requireManage(tx, team);
      requireWritable(team);
      const base = await requireBase(tx, team, params.base);
      const doc = (await tx.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${DOC_FROM} WHERE d.base_id = $1 AND d.id = $2`, [base.id, params.documentId])).rows[0];
      if (!doc) throw notFound('That document is not in this knowledge base.');
      await tx.query('DELETE FROM app.knowledge_documents WHERE id = $1', [doc.id]);
      await ctx.audit.emit(tx, {
        type: 'knowledge.document.removed',
        workspaceId: team.workspace_id,
        teamId: team.id,
        baseId: base.id,
        documentId: doc.id,
        removedBy: tx.actor.id,
        at: now(),
      });
      await removeFromRepo(ctx, tx, refOf(team, base), doc.repo_path);
      if (doc.blob_key) await storageOf().delete(doc.blob_key).catch(() => false);
      return json({ removed: true });
    }),
  });

  ctx.http.route({
    ...resyncKnowledgeBaseRoute,
    schema: { response: ResyncKnowledgeBaseResponse },
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = KnowledgeBaseParams.parse(req.params);
      const team = await requireTeam(tx, params.slug);
      await requireManage(tx, team);
      requireWritable(team);
      const base = await requireBase(tx, team, params.base);
      const result = await resyncBase(ctx, tx, refOf(team, base), maxExtractBytes());
      const fresh = await requireBase(tx, team, params.base);
      return json({ result, base: toBase(fresh), documents: (await documentsOf(tx, base.id)).map(toDocument) });
    }),
  });

  ctx.http.route({
    ...searchKnowledgeRoute,
    schema: { query: SearchKnowledgeQuery, response: SearchKnowledgeResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = KnowledgeBaseParams.parse(req.params);
      const q = SearchKnowledgeQuery.parse(req.query);
      const team = await requireTeam(tx, params.slug);
      const base = await requireBase(tx, team, params.base);
      const hits = await searchKnowledge(tx, { teamId: team.id, baseSlugs: [base.slug], query: q.q, limit: q.limit });
      return json({ mode: 'lexical', hits });
    }),
  });

  ctx.http.route({
    ...getKnowledgeChunkRoute,
    schema: { response: GetKnowledgeChunkResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const params = KnowledgeChunkParams.parse(req.params);
      const team = await requireTeam(tx, params.slug);
      const hit = await getChunk(tx, params.chunkId, team.id);
      if (!hit) throw notFound('That passage is gone: its version was replaced long ago.');
      return json({ hit });
    }),
  });
}
