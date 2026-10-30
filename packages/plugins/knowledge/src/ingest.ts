import { createHash } from 'node:crypto';
import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { chunkText } from './chunk.ts';
import { extractText, ExtractError, type ExtractKind } from './extract/index.ts';
import { DOC_COLUMNS, DOC_FROM, repoFolderOf, type DocRow } from './rows.ts';

// Taking a file into a base (PLAN P8-07, P8-08): read it, cut it into passages, index them, keep the converted text in the team repo.
//  * The same content again changes nothing (no new version, no new passages).
//  * Changed content makes version + 1: the new passages are added and the old version's stay (the last few) so an earlier citation still resolves.
//  * A file that cannot be read becomes a `failed` document with a plain reason - or, when the document was already indexed, keeps its good version.
// The caller holds nothing; this takes the base's lock itself so two uploads of one name take turns.

export interface BaseRef {
  id: string;
  teamId: string;
  workspaceId: string;
  slug: string;
}

export interface IngestFile {
  name: string;
  kind: ExtractKind;
  /** How to read the bytes when that differs from the document's kind (an edited converted copy of a PDF is Markdown). */
  extractAs?: ExtractKind;
  bytes: Uint8Array;
  sha256: string;
  size: number;
  /** Where the original is in blob storage (an upload); null for a file that lives in the repo. */
  blobKey: string | null;
  source: 'upload' | 'repo';
  /** For a repo file: its path and git blob id. */
  repoPath?: string;
  repoSha?: string;
}

export interface IngestResult {
  outcome: 'added' | 'updated' | 'unchanged' | 'failed';
  document: DocRow;
  /** Blobs nothing refers to any more (the caller deletes them after it has answered). */
  blobsToDelete: string[];
}

/** How many versions of a document's passages are kept (the newest). */
export const KEEP_VERSIONS = 5;
const NEWER_UNREADABLE = 'The newer file could not be read';
/** The converted copy in the repo is skipped over this many bytes (the repo writer takes 1 MB). */
const REPO_COPY_MAX_BYTES = 1_000_000;

const EXTENSIONS: Record<string, ExtractKind> = { md: 'markdown', markdown: 'markdown', txt: 'text', text: 'text', log: 'text', csv: 'csv', pdf: 'pdf' };

/** The kind a file name stands for, or null when no extractor reads it yet. */
export function kindOfName(name: string): ExtractKind | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export async function lockBase(tx: PluginTx, baseId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`knowledge_base:${baseId}`]);
}

/** Runs `fn` so that a failure leaves the transaction usable: the repo write is the one step that may fail for reasons outside the database. */
export async function attempt<T>(tx: PluginTx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  await tx.query('SAVEPOINT knowledge_attempt');
  try {
    const value = await fn();
    await tx.query('RELEASE SAVEPOINT knowledge_attempt');
    return { ok: true, value };
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT knowledge_attempt');
    await tx.query('RELEASE SAVEPOINT knowledge_attempt');
    return { ok: false, error };
  }
}

export async function sourceIdOf(tx: PluginTx, baseId: string, kind: 'upload' | 'repo'): Promise<string> {
  const row = (await tx.query<{ id: string }>('SELECT id FROM app.knowledge_sources WHERE base_id = $1 AND kind = $2', [baseId, kind])).rows[0];
  if (!row) throw new Error(`knowledge base ${baseId} has no ${kind} source`);
  return row.id;
}

/** A name for the converted file: letters, digits and dashes, unique in the base. */
async function slugFor(tx: PluginTx, baseId: string, name: string, ownId: string | null): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const clean =
    stem
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70)
      .replace(/-+$/g, '') || 'document';
  for (let n = 1; n <= 200; n++) {
    const candidate = n === 1 ? clean : `${clean}-${n}`;
    const taken = await tx.query('SELECT 1 FROM app.knowledge_documents WHERE base_id = $1 AND slug = $2 AND ($3::uuid IS NULL OR id <> $3)', [baseId, candidate, ownId]);
    if (taken.rows.length === 0) return candidate;
  }
  return `${clean}-${sha256Hex(name).slice(0, 8)}`;
}

export async function findDocument(tx: PluginTx, baseId: string, by: { name: string } | { id: string }): Promise<DocRow | undefined> {
  const res =
    'id' in by
      ? await tx.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${DOC_FROM} WHERE d.base_id = $1 AND d.id = $2`, [baseId, by.id])
      : await tx.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${DOC_FROM} WHERE d.base_id = $1 AND lower(d.name) = lower($2)`, [baseId, by.name]);
  return res.rows[0];
}

async function insertChunks(tx: PluginTx, doc: { id: string; base_id: string; team_id: string }, version: number, chunks: ReturnType<typeof chunkText>['chunks']): Promise<void> {
  const BATCH = 200;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const part = chunks.slice(i, i + BATCH);
    await tx.query(
      `INSERT INTO app.knowledge_chunks (document_id, base_id, team_id, ordinal, version, text, section, char_start, char_end)
       SELECT $1, $2, $3, u.o, $4, u.t, u.s, u.a, u.b
         FROM unnest($5::int[], $6::text[], $7::text[], $8::int[], $9::int[]) AS u(o, t, s, a, b)`,
      [doc.id, doc.base_id, doc.team_id, version, part.map((c) => c.ordinal), part.map((c) => c.text), part.map((c) => c.section), part.map((c) => c.start), part.map((c) => c.end)],
    );
  }
}

const noteOf = (parts: Array<string | null>): string | null => {
  const text = parts.filter((p): p is string => p !== null).join(' ');
  return text.length === 0 ? null : text.slice(0, 400);
};

/** The converted file: a small header (so the file says where it came from) and the text exactly as it was indexed. */
export function convertedFile(name: string, sha: string, version: number, text: string): string {
  const header = `---\ntitle: ${JSON.stringify(name)}\nsource_sha256: ${sha}\nversion: ${version}\n---\n\n`;
  return header + text;
}

/** The text of a converted file without its header; the offsets of the passages count from here. */
export function bodyOfConverted(file: string): string {
  if (!file.startsWith('---\n')) return file;
  const end = file.indexOf('\n---\n', 4);
  if (end < 0) return file;
  return file.slice(end + 5).replace(/^\n/, '');
}

async function sourcesYaml(tx: PluginTx, baseId: string): Promise<string> {
  const rows = (await tx.query<{ name: string; slug: string; kind: string; version: number; sha256: string; status: string; source: string }>(
    `SELECT d.name, d.slug, d.kind, d.version, d.sha256, d.status, s.kind AS source FROM ${DOC_FROM} WHERE d.base_id = $1 ORDER BY d.name`,
    [baseId],
  )).rows;
  const lines = ['# Written by manythreads from the documents of this knowledge base. Change documents in the app; this file is rebuilt.', 'documents:'];
  if (rows.length === 0) lines[1] = 'documents: []';
  for (const r of rows) {
    lines.push(`  - name: ${JSON.stringify(r.name)}`, `    file: ${JSON.stringify(`${r.slug}.md`)}`, `    from: ${r.source}`, `    kind: ${r.kind}`, `    version: ${r.version}`, `    sha256: ${r.sha256.slice(0, 12)}`, `    status: ${r.status}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Commits the converted copy (and the rebuilt sources.yaml) to the team repo in one commit. A repo that refuses must not undo the index: the
 * caller keeps the document and says so in its reason. Returns the git blob id of the converted file.
 */
async function writeRepo(
  ctx: PluginContext,
  tx: PluginTx,
  base: BaseRef,
  changes: Array<{ path: string; op: 'put'; content: string } | { path: string; op: 'delete' }>,
  message: string,
): Promise<{ blobShas: Map<string, string | null> } | null> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return null;
  const written = await attempt(tx, () => repo.write(tx, base.teamId, { id: tx.actor.id, kind: tx.actor.kind }, changes, message));
  if (!written.ok) return null;
  return { blobShas: new Map(written.value.paths.map((p) => [p.path, p.blobSha])) };
}

/**
 * Where a new document's converted copy goes: `knowledge/<base>/<slug>.md`, or the next free `<slug>-2.md` when a file of the team already sits there
 * (a Markdown file someone put in the folder and nobody has re-read yet is theirs, and an upload must not overwrite it).
 */
async function freeRepoPath(ctx: PluginContext, tx: PluginTx, base: BaseRef, slug: string): Promise<string> {
  const folder = repoFolderOf(base.slug);
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return `${folder}/${slug}.md`;
  let taken: Set<string>;
  try {
    taken = new Set((await repo.list(tx, base.teamId, folder)).map((e) => e.path));
  } catch {
    return `${folder}/${slug}.md`;
  }
  for (let n = 1; n <= 200; n++) {
    const candidate = `${folder}/${n === 1 ? slug : `${slug}-${String(n)}`}.md`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${folder}/${slug}-${sha256Hex(slug).slice(0, 8)}.md`;
}

/** Rebuilds `sources.yaml` and deletes a document's converted file (a removed document). Failures are ignored: the index is the truth. */
export async function removeFromRepo(ctx: PluginContext, tx: PluginTx, base: BaseRef, repoPath: string | null): Promise<void> {
  const changes: Array<{ path: string; op: 'put'; content: string } | { path: string; op: 'delete' }> = [
    { path: `${repoFolderOf(base.slug)}/sources.yaml`, op: 'put', content: await sourcesYaml(tx, base.id) },
  ];
  if (repoPath) changes.push({ path: repoPath, op: 'delete' });
  await writeRepo(ctx, tx, base, changes, 'Knowledge: remove a document');
}

async function emitAdded(ctx: PluginContext, tx: PluginTx, base: BaseRef, doc: DocRow, replaced: boolean): Promise<void> {
  await ctx.audit.emit(tx, {
    type: 'knowledge.document.added',
    workspaceId: base.workspaceId,
    teamId: base.teamId,
    baseId: base.id,
    documentId: doc.id,
    kind: doc.kind,
    status: doc.status,
    size: Number(doc.size),
    version: doc.version,
    replaced,
    chunks: doc.chunk_count,
    addedBy: tx.actor.id,
    at: ctx.runtime.now().toISOString(),
  });
}

export async function ingest(ctx: PluginContext, tx: PluginTx, base: BaseRef, file: IngestFile, match?: { id: string }): Promise<IngestResult> {
  await lockBase(tx, base.id);
  const existing = await findDocument(tx, base.id, match ?? { name: file.name });
  const blobsToDelete: string[] = [];
  const dropNewBlob = (): void => {
    if (file.blobKey && file.blobKey !== existing?.blob_key) blobsToDelete.push(file.blobKey);
  };

  // The same bytes again: nothing moves.
  if (existing && existing.sha256 === file.sha256 && existing.status === 'indexed') {
    dropNewBlob();
    // the file that could not be read is no longer the newest one: put the old warning away (the only write an upload of the same content makes)
    if (existing.reason?.startsWith(NEWER_UNREADABLE)) {
      const cleared = (await tx.query<DocRow>(`UPDATE app.knowledge_documents d SET reason = NULL FROM app.knowledge_sources s WHERE d.id = $1 AND s.id = d.source_id RETURNING ${DOC_COLUMNS}`, [existing.id])).rows[0];
      if (cleared) return { outcome: 'unchanged', document: cleared, blobsToDelete };
    }
    return { outcome: 'unchanged', document: existing, blobsToDelete };
  }

  let extracted;
  let failure: string | null = null;
  try {
    extracted = await extractText(file.bytes, file.extractAs ?? file.kind);
  } catch (err) {
    failure = err instanceof ExtractError ? err.message : 'This file could not be read.';
  }
  const chunked = extracted ? chunkText(extracted.text, extracted.metadata.sections) : null;
  if (extracted && chunked && chunked.chunks.length === 0) failure = 'No text was found in this file.';

  if (failure !== null || !extracted || !chunked) {
    const reason = failure ?? 'This file could not be read.';
    if (existing && existing.status === 'indexed') {
      // The good version stays in use; the document says the newer file was not read.
      dropNewBlob();
      const kept = (
        await tx.query<DocRow>(
          `UPDATE app.knowledge_documents d SET reason = $2, updated_at = now() FROM app.knowledge_sources s
            WHERE d.id = $1 AND s.id = d.source_id RETURNING ${DOC_COLUMNS}`,
          [existing.id, `${NEWER_UNREADABLE}, so version ${existing.version} is still in use. ${reason}`.slice(0, 400)],
        )
      ).rows[0] as DocRow;
      return { outcome: 'failed', document: kept, blobsToDelete };
    }
    if (existing) {
      if (existing.blob_key && existing.blob_key !== file.blobKey) blobsToDelete.push(existing.blob_key);
      const row = (
        await tx.query<DocRow>(
          `UPDATE app.knowledge_documents d SET sha256 = $2, size = $3, blob_key = $4, reason = $5, kind = $6, updated_at = now()
             FROM app.knowledge_sources s WHERE d.id = $1 AND s.id = d.source_id RETURNING ${DOC_COLUMNS}`,
          [existing.id, file.sha256, file.size, file.blobKey, reason.slice(0, 400), file.kind],
        )
      ).rows[0] as DocRow;
      // a retry that fails the same way is not news
      if (existing.sha256 !== file.sha256 || existing.reason !== row.reason) await emitAdded(ctx, tx, base, row, true);
      return { outcome: 'failed', document: row, blobsToDelete };
    }
    const sourceId = await sourceIdOf(tx, base.id, file.source);
    const slug = await slugFor(tx, base.id, file.name, null);
    const inserted = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, status, reason, blob_key, repo_path, repo_sha, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'failed', $9, $10, $11, $12, $13) RETURNING id`,
        [base.id, base.teamId, sourceId, file.name, slug, file.kind, file.size, file.sha256, reason.slice(0, 400), file.blobKey, file.repoPath ?? null, file.repoSha ?? null, tx.actor.id],
      )
    ).rows[0] as { id: string };
    const row = (await findDocument(tx, base.id, { id: inserted.id })) as DocRow;
    await emitAdded(ctx, tx, base, row, false);
    return { outcome: 'failed', document: row, blobsToDelete };
  }

  // Readable: a new document, or a new version of one that changed.
  const version = existing ? existing.version + 1 : 1;
  const notes: Array<string | null> = [
    extracted.metadata.truncated || chunked.truncated ? 'This file is very long, so only its start is searchable.' : null,
  ];
  let docId: string;
  if (existing) {
    docId = existing.id;
    if (existing.blob_key && existing.blob_key !== file.blobKey) blobsToDelete.push(existing.blob_key);
    await tx.query(
      `UPDATE app.knowledge_documents SET sha256 = $2, size = $3, blob_key = $4, kind = $5, version = $6, status = 'indexed', reason = NULL, chunk_count = $7,
              indexed_at = now(), updated_at = now() WHERE id = $1`,
      [existing.id, file.sha256, file.size, file.blobKey, file.kind, version, chunked.chunks.length],
    );
  } else {
    const sourceId = await sourceIdOf(tx, base.id, file.source);
    const slug = await slugFor(tx, base.id, file.name, null);
    docId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, version, status, blob_key, repo_path, repo_sha, chunk_count, indexed_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'indexed', $9, $10, $11, $12, now(), $13) RETURNING id`,
        [base.id, base.teamId, sourceId, file.name, slug, file.kind, file.size, file.sha256, file.blobKey, file.repoPath ?? null, file.repoSha ?? null, chunked.chunks.length, tx.actor.id],
      )
    ).rows[0]!.id;
  }
  await insertChunks(tx, { id: docId, base_id: base.id, team_id: base.teamId }, version, chunked.chunks);
  await tx.query('DELETE FROM app.knowledge_chunks WHERE document_id = $1 AND version <= $2', [docId, version - KEEP_VERSIONS]);

  // The converted copy in the team repo (an uploaded file; a repo file already is one). It is a convenience: a refusal is noted, not fatal.
  let doc = (await findDocument(tx, base.id, { id: docId })) as DocRow;
  if (file.source === 'upload') {
    const path = doc.repo_path ?? (await freeRepoPath(ctx, tx, base, doc.slug));
    const content = convertedFile(file.name, file.sha256, version, extracted.text);
    if (Buffer.byteLength(content) > REPO_COPY_MAX_BYTES) {
      notes.push('Too large to keep a readable copy in the team files.');
      await tx.query('UPDATE app.knowledge_documents SET repo_path = NULL, repo_sha = NULL WHERE id = $1', [docId]);
    } else {
      const written = await writeRepo(
        ctx,
        tx,
        base,
        [
          { path, op: 'put', content },
          { path: `${repoFolderOf(base.slug)}/sources.yaml`, op: 'put', content: await sourcesYaml(tx, base.id) },
        ],
        `Knowledge: ${file.name} (version ${version})`,
      );
      if (written) {
        await tx.query('UPDATE app.knowledge_documents SET repo_path = $2, repo_sha = $3 WHERE id = $1', [docId, path, written.blobShas.get(path) ?? null]);
      } else {
        notes.push('A readable copy could not be saved to the team files.');
        await tx.query('UPDATE app.knowledge_documents SET repo_path = NULL, repo_sha = NULL WHERE id = $1', [docId]);
      }
    }
  } else {
    await tx.query('UPDATE app.knowledge_documents SET repo_path = $2, repo_sha = $3 WHERE id = $1', [docId, file.repoPath ?? null, file.repoSha ?? null]);
  }
  const reason = noteOf(notes);
  await tx.query('UPDATE app.knowledge_documents SET reason = $2 WHERE id = $1', [docId, reason]);
  doc = (await findDocument(tx, base.id, { id: docId })) as DocRow;
  await emitAdded(ctx, tx, base, doc, existing !== undefined);
  return { outcome: existing ? 'updated' : 'added', document: doc, blobsToDelete };
}
