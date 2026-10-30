import type { BlobStorage, PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import type { KnowledgeResyncResult } from '@manythreads/shared';
import { bodyOfConverted, findDocument, ingest, kindOfName, lockBase, removeFromRepo, sha256Hex, type BaseRef } from './ingest.ts';
import { DOC_COLUMNS, DOC_FROM, repoFolderOf, type DocRow } from './rows.ts';

// Re-sync (PLAN P8-08): read the base again and move what changed.
//  * a document that failed is tried again from the original in blob storage;
//  * a converted file someone edited in the team repo becomes a new version of its document;
//  * a Markdown or text file someone put in the base's folder becomes a document of its own (source `repo`);
//  * a repo-sourced document whose file is gone is removed.
// Nothing here fetches from the outside world. Unchanged files cost one comparison of a hash, no extraction.

const MAX_REPO_FILE_BYTES = 1_000_000;

async function readAll(stream: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of stream) {
    total += part.length;
    if (total > maxBytes) return null;
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export async function readBlob(storage: BlobStorage, blobKey: string, maxBytes: number): Promise<Uint8Array | null> {
  try {
    return await readAll(await storage.get(blobKey), maxBytes);
  } catch {
    return null;
  }
}

export async function resyncBase(ctx: PluginContext, tx: PluginTx, base: BaseRef, maxBytes: number): Promise<KnowledgeResyncResult> {
  await lockBase(tx, base.id);
  const counts = { checked: 0, unchanged: 0, updated: 0, added: 0, removed: 0, failed: 0 };
  const repo = ctx.providers.get<RepoProvider>('repo');
  const storage = ctx.providers.get<BlobStorage>('storage');
  const blobsToDelete: string[] = [];
  const folder = repoFolderOf(base.slug);

  const docs = (await tx.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${DOC_FROM} WHERE d.base_id = $1 ORDER BY d.created_at, d.id`, [base.id])).rows;

  let entries: Awaited<ReturnType<RepoProvider['list']>> = [];
  let repoReadable = false;
  if (repo) {
    try {
      entries = await repo.list(tx, base.teamId, folder);
      repoReadable = true;
    } catch {
      repoReadable = false;
    }
  }
  const files = new Map(entries.filter((e) => e.kind === 'file').map((e) => [e.path, e]));

  const record = (outcome: string): void => {
    if (outcome === 'added') counts.added += 1;
    else if (outcome === 'updated') counts.updated += 1;
    else if (outcome === 'failed') counts.failed += 1;
    else counts.unchanged += 1;
  };

  for (const doc of docs) {
    counts.checked += 1;
    const entry = doc.repo_path ? files.get(doc.repo_path) : undefined;

    // A repo-sourced document whose file is gone.
    if (doc.source_kind === 'repo' && repoReadable && doc.repo_path && !entry) {
      await tx.query('DELETE FROM app.knowledge_documents WHERE id = $1', [doc.id]);
      await ctx.audit.emit(tx, {
        type: 'knowledge.document.removed',
        workspaceId: base.workspaceId,
        teamId: base.teamId,
        baseId: base.id,
        documentId: doc.id,
        removedBy: tx.actor.id,
        at: ctx.runtime.now().toISOString(),
      });
      counts.removed += 1;
      continue;
    }

    // The converted file (or a repo file) was edited in the repo: its content is the new version.
    if (repo && entry && entry.blobSha && doc.repo_sha !== null && entry.blobSha !== doc.repo_sha) {
      let bytes: Uint8Array | null = null;
      if ((entry.size ?? 0) <= MAX_REPO_FILE_BYTES) {
        try {
          bytes = (await repo.blob(tx, base.teamId, doc.repo_path as string, 'main', MAX_REPO_FILE_BYTES)).content;
        } catch {
          bytes = null;
        }
      }
      if (bytes) {
        const body = doc.source_kind === 'upload' ? bodyOfConverted(Buffer.from(bytes).toString('utf8')) : Buffer.from(bytes).toString('utf8');
        const bodyBytes = Buffer.from(body, 'utf8');
        const result = await ingest(
          ctx,
          tx,
          base,
          {
            name: doc.name,
            kind: doc.kind,
            extractAs: doc.source_kind === 'upload' ? 'markdown' : doc.kind,
            bytes: bodyBytes,
            sha256: sha256Hex(bodyBytes),
            size: doc.source_kind === 'upload' ? Number(doc.size) : bodyBytes.length,
            blobKey: doc.blob_key,
            source: 'repo',
            repoPath: doc.repo_path as string,
            repoSha: entry.blobSha,
          },
          { id: doc.id },
        );
        blobsToDelete.push(...result.blobsToDelete);
        record(result.outcome);
        continue;
      }
    }

    // A document that failed is tried again from the original.
    if (doc.status === 'failed' && doc.blob_key && storage) {
      const bytes = await readBlob(storage, doc.blob_key, maxBytes);
      if (bytes) {
        const result = await ingest(
          ctx,
          tx,
          base,
          { name: doc.name, kind: doc.kind, bytes, sha256: doc.sha256, size: bytes.length, blobKey: doc.blob_key, source: doc.source_kind },
          { id: doc.id },
        );
        blobsToDelete.push(...result.blobsToDelete);
        record(result.outcome === 'added' ? 'updated' : result.outcome);
        continue;
      }
      counts.failed += 1;
      continue;
    }
    counts.unchanged += 1;
  }

  // New Markdown / text files in the base's folder.
  if (repo && repoReadable) {
    const known = new Set(docs.map((d) => d.repo_path).filter((p): p is string => p !== null));
    for (const entry of files.values()) {
      if (known.has(entry.path) || !entry.blobSha) continue;
      const kind = kindOfName(entry.name);
      if (kind !== 'markdown' && kind !== 'text') continue;
      counts.checked += 1;
      const clash = await findDocument(tx, base.id, { name: entry.name });
      if (clash || (entry.size ?? 0) > MAX_REPO_FILE_BYTES) {
        counts.failed += 1;
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = (await repo.blob(tx, base.teamId, entry.path, 'main', MAX_REPO_FILE_BYTES)).content;
      } catch {
        counts.failed += 1;
        continue;
      }
      const result = await ingest(ctx, tx, base, {
        name: entry.name,
        kind,
        bytes,
        sha256: sha256Hex(bytes),
        size: bytes.length,
        blobKey: null,
        source: 'repo',
        repoPath: entry.path,
        repoSha: entry.blobSha,
      });
      record(result.outcome);
    }
  }

  if (counts.removed > 0 && repo) await removeFromRepo(ctx, tx, base, null);
  const when = ctx.runtime.now();
  await tx.query('UPDATE app.knowledge_sources SET last_synced_at = $2, error = NULL WHERE base_id = $1', [base.id, when]);
  if (counts.updated + counts.added + counts.removed + counts.failed > 0) {
    await ctx.audit.emit(tx, {
      type: 'knowledge.base.resynced',
      workspaceId: base.workspaceId,
      teamId: base.teamId,
      baseId: base.id,
      checked: counts.checked,
      updated: counts.updated,
      added: counts.added,
      removed: counts.removed,
      failed: counts.failed,
      resyncedBy: tx.actor.id,
      at: when.toISOString(),
    });
  }
  if (storage) for (const key of blobsToDelete) await storage.delete(key).catch(() => false);
  return { ...counts, at: when.toISOString() };
}
