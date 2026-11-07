import { HttpError, forbidden, json, notFound, conflict, route, type BlobStorage, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  CreatePersonalKnowledgeBaseRequest,
  DeletePersonalKnowledgeBaseResponse,
  DeletePersonalKnowledgeDocumentResponse,
  GetPersonalKnowledgeBaseResponse,
  ListPersonalKnowledgeBasesResponse,
  PersonalKnowledgeBaseParams,
  PersonalKnowledgeBaseResponse,
  PersonalKnowledgeDocumentParams,
  PersonalSearchKnowledgeQuery,
  PersonalUploadKnowledgeQuery,
  SearchPersonalKnowledgeResponse,
  UploadPersonalKnowledgeDocumentResponse,
  createPersonalKnowledgeBaseRoute,
  deletePersonalKnowledgeBaseRoute,
  deletePersonalKnowledgeDocumentRoute,
  getPersonalKnowledgeBaseRoute,
  listPersonalKnowledgeBasesRoute,
  searchPersonalKnowledgeRoute,
  uploadPersonalKnowledgeDocumentRoute,
} from '@manythreads/shared';
import { embedderOf } from './embed.ts';
import { queryVector } from './capability.ts';
import type { BaseRef } from './ingest.ts';
import { BASE_SELECT, DOC_COLUMNS, DOC_FROM, SOURCE_COLUMNS, toDocument, toPersonalBase, toSource, type BaseRow, type DocRow, type SourceRow } from './rows.ts';
import { receiveUpload } from './routes.ts';
import { searchKnowledge } from './search.ts';

// A person's own knowledge bases (P20-06): the same bases, documents and passages as a team's, in their Personal space. Only the owner reads and writes
// them here (the policies also let an admin read during a live audited open, which these routes do not use); a guest has no Personal space. A bot reads
// them through `knowledge.search` only when the person allows it (bots 0026). docs/plugins/knowledge.md.

interface Me {
  personId: string;
  workspaceId: string;
}

/** Who is asking: an active member with a Personal space. A guest has none. */
async function requireMe(tx: PluginTx): Promise<Me> {
  const row = (await tx.query<{ person_id: string | null; role: string | null }>('SELECT app.person_id() AS person_id, app.workspace_role() AS role')).rows[0];
  if (!row?.person_id) throw forbidden('Only a person has a Personal space.');
  if (row.role === 'guest') throw forbidden('A guest has no Personal space.');
  return { personId: row.person_id, workspaceId: tx.actor.workspaceId };
}

async function requireBase(tx: PluginTx, me: Me, slug: string): Promise<BaseRow> {
  const base = (await tx.query<BaseRow>(`${BASE_SELECT} WHERE b.owner_person_id = $1 AND b.slug = $2`, [me.personId, slug])).rows[0];
  if (!base) throw notFound(`You have no knowledge base called “${slug}”.`);
  return base;
}

const refOf = (me: Me, base: BaseRow): BaseRef => ({ id: base.id, teamId: null, ownerPersonId: me.personId, workspaceId: me.workspaceId, slug: base.slug });

export function registerPersonalRoutes(ctx: PluginContext): void {
  const now = (): string => ctx.runtime.now().toISOString();
  const searchModeNow = (): 'lexical' | 'hybrid' => (embedderOf(ctx) ? 'hybrid' : 'lexical');
  const changed = async (tx: PluginTx, me: Me, baseId: string, change: 'created' | 'deleted' | 'document_removed', documents: number): Promise<void> => {
    await ctx.audit.emit(tx, { type: 'knowledge.personal_base.changed', workspaceId: me.workspaceId, personId: me.personId, baseId, change, documents, at: now() });
  };

  ctx.http.route({
    ...listPersonalKnowledgeBasesRoute,
    schema: { response: ListPersonalKnowledgeBasesResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      const me = await requireMe(tx);
      const rows = await tx.query<BaseRow>(`${BASE_SELECT} WHERE b.owner_person_id = $1 ORDER BY lower(b.name), b.id`, [me.personId]);
      return json({ bases: rows.rows.map(toPersonalBase), searchMode: searchModeNow() });
    }),
  });

  ctx.http.route({
    ...createPersonalKnowledgeBaseRoute,
    schema: { body: CreatePersonalKnowledgeBaseRequest, response: PersonalKnowledgeBaseResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const body = CreatePersonalKnowledgeBaseRequest.parse(req.body);
      const taken = await tx.query('SELECT 1 FROM app.knowledge_bases WHERE owner_person_id = $1 AND slug = $2', [me.personId, body.slug]);
      if (taken.rows.length > 0) throw conflict(`You already have a knowledge base called “${body.slug}”.`);
      const made = (
        await tx.query<{ id: string }>(
          'INSERT INTO app.knowledge_bases (workspace_id, owner_person_id, slug, name, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [me.workspaceId, me.personId, body.slug, body.name ?? body.slug, tx.actor.id],
        )
      ).rows[0] as { id: string };
      await tx.query(`INSERT INTO app.knowledge_sources (base_id, owner_person_id, kind) VALUES ($1, $2, 'upload')`, [made.id, me.personId]);
      await changed(tx, me, made.id, 'created', 0);
      const row = (await tx.query<BaseRow>(`${BASE_SELECT} WHERE b.id = $1`, [made.id])).rows[0] as BaseRow;
      return json({ base: toPersonalBase(row) }, 201);
    }),
  });

  ctx.http.route({
    ...getPersonalKnowledgeBaseRoute,
    schema: { response: GetPersonalKnowledgeBaseResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const params = PersonalKnowledgeBaseParams.parse(req.params);
      const base = await requireBase(tx, me, params.base);
      const docs = (await tx.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${DOC_FROM} WHERE d.base_id = $1 ORDER BY lower(d.name), d.id`, [base.id])).rows;
      const sources = (await tx.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM app.knowledge_sources s WHERE s.base_id = $1 ORDER BY s.created_at, s.id`, [base.id])).rows;
      return json({ base: toPersonalBase(base), documents: docs.map(toDocument), sources: sources.map(toSource), searchMode: searchModeNow() });
    }),
  });

  ctx.http.route({
    ...deletePersonalKnowledgeBaseRoute,
    schema: { response: DeletePersonalKnowledgeBaseResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const params = PersonalKnowledgeBaseParams.parse(req.params);
      const base = await requireBase(tx, me, params.base);
      const blobs = (await tx.query<{ blob_key: string }>('SELECT blob_key FROM app.knowledge_documents WHERE base_id = $1 AND blob_key IS NOT NULL', [base.id])).rows;
      await tx.query('DELETE FROM app.knowledge_bases WHERE id = $1', [base.id]);
      await changed(tx, me, base.id, 'deleted', 0);
      const storage = ctx.providers.get<BlobStorage>('storage');
      if (storage) for (const b of blobs) await storage.delete(b.blob_key).catch(() => false);
      return json({ removed: true, documents: base.document_count });
    }),
  });

  ctx.http.route({
    ...uploadPersonalKnowledgeDocumentRoute,
    rawBody: true,
    schema: { query: PersonalUploadKnowledgeQuery, response: UploadPersonalKnowledgeDocumentResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const params = PersonalKnowledgeBaseParams.parse(req.params);
      const query = PersonalUploadKnowledgeQuery.parse(req.query);
      const base = await requireBase(tx, me, params.base);
      return await receiveUpload(ctx, tx, req, refOf(me, base), query);
    }),
  });

  ctx.http.route({
    ...deletePersonalKnowledgeDocumentRoute,
    schema: { response: DeletePersonalKnowledgeDocumentResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const params = PersonalKnowledgeDocumentParams.parse(req.params);
      const base = await requireBase(tx, me, params.base);
      const doc = (await tx.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${DOC_FROM} WHERE d.base_id = $1 AND d.id = $2`, [base.id, params.documentId])).rows[0];
      if (!doc) throw notFound('That document is not in this knowledge base.');
      await tx.query('DELETE FROM app.knowledge_documents WHERE id = $1', [doc.id]);
      const left = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.knowledge_documents WHERE base_id = $1', [base.id])).rows[0]?.n ?? 0;
      await changed(tx, me, base.id, 'document_removed', left);
      const storage = ctx.providers.get<BlobStorage>('storage');
      if (doc.blob_key) {
        if (!storage) throw new HttpError(503, 'internal', 'File storage is not available');
        await storage.delete(doc.blob_key).catch(() => false);
      }
      return json({ removed: true });
    }),
  });

  ctx.http.route({
    ...searchPersonalKnowledgeRoute,
    schema: { query: PersonalSearchKnowledgeQuery, response: SearchPersonalKnowledgeResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const params = PersonalKnowledgeBaseParams.parse(req.params);
      const q = PersonalSearchKnowledgeQuery.parse(req.query);
      const base = await requireBase(tx, me, params.base);
      const vector = await queryVector(ctx, tx, q.q);
      const hits = await searchKnowledge(tx, { teamIds: [], personId: me.personId, baseSlugs: [base.slug], query: q.q, limit: q.limit }, vector);
      return json({ mode: vector === null ? 'lexical' : 'hybrid', hits });
    }),
  });
}
