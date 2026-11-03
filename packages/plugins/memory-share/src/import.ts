import type { InboxImporter, InboxImportInput, InboxImportResult, PluginContext, PluginTx, RepoProvider, RepoWriteChange } from '@manythreads/sdk';
import { OKF_BUNDLE_MAX_FILE_BYTES, OKF_BUNDLE_MAX_FILES, type DigestImportRefusal, type MemoryDigestImportedEvent } from '@manythreads/shared';
import { FOREIGN_BUNDLE_MAX_BYTES, prepareBundle, withoutSingleRoot, type BundleKind } from './bundle.ts';
import { fingerprint } from './digest.ts';
import { SHARING_OFF_REASON, sharingEnabled } from './util.ts';
import { ZipRefusal, readZipText } from './zip.ts';

// The receiving side (PLAN P8-25; SPEC §12.3): the `inbox.importer` the memory inbox hands a bundle to. It is the fast path: another team's digest, or an OKF bundle dropped from
// outside, is already memory-shaped, so no model reads it. The bundle is judged whole (bundle.ts), and either every file is filed in one go or none is, with a plain reason.
//
// A digest a team delivered is NOT read from anything the inbox item carries. The delivery wrote an item with no file; the words are read here from the run that was approved
// (checked against the digest's fingerprint), and the sender, the destination and the link are read again from the database. A forged item, an item for another team, or a link
// that was paused or ended since the hand-over is refused. A bundle dropped as a file is read from its bytes, with every limit of zip.ts.

/**
 * A digest goes under `memory/shared/team-<sender's team slug>/`; a bundle from outside under `memory/shared/external/<name>/`. Every digest folder starts with `team-` and the
 * outside folder never does, so no team name (`external` and `team-external` included) can land in the other's folder, and two teams never share one.
 */
const FOLDER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EXTERNAL = 'external';
const TEAM_PREFIX = 'team-';

export function digestFolder(slug: string): string | null {
  return FOLDER.test(slug) ? `${TEAM_PREFIX}${slug}` : null;
}

/** The folder name of a bundle dropped from outside: its file name without the extension, lower case, letters, digits and dashes. */
export function externalFolder(name: string): string {
  const base = name.split('/').pop() ?? name;
  const stem = base.replace(/\.(zip|okf)$/i, '');
  const clean = stem
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${EXTERNAL}/${clean === '' ? 'bundle' : clean}`;
}

/** Commits are written in steps of this many files (the repository writer takes 200 changes in one commit). */
const CHANGES_PER_COMMIT = 190;

interface DeliveryRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  dest_team_id: string;
  share_id: string;
  from_slug: string;
  period: string;
  digest_sha: string;
  run_sha: string | null;
  bundle: unknown;
  link_state: string | null;
  /** The share's status now, and whether the destination team has been archived since the hand-over. */
  share_status: string | null;
  dest_archived: boolean;
}

const refused = (code: DigestImportRefusal, message: string, fromTeamId: string | null): InboxImportResult => ({ outcome: 'refused', code, message, fromTeamId });

function asFiles(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text !== 'string') return null;
    files[path] = text;
  }
  return files;
}

async function emitImported(ctx: PluginContext, tx: PluginTx, input: InboxImportInput, result: InboxImportResult): Promise<void> {
  const event: MemoryDigestImportedEvent = {
    type: 'memory.digest.imported',
    schemaVersion: 1,
    workspaceId: input.workspaceId as MemoryDigestImportedEvent['workspaceId'],
    teamId: input.teamId as MemoryDigestImportedEvent['teamId'],
    itemId: input.itemId as MemoryDigestImportedEvent['itemId'],
    fromTeamId: result.fromTeamId as MemoryDigestImportedEvent['fromTeamId'],
    outcome: result.outcome,
    reason: result.outcome === 'refused' ? result.code as DigestImportRefusal : null,
    files: result.outcome === 'filed' ? result.files : 0,
    bytes: result.outcome === 'filed' ? result.bytes : 0,
    at: ctx.runtime.now().toISOString(),
  };
  await ctx.audit.emit(tx, event);
}

/** What a digest delivered to this team says it is, read from the database by the item the delivery wrote. Null when no delivery wrote this item for this team. */
async function readDelivery(tx: PluginTx, input: InboxImportInput): Promise<DeliveryRow | null> {
  const row = (
    await tx.query<DeliveryRow>(
      `SELECT d.id, d.workspace_id, d.team_id, d.dest_team_id, d.share_id, d.from_slug, d.period, d.digest_sha, r.digest_sha AS run_sha, r.bundle, l.state AS link_state,
              s.status AS share_status, (t.archived_at IS NOT NULL OR t.id IS NULL) AS dest_archived
         FROM app.memory_share_deliveries d
         JOIN app.memory_share_runs r ON r.id = d.run_id
         LEFT JOIN app.memory_shares s ON s.id = d.share_id AND s.team_id = d.team_id
         LEFT JOIN app.teams t ON t.id = d.dest_team_id AND t.workspace_id = d.workspace_id
         LEFT JOIN app.memory_share_links l ON l.share_id = d.share_id AND l.dest_team_id = d.dest_team_id
        WHERE d.item_id = $1 AND d.dest_team_id = $2 AND d.workspace_id = $3`,
      [input.itemId, input.teamId, input.workspaceId],
    )
  ).rows[0];
  return row ?? null;
}

async function writeFiles(ctx: PluginContext, tx: PluginTx, teamId: string, files: { path: string; content: string }[], message: string): Promise<string> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('the repo provider is not registered');
  let sha = '';
  for (let at = 0; at < files.length; at += CHANGES_PER_COMMIT) {
    const changes: RepoWriteChange[] = files.slice(at, at + CHANGES_PER_COMMIT).map((f) => ({ path: f.path, op: 'put', content: f.content }));
    const note = files.length > CHANGES_PER_COMMIT ? `${message} (part ${Math.floor(at / CHANGES_PER_COMMIT) + 1})` : message;
    const wrote = await repo.write(tx, teamId, { id: tx.actor.id, kind: 'system' }, changes, note.slice(0, 120));
    sha = wrote.sha;
  }
  return sha;
}

async function importDigest(ctx: PluginContext, tx: PluginTx, input: InboxImportInput): Promise<InboxImportResult> {
  const delivery = await readDelivery(tx, input);
  if (!delivery) return refused('not_found', 'No team delivered this digest to this team, so it was not filed.', null);
  const from = delivery.team_id;
  if (delivery.link_state !== 'accepted') return refused('link_ended', 'This team paused or ended the share before the digest was filed, so it was not filed.', from);
  if (delivery.share_status !== 'active') return refused('link_ended', 'The sending team stopped this share before the digest was filed, so it was not filed.', from);
  if (delivery.dest_archived) return refused('link_ended', 'This team is archived, so the digest was not filed.', from);
  if (!(await sharingEnabled(tx, delivery.workspace_id))) return refused('link_ended', SHARING_OFF_REASON, from);
  const folder = digestFolder(delivery.from_slug);
  if (folder === null) return refused('unsafe_path', 'The sending team’s name cannot be used as a folder, so the digest was not filed.', from);
  const files = asFiles(delivery.bundle);
  if (files === null) return refused('not_a_bundle', 'The digest’s files are missing or damaged.', from);
  // the words are the ones that were approved: the fingerprint of the stored files must be the one the delivery and the item carry
  if (fingerprint(files) !== delivery.digest_sha || delivery.run_sha !== delivery.digest_sha || input.sha256 !== delivery.digest_sha) {
    return refused('not_a_bundle', 'The digest is not the one that was approved, so it was not filed.', from);
  }
  const prepared = prepareBundle({ files, kind: 'digest', folder, fromTeamId: from, now: ctx.runtime.now() });
  if (!prepared.ok) return refused(prepared.code, prepared.message, from);
  const commitSha = await writeFiles(ctx, tx, input.teamId, prepared.files, `Shared memory from ${delivery.from_slug}: ${delivery.period}`);
  return { outcome: 'filed', paths: prepared.files.map((f) => f.path), commitSha, files: prepared.files.length, bytes: prepared.bytes, fromTeamId: from };
}

async function importExternal(ctx: PluginContext, tx: PluginTx, input: InboxImportInput): Promise<InboxImportResult> {
  if (input.bytes === null) return refused('not_a_bundle', 'The bundle’s file is missing, so there is nothing to file.', null);
  let raw: Map<string, string>;
  try {
    raw = readZipText(input.bytes, { maxEntries: OKF_BUNDLE_MAX_FILES, maxTotalBytes: FOREIGN_BUNDLE_MAX_BYTES, maxFileBytes: OKF_BUNDLE_MAX_FILE_BYTES });
  } catch (error) {
    if (error instanceof ZipRefusal) return refused(error.code, error.message, null);
    throw error;
  }
  const folder = externalFolder(input.name);
  const kind: BundleKind = 'external';
  const prepared = prepareBundle({ files: withoutSingleRoot(raw), kind, folder, fromTeamId: null, now: ctx.runtime.now() });
  if (!prepared.ok) return refused(prepared.code, prepared.message, null);
  const commitSha = await writeFiles(ctx, tx, input.teamId, prepared.files, `Import bundle ${input.name}`.replace(/\s+/g, ' '));
  return { outcome: 'filed', paths: prepared.files.map((f) => f.path), commitSha, files: prepared.files.length, bytes: prepared.bytes, fromTeamId: null };
}

/** The `inbox.importer` provider: look it up with `ctx.providers.get('inbox.importer')`. */
export function createImporter(ctx: PluginContext): InboxImporter {
  return {
    id: 'inbox.importer',
    async import(tx, input) {
      const result = input.origin === 'share' ? await importDigest(ctx, tx, input) : await importExternal(ctx, tx, input);
      await emitImported(ctx, tx, input, result);
      return result;
    },
  };
}
