import { createHash } from 'node:crypto';
import type { PluginTx } from '@manythreads/sdk';
import { MemoryConceptSummary, validateOkfWrite, type PersonalMemoryFile, type PersonalMemoryVersion } from '@manythreads/shared';
import { toMemoryConceptSummary } from './concepts.ts';
import { isPersonOwned } from './ownership.ts';

// A person's own Memory (P20-05): the OKF bundle of ONE person, kept as rows (migration 0005), never in a git repo and never shared. This file is the
// only place the plugin reads or writes those rows. Reads run in the caller's transaction and the database's row-level security decides what they
// see (the owner; an admin only during a live audited open). Writes go through the database doors `app.memory_personal_put` / `_delete`, which decide
// who may write (the owner; the bot of a run the owner asked and allowed; the system role) — this file never decides that itself. The text of every
// write is checked first by the one shared validator (`validateOkfWrite`), the same check the team's repo writer runs.

/** What a write answered. `ok` and `unchanged` are success; the rest are refusals the caller words for its reader. */
export type PersonalPutStatus = 'ok' | 'unchanged' | 'conflict' | 'forbidden' | 'person_owned' | 'too_many_files' | 'too_large' | 'invalid';

export interface PersonalPutResult {
  status: PersonalPutStatus;
  versionNo: number;
  /** Who the database decided the writer is: `person`, `bot` or `system`; null for a refusal that did not get that far. */
  callerKind: 'person' | 'bot' | 'system' | null;
  /** The validator's sentence when `status` is `invalid`. */
  reason?: string;
}

export interface PersonalPutOptions {
  /** The version the edit started from (null: the file must not exist yet). Left out: no check (a bot's append, a restore). */
  baseVersion?: number | null;
  /** Set when the content carries a person's own authorship (an imported file a person verified); the door also sets it for a person caller. */
  personOwned?: boolean;
}

/** A git-style blob id (40 hex) of the text: the index keeps one so the shared summary shape stays the same as a team's. */
const blobShaOf = (text: string): string => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text, 'utf8').digest('hex');

const spaceOf = (ownerPersonId: string): `person:${string}` => `person:${ownerPersonId}`;

type FileRow = {
  path: string;
  content: string;
  version_no: number;
  size_bytes: number;
  updated_at: Date;
  type: string;
  title: string;
  description: string | null;
  tags: string[];
  status: string;
  stale_after: Date | null;
  trust_tier: string;
  origin: string;
  share_never: boolean;
  generated_at: Date | null;
  blob_sha: string;
};

const FILE_COLUMNS =
  'path, content, version_no, size_bytes, updated_at, type, title, description, tags, status, stale_after, trust_tier, origin, share_never, generated_at, blob_sha';
const SUMMARY_COLUMNS =
  'path, version_no, size_bytes, updated_at, type, title, description, tags, status, stale_after, trust_tier, origin, share_never, generated_at, blob_sha';

function summaryOf(owner: string, r: Omit<FileRow, 'content'>): MemoryConceptSummary {
  return MemoryConceptSummary.parse({
    path: r.path,
    type: r.type,
    title: r.title,
    description: r.description,
    tags: r.tags,
    status: r.status,
    staleAfter: r.stale_after ? r.stale_after.toISOString() : null,
    trustTier: r.trust_tier,
    origin: r.origin,
    shareNever: r.share_never,
    fromTeam: null,
    space: spaceOf(owner),
    blobSha: r.blob_sha,
    generatedAt: r.generated_at ? r.generated_at.toISOString() : null,
  });
}

const fileOf = (r: FileRow): PersonalMemoryFile => ({
  path: r.path,
  content: r.content,
  versionNo: r.version_no,
  sizeBytes: r.size_bytes,
  updatedAt: r.updated_at.toISOString(),
});

/** The store of one person's bundle, on one transaction. */
export class PersonalStore {
  constructor(
    private readonly tx: PluginTx,
    readonly ownerPersonId: string,
  ) {}

  /** The frontmatter index of every file, by path. */
  async list(): Promise<MemoryConceptSummary[]> {
    const rows = (
      await this.tx.query<Omit<FileRow, 'content'>>(`SELECT ${SUMMARY_COLUMNS} FROM app.memory_personal_files WHERE owner_person_id = $1::uuid ORDER BY path`, [
        this.ownerPersonId,
      ])
    ).rows;
    return rows.map((r) => summaryOf(this.ownerPersonId, r));
  }

  /** One file, or null when there is none (or the reader may not see it). */
  async read(path: string): Promise<{ file: PersonalMemoryFile; concept: MemoryConceptSummary } | null> {
    const r = (await this.tx.query<FileRow>(`SELECT ${FILE_COLUMNS} FROM app.memory_personal_files WHERE owner_person_id = $1::uuid AND path = $2`, [this.ownerPersonId, path])).rows[0];
    return r === undefined ? null : { file: fileOf(r), concept: summaryOf(this.ownerPersonId, r) };
  }

  /** The saved versions of a file, newest first. */
  async versions(path: string): Promise<PersonalMemoryVersion[]> {
    const rows = (
      await this.tx.query<{ version_no: number; sha256: string; size_bytes: number; author_kind: 'person' | 'bot' | 'system'; created_at: Date }>(
        `SELECT version_no, sha256, size_bytes, author_kind, created_at FROM app.memory_personal_versions
          WHERE owner_person_id = $1::uuid AND path = $2 ORDER BY version_no DESC`,
        [this.ownerPersonId, path],
      )
    ).rows;
    return rows.map((r) => ({ versionNo: r.version_no, sha256: r.sha256, sizeBytes: r.size_bytes, authorKind: r.author_kind, createdAt: r.created_at.toISOString() }));
  }

  /** The text of one saved version, or null. */
  async versionText(path: string, versionNo: number): Promise<string | null> {
    const r = (
      await this.tx.query<{ content: string }>('SELECT content FROM app.memory_personal_versions WHERE owner_person_id = $1::uuid AND path = $2 AND version_no = $3', [
        this.ownerPersonId,
        path,
        versionNo,
      ])
    ).rows[0];
    return r?.content ?? null;
  }

  /** Save a file: validate with the shared OKF check, then let the database decide who may and which version it becomes. */
  async put(path: string, text: string, options: PersonalPutOptions = {}): Promise<PersonalPutResult> {
    const verdict = validateOkfWrite(path, text);
    if (!verdict.ok) return { status: 'invalid', versionNo: 0, callerKind: null, reason: verdict.reason };
    const summary = toMemoryConceptSummary(path, verdict.frontmatter, blobShaOf(text));
    const meta = {
      type: summary.type,
      title: summary.title,
      description: summary.description,
      tags: summary.tags,
      status: summary.status,
      stale_after: summary.staleAfter,
      trust_tier: summary.trustTier,
      origin: summary.origin,
      share_never: summary.shareNever,
      generated_at: summary.generatedAt,
      blob_sha: summary.blobSha,
      person_owned: options.personOwned === true || isPersonOwned(text),
    };
    const checkBase = options.baseVersion !== undefined;
    const row = (
      await this.tx.query<{ status: PersonalPutStatus; version_no: number; caller_kind: 'person' | 'bot' | 'system' | null }>(
        'SELECT status, version_no, caller_kind FROM app.memory_personal_put($1::uuid, $2, $3, $4::jsonb, $5::int, $6::boolean)',
        [this.ownerPersonId, path, text, JSON.stringify(meta), options.baseVersion ?? null, checkBase],
      )
    ).rows[0];
    if (row === undefined) return { status: 'forbidden', versionNo: 0, callerKind: null };
    return { status: row.status, versionNo: row.version_no, callerKind: row.caller_kind };
  }

  /** Remove a file with its versions: the owner only. */
  async remove(path: string): Promise<'ok' | 'not_found' | 'forbidden'> {
    const row = (await this.tx.query<{ status: 'ok' | 'not_found' | 'forbidden' }>('SELECT status FROM app.memory_personal_delete($1::uuid, $2)', [this.ownerPersonId, path])).rows[0];
    return row?.status ?? 'forbidden';
  }
}
