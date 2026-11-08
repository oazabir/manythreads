import type { ConnectorCaller, ConnectorResult, DocumentsConnector, FetchedDocumentKind, JobInfo, PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import {
  CONNECTOR_PASS_MAX_BYTES,
  CONNECTOR_PASS_MAX_DOCUMENTS,
  KNOWLEDGE_MAX_DOCUMENTS_PER_BASE,
  TeamMemberAddedEvent,
  TeamMemberRemovedEvent,
  type KnowledgeConnectorProvider,
  type KnowledgeSourceStatus,
} from '@manythreads/shared';
import { everyoneMayRead, type TeamMemberAddress } from './access-rule.ts';
import { findDocument, ingest, isConnectorKind, removeFromRepo, sha256Hex, type BaseRef, type ConnectorDocumentKind } from './ingest.ts';
import { providerLabel } from './rows.ts';

// Work package D2 (P16-08, decisions D12 to D15): reading a connector source. The sync pass (jobs.ts) hands every due connector source to the detached queue `knowledge.connector`;
// a pass asks the `connector.documents` provider (looked up when needed, never in `register`) what changed under the source's root since its cursor, with NO transaction open,
// and then takes each document in by a short transaction of its own. It reads at most 100 documents and 20 MB a pass; a source with more waits for the next pass (a follow-up job,
// a few seconds later) and carries on from the provider's own cursor.
//
// The team rule (D14, access-rule.ts): a document goes into a TEAM base only when everyone on the team may open it at the service. Not-everyone documents are counted, never stored;
// a stored document that stops being everyone's is removed. A Personal base has no filter (only its owner reads it).
//
// What a pass does NOT do, on purpose:
//  * An answer that could not be had (the service is down, rate limited, 5xx) never removes a document and never changes who can see one. Only an answer that says `groups: true`
//    is the fail-closed "not everyone". Three such failures in a row end the pass (the cursor stays where it was; the source asks for attention).
//  * A grant that is gone (`not_connected`, `scope_missing`) pauses the source and keeps what it has indexed.
//  * No token, address or document text reaches an event, a log line or an error: counts and ids only.

export const CONNECTOR_QUEUE = 'knowledge.connector';

/** A pass re-checks at most this many stored documents against the service (their access, and that they still exist). A team change re-checks all of them. */
const RECHECK_PER_PASS = 50;
/**
 * The whole folder is read again (not only its changes) this often, so a file that was moved out of the folder, or deleted at a service that does not say so, is dropped; and, once a read
 * has left documents out because not everyone on the team can open them, this much more often, so a file that was then made open to everyone shows up even when its version did not move.
 */
const FULL_READ_AGAIN_MS = 24 * 3600 * 1000;
const FULL_READ_AGAIN_WITH_SKIPPED_MS = 6 * 3600 * 1000;
/** Passes one job runs back to back, then it hands the rest to a follow-up job. */
const PASSES_PER_JOB = 4;
/** The follow-up of a source with more to read starts this long after (kind to the service). */
const FOLLOW_UP_MS = 20_000;
/** Services with no feed of deleted documents: a stored document is checked against the service on every pass, so a deletion is found. */
const NO_DELETION_FEED: ReadonlySet<KnowledgeConnectorProvider> = new Set(['notion', 'box']);
/** Failed answers in a row after which the service is taken to be down. */
const DOWN_AFTER = 3;
const MAX_PAGES_PER_PASS = 150;

let doorForTests: DocumentsConnector | undefined;
/** Tests only: a stand-in for the connections plugin's documents door. */
export function setDocumentsConnectorForTests(door: DocumentsConnector | undefined): void {
  doorForTests = door;
}
export const documentsDoorOf = (ctx: PluginContext): DocumentsConnector | undefined => doorForTests ?? ctx.providers.get<DocumentsConnector>('connector.documents');

// --- what is stored in `knowledge_sources.cursor` --------------------------------------------------------------------------------------------------------------------------------

/**
 * The column holds one JSON text: the provider's own cursor (`c`, opaque), whether it carries on a full read of the folder or the feed of changes (`m`), when the last full read
 * finished (`f`), the limited documents the full read in progress has found so far (`k`) and where the next re-check of stored documents starts (`r`). A text that is not this
 * envelope (a bare cursor) is taken as the provider's cursor of the feed.
 */
export interface CursorEnvelope {
  c: string | null;
  m: 'full' | 'inc';
  f: string | null;
  k: number;
  r: number;
}

export function readEnvelope(text: string | null): CursorEnvelope {
  const fresh: CursorEnvelope = { c: null, m: 'full', f: null, k: 0, r: 0 };
  if (text === null || text === '') return fresh;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('shape');
    const c = typeof raw['c'] === 'string' && raw['c'] !== '' ? raw['c'] : null;
    const m = raw['m'] === 'inc' || raw['m'] === 'full' ? raw['m'] : c === null ? 'full' : 'inc';
    const int = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000 ? v : 0);
    return { c, m: c === null ? 'full' : m, f: typeof raw['f'] === 'string' ? raw['f'] : null, k: int(raw['k']), r: int(raw['r']) };
  } catch {
    return { ...fresh, c: text.slice(0, 4096), m: 'inc' };
  }
}

export function writeEnvelope(env: CursorEnvelope): string | null {
  const text = JSON.stringify(env);
  if (text.length <= 4096) return text;
  // a provider cursor too long to keep: the next pass reads from the start (versions that did not change are not fetched again)
  return JSON.stringify({ ...env, c: null, m: 'full' });
}

// --- a pass ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface SourceInfo {
  id: string;
  baseId: string;
  baseSlug: string;
  workspaceId: string;
  teamId: string | null;
  ownerPersonId: string | null;
  provider: KnowledgeConnectorProvider;
  root: string;
  grantedBy: string | null;
  cursor: string | null;
  status: KnowledgeSourceStatus;
  skippedLimited: number;
  readWithName: string | null;
}

interface StoredDoc {
  id: string;
  remoteId: string;
  remoteVersion: string | null;
  name: string;
  status: string;
  repoPath: string | null;
}

export type PassMode = 'due' | 'force' | 'recheck';

export interface PassResult {
  added: number;
  updated: number;
  removed: number;
  skippedLimited: number;
  status: KnowledgeSourceStatus;
  /** True when the folder has more to read: another pass should follow. */
  more: boolean;
}

type RunTx = <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>;

const SOURCE_SQL = `SELECT s.id, s.base_id, b.slug AS base_slug, b.workspace_id, s.team_id, s.owner_person_id, s.provider, s.remote_root, s.granted_by, s.cursor, s.status, s.skipped_limited,
       (SELECT split_part(p.display_name, ' ', 1) FROM app.people p WHERE p.id = s.granted_by) AS read_with_name
  FROM app.knowledge_sources s JOIN app.knowledge_bases b ON b.id = s.base_id
 WHERE s.id = $1 AND s.kind = 'connector' AND b.workspace_id = $2`;

type SourceSqlRow = {
  id: string;
  base_id: string;
  base_slug: string;
  workspace_id: string;
  team_id: string | null;
  owner_person_id: string | null;
  provider: KnowledgeConnectorProvider;
  remote_root: string;
  granted_by: string | null;
  cursor: string | null;
  status: KnowledgeSourceStatus;
  skipped_limited: number;
  read_with_name: string | null;
};

async function loadSource(tx: PluginTx, workspaceId: string, sourceId: string): Promise<SourceInfo | null> {
  const row = (await tx.query<SourceSqlRow>(SOURCE_SQL, [sourceId, workspaceId])).rows[0];
  if (!row) return null;
  return {
    id: row.id,
    baseId: row.base_id,
    baseSlug: row.base_slug,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    ownerPersonId: row.owner_person_id,
    provider: row.provider,
    root: row.remote_root,
    grantedBy: row.granted_by,
    cursor: row.cursor,
    status: row.status,
    skippedLimited: row.skipped_limited,
    readWithName: row.read_with_name,
  };
}

/** The people of a team with the addresses the workspace has verified: what the team rule is checked against. Bots are marked, guests are marked; neither counts. */
export async function teamRoster(tx: PluginTx, teamId: string): Promise<TeamMemberAddress[]> {
  const rows = (
    await tx.query<{ kind: string; ws_role: string | null; primary_email: string | null; verified: string[] | null }>(
      `SELECT a.kind, wm.role AS ws_role, p.primary_email,
              (SELECT array_agg(e.email ORDER BY (lower(e.email) = lower(p.primary_email)) DESC, e.created_at) FROM app.person_emails e WHERE e.person_id = p.id AND e.verified_at IS NOT NULL) AS verified
         FROM app.team_members tm
         JOIN app.actors a ON a.id = tm.actor_id
         LEFT JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id
         LEFT JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = tm.workspace_id
        WHERE tm.team_id = $1`,
      [teamId],
    )
  ).rows;
  return rows.map((r): TeamMemberAddress => {
    const kind = r.kind === 'person' ? (r.ws_role === 'guest' ? 'guest' : 'person') : 'bot';
    const verified = r.verified ?? [];
    return { email: verified[0] ?? r.primary_email ?? '', verified: verified.length > 0, others: verified.slice(1), kind };
  });
}

async function storedDocs(tx: PluginTx, sourceId: string): Promise<StoredDoc[]> {
  return (
    await tx.query<{ id: string; remote_id: string; remote_version: string | null; name: string; status: string; repo_path: string | null }>(
      `SELECT id, remote_id, remote_version, name, status, repo_path FROM app.knowledge_documents WHERE source_id = $1 AND remote_id IS NOT NULL ORDER BY id`,
      [sourceId],
    )
  ).rows.map((r) => ({ id: r.id, remoteId: r.remote_id, remoteVersion: r.remote_version, name: r.name, status: r.status, repoPath: r.repo_path }));
}

const baseRefOf = (s: SourceInfo): BaseRef => ({ id: s.baseId, teamId: s.teamId, ownerPersonId: s.ownerPersonId, workspaceId: s.workspaceId, slug: s.baseSlug });

/** The words a source says when its connection is gone ("Nadia’s Google Drive is no longer connected."). */
export function disconnectedWords(provider: KnowledgeConnectorProvider, readWithName: string | null): string {
  return readWithName ? `${readWithName}’s ${providerLabel(provider)} is no longer connected.` : `The ${providerLabel(provider)} connection this source reads with is gone.`;
}

/** A document's name as it is kept: no folders, no control characters, at most 200 characters. */
export function cleanRemoteName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  return name === '' ? 'Untitled' : name;
}

const kindOfRemote = (kind: FetchedDocumentKind): ConnectorDocumentKind | null => {
  const mapped = kind === 'md' ? 'markdown' : kind;
  return isConnectorKind(mapped) ? mapped : null;
};

class PassAbort extends Error {
  constructor(readonly outcome: 'paused' | 'down', readonly words: string) {
    super(outcome);
  }
}

/**
 * One pass over one source. `run` opens a short system transaction (a detached job's `job.transaction`); `tx` is the handle the provider is given, which it does not use. Never
 * throws for what the service says; it answers the new state of the source.
 */
export async function runSourcePass(
  ctx: PluginContext,
  tx1: RunTx,
  tx: PluginTx,
  workspaceId: string,
  sourceId: string,
  mode: PassMode,
): Promise<PassResult | null> {
  const source = await tx1((t) => loadSource(t, workspaceId, sourceId));
  if (!source) return null;
  const now = ctx.runtime.now();
  const counts = { added: 0, updated: 0, removed: 0, limited: 0, fetched: 0, bytes: 0 };
  const result = (status: KnowledgeSourceStatus, more: boolean): PassResult => ({ added: counts.added, updated: counts.updated, removed: counts.removed, skippedLimited: counts.limited, status, more });

  const finish = async (status: KnowledgeSourceStatus, error: string | null, env: CursorEnvelope | null, skippedLimited: number | null): Promise<void> => {
    await tx1(async (t) => {
      const total = (await t.query<{ n: number }>('SELECT count(*)::int AS n FROM app.knowledge_documents WHERE source_id = $1', [source.id])).rows[0]?.n ?? 0;
      await t.query(
        `UPDATE app.knowledge_sources SET status = $2, error = $3, last_synced_at = $4, document_count = $5,
                cursor = COALESCE($6, cursor), skipped_limited = COALESCE($7, skipped_limited) WHERE id = $1`,
        [source.id, status, error === null ? null : error.slice(0, 400), now, total, env === null ? null : writeEnvelope(env), skippedLimited],
      );
      await ctx.audit.emit(t, {
        type: 'knowledge.source.synced',
        workspaceId: source.workspaceId,
        teamId: source.teamId,
        ownerPersonId: source.ownerPersonId,
        baseId: source.baseId,
        sourceId: source.id,
        provider: source.provider,
        added: counts.added,
        updated: counts.updated,
        removed: counts.removed,
        skippedLimited: skippedLimited ?? source.skippedLimited,
        status,
        at: now.toISOString(),
      });
    });
  };

  const door = documentsDoorOf(ctx);
  if (!door) {
    await finish('attention', 'Connected apps cannot be read on this server right now.', null, null);
    return result('attention', false);
  }
  if (!source.grantedBy) {
    await finish('paused', disconnectedWords(source.provider, source.readWithName), null, null);
    return result('paused', false);
  }
  const caller: ConnectorCaller & { provider: KnowledgeConnectorProvider } = { workspaceId: source.workspaceId, personId: source.grantedBy, provider: source.provider };

  const roster = source.teamId ? await tx1((t) => teamRoster(t, source.teamId as string)) : null;
  const stored = await tx1((t) => storedDocs(t, source.id));
  const byRemote = new Map(stored.map((d) => [d.remoteId, d]));
  let baseTotal = await tx1(async (t) => (await t.query<{ n: number }>('SELECT count(*)::int AS n FROM app.knowledge_documents WHERE base_id = $1', [source.baseId])).rows[0]?.n ?? 0);
  const evaluated = new Set<string>();

  let env = readEnvelope(source.cursor);
  let down = 0;
  /** What a failed answer means: a gone grant ends the pass paused, a service that does not answer three times in a row ends it as down. */
  const trouble = <T>(answer: Extract<ConnectorResult<T>, { ok: false }>): 'gone' | 'skip' => {
    if (answer.code === 'not_connected' || answer.code === 'scope_missing') {
      throw new PassAbort('paused', answer.code === 'scope_missing' ? `${providerLabel(source.provider)} was connected without permission to read documents. Sign in to it again.` : disconnectedWords(source.provider, source.readWithName));
    }
    if (answer.code === 'not_found') return 'gone';
    down += 1;
    if (down >= DOWN_AFTER) throw new PassAbort('down', `${providerLabel(source.provider)} did not answer. It will be tried again at the next read.`);
    return 'skip';
  };
  const answered = (): void => {
    down = 0;
  };

  const removeDoc = async (doc: StoredDoc): Promise<void> => {
    await tx1((t) => removeStoredDocument(ctx, t, baseRefOf(source), doc));
    byRemote.delete(doc.remoteId);
    baseTotal -= 1;
    counts.removed += 1;
  };

  /** True when the document may be in this source's base. A Personal base takes everything its owner can open. */
  const eligible = async (remoteId: string): Promise<'yes' | 'limited' | 'gone' | 'unknown'> => {
    if (roster === null) return 'yes';
    const answer = await door.access(tx, { ...caller, remoteId });
    if (!answer.ok) return trouble(answer) === 'gone' ? 'gone' : 'unknown';
    answered();
    return everyoneMayRead(answer.value, roster) ? 'yes' : 'limited';
  };

  let committed = env.c;
  let committedMode = env.m;
  /** Limited documents the full read has found, as of the last whole page; and those this pass found while listing (a page that is read again is not counted twice). */
  let kCommitted = env.k;
  let listLimited = 0;
  let recheckLimited = 0;
  let more = false;
  let finishedFull = false;
  let capHit = false;
  const forced = mode === 'force';
  const recheckAll = mode === 'recheck';

  try {
    // Where to read from: a full read of the folder (the first pass, a Re-sync, or the daily look for documents that became open to everyone) or the feed of changes.
    let fullDue = env.m === 'full' && env.c === null;
    if (env.m === 'inc' && env.c !== null) {
      const sinceFull = env.f === null ? Infinity : now.getTime() - Date.parse(env.f);
      if (forced || !(sinceFull < FULL_READ_AGAIN_MS) || (source.skippedLimited > 0 && !(sinceFull < FULL_READ_AGAIN_WITH_SKIPPED_MS))) fullDue = true;
    }
    if (fullDue && !(env.m === 'full' && env.c !== null)) {
      committed = null;
      committedMode = 'full';
      kCommitted = 0;
    }
    const kBase = kCommitted;
    const full = committedMode === 'full';
    // a full read that starts and ends in this pass has seen every document of the folder: what is stored and was not seen is gone from it
    const wholeInThisPass = full && committed === null;
    let pageToken: string | null = null;
    let pages = 0;

    for (;;) {
      pages += 1;
      const page = await door.listChanges(tx, { ...caller, root: source.root, cursor: committed, pageToken });
      if (!page.ok) {
        trouble(page);
        // a page cannot be skipped. A folder that is not there for this person any more removes nothing on a guess.
        throw new PassAbort(
          'down',
          page.code === 'not_found'
            ? `${providerLabel(source.provider)} could not open that folder. Check that it still exists and that you can open it.`
            : `${providerLabel(source.provider)} did not answer. It will be tried again at the next read.`,
        );
      }
      answered();
      const items = new Map(page.value.items.map((i) => [i.remoteId, i]));
      let pageDone = true;
      for (const item of items.values()) {
        evaluated.add(item.remoteId);
        const have = byRemote.get(item.remoteId);
        if (item.removed) {
          if (have) await removeDoc(have);
          continue;
        }
        const kind = kindOfRemote(item.kind);
        if (!kind) continue;
        const unchanged = have !== undefined && have.remoteVersion === item.version && (have.status === 'indexed' || !forced);
        // a full read does not look again at a stored document whose version did not move: the re-check below covers it
        if (full && unchanged) continue;
        const verdict = await eligible(item.remoteId);
        if (verdict === 'unknown') continue;
        if (verdict === 'gone') {
          if (have) await removeDoc(have);
          continue;
        }
        if (verdict === 'limited') {
          counts.limited += 1;
          listLimited += 1;
          if (have) await removeDoc(have);
          continue;
        }
        if (unchanged) continue;
        if (counts.fetched >= CONNECTOR_PASS_MAX_DOCUMENTS || counts.bytes >= CONNECTOR_PASS_MAX_BYTES) {
          pageDone = false;
          break;
        }
        if (!have && baseTotal >= KNOWLEDGE_MAX_DOCUMENTS_PER_BASE) {
          capHit = true;
          continue;
        }
        const fetched = await door.fetch(tx, { ...caller, remoteId: item.remoteId });
        if (!fetched.ok) {
          if (trouble(fetched) === 'gone' && have) await removeDoc(have);
          continue;
        }
        answered();
        counts.fetched += 1;
        counts.bytes += fetched.value.bytes.length;
        const fileKind = kindOfRemote(fetched.value.kind) ?? kind;
        const taken = await tx1((t) =>
          takeIn(ctx, t, source, have ?? null, { remoteId: item.remoteId, version: item.version, url: item.url, name: item.name, kind: fileKind, bytes: fetched.value.bytes }),
        );
        const status = taken.outcome === 'failed' ? 'failed' : 'indexed';
        if (!have) {
          baseTotal += 1;
          byRemote.set(item.remoteId, { id: taken.id, remoteId: item.remoteId, remoteVersion: item.version, name: cleanRemoteName(item.name), status, repoPath: null });
          if (taken.outcome === 'added') counts.added += 1;
        } else {
          byRemote.set(item.remoteId, { ...have, remoteVersion: item.version, status });
          if (taken.outcome === 'updated') counts.updated += 1;
        }
      }
      if (!pageDone) {
        // some of this page is left: the cursor stays where this page started, and the next pass lists it again (what was taken in is not fetched twice)
        more = true;
        break;
      }
      committed = page.value.cursor;
      kCommitted = kBase + listLimited;
      if (page.value.next === null) {
        committedMode = 'inc';
        finishedFull = full;
        break;
      }
      pageToken = page.value.next;
      if (counts.fetched >= CONNECTOR_PASS_MAX_DOCUMENTS || counts.bytes >= CONNECTOR_PASS_MAX_BYTES || pages >= MAX_PAGES_PER_PASS) {
        more = true;
        break;
      }
    }

    if (finishedFull && wholeInThisPass) {
      for (const doc of [...byRemote.values()]) if (!evaluated.has(doc.remoteId)) await removeDoc(doc);
    }

    // Stored documents are checked against the service now and then: access can change without the document changing, and Notion and Box say nothing about deletions.
    const checkExistence = NO_DELETION_FEED.has(source.provider);
    if (roster !== null || checkExistence) {
      const candidates = [...byRemote.values()].filter((d) => !evaluated.has(d.remoteId)).sort((a, b) => (a.id < b.id ? -1 : 1));
      const take = recheckAll ? candidates.length : Math.min(candidates.length, RECHECK_PER_PASS);
      const start = candidates.length === 0 ? 0 : env.r % candidates.length;
      for (let i = 0; i < take; i++) {
        const doc = candidates[(start + i) % candidates.length] as StoredDoc;
        const answer = await door.access(tx, { ...caller, remoteId: doc.remoteId });
        if (!answer.ok) {
          if (trouble(answer) === 'gone') await removeDoc(doc);
          continue;
        }
        answered();
        if (roster !== null && !everyoneMayRead(answer.value, roster)) {
          counts.limited += 1;
          recheckLimited += 1;
          await removeDoc(doc);
        }
      }
      env = { ...env, r: candidates.length === 0 ? 0 : (start + take) % candidates.length };
    }
  } catch (err) {
    if (!(err instanceof PassAbort)) throw err;
    // what was taken in stays; the cursor stays where the last whole page ended
    const nextEnv: CursorEnvelope = { ...env, c: committed, m: committed === null ? 'full' : committedMode, k: kCommitted };
    await finish(err.outcome === 'paused' ? 'paused' : 'attention', err.words, nextEnv, counts.limited > 0 ? Math.max(source.skippedLimited, counts.limited) : null);
    return result(err.outcome === 'paused' ? 'paused' : 'attention', false);
  }

  let skippedLimited: number;
  if (finishedFull) skippedLimited = kCommitted + recheckLimited;
  else skippedLimited = source.skippedLimited + counts.limited;
  const nextEnv: CursorEnvelope = { c: committed, m: committed === null ? 'full' : committedMode, f: finishedFull ? now.toISOString() : env.f, k: finishedFull ? 0 : kCommitted, r: env.r };
  if (capHit) {
    await finish('attention', `This base already holds ${String(KNOWLEDGE_MAX_DOCUMENTS_PER_BASE)} documents, so the rest of this folder was not added.`, nextEnv, skippedLimited);
    return result('attention', false);
  }
  await finish('ready', null, nextEnv, skippedLimited);
  return result('ready', more);
}

interface TakenIn {
  remoteId: string;
  version: string;
  url: string | null;
  name: string;
  kind: ConnectorDocumentKind;
  bytes: Uint8Array;
}

/** One document into the base, with the identity it has at the service. */
async function takeIn(ctx: PluginContext, tx: PluginTx, source: SourceInfo, have: StoredDoc | null, doc: TakenIn): Promise<{ outcome: 'added' | 'updated' | 'unchanged' | 'failed'; id: string }> {
  const base = baseRefOf(source);
  let name = cleanRemoteName(doc.name);
  if (!have) {
    // a new document must not take over another source's document of the same name
    const stem = name;
    for (let n = 2; (await findDocument(tx, base.id, { name })) !== undefined && n < 50; n++) name = `${stem.slice(0, 190)} (${String(n)})`;
  }
  const result = await ingest(
    ctx,
    tx,
    base,
    { name, kind: doc.kind, bytes: doc.bytes, sha256: sha256Hex(doc.bytes), size: doc.bytes.length, blobKey: null, source: 'connector', sourceId: source.id },
    have ? { id: have.id } : undefined,
  );
  const url = doc.url !== null && /^https?:\/\//i.test(doc.url) && doc.url.length <= 2048 ? doc.url : null;
  await tx.query('UPDATE app.knowledge_documents SET remote_id = $2, remote_version = $3, remote_url = $4 WHERE id = $1', [result.document.id, doc.remoteId, doc.version.slice(0, 512), url]);
  if (have && have.name !== name && !(await findDocument(tx, base.id, { name }))) await tx.query('UPDATE app.knowledge_documents SET name = $2 WHERE id = $1', [have.id, name]);
  return { outcome: result.outcome === 'added' ? 'added' : result.outcome === 'updated' ? 'updated' : result.outcome === 'failed' ? 'failed' : 'unchanged', id: result.document.id };
}

/** Takes a document out of its base: the row, its converted copy in the team repo, and the event. The old passages stay for citations. */
async function removeStoredDocument(ctx: PluginContext, tx: PluginTx, base: BaseRef, doc: StoredDoc): Promise<void> {
  await tx.query('DELETE FROM app.knowledge_documents WHERE id = $1', [doc.id]);
  const at = ctx.runtime.now().toISOString();
  if (base.teamId === null) {
    const count = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.knowledge_documents WHERE base_id = $1', [base.id])).rows[0]?.n ?? 0;
    await ctx.audit.emit(tx, { type: 'knowledge.personal_base.changed', workspaceId: base.workspaceId, personId: base.ownerPersonId, baseId: base.id, change: 'document_removed', documents: count, at });
    return;
  }
  await ctx.audit.emit(tx, { type: 'knowledge.document.removed', workspaceId: base.workspaceId, teamId: base.teamId, baseId: base.id, documentId: doc.id, removedBy: tx.actor.id, at });
  await removeFromRepo(ctx, tx, base, doc.repoPath);
}

// --- queueing --------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Puts one source's pass on the queue (committed with `tx`). `mode`: `due` (the rhythm), `force` (a person pressed Re-sync, or it is new) or `recheck` (the team changed: look at every document's access again). */
export async function enqueueConnectorPass(ctx: PluginContext, tx: PluginTx, workspaceId: string, sourceId: string, mode: PassMode = 'due', options: { runAt?: Date; dedupeKey?: string } = {}): Promise<void> {
  await ctx.jobs.enqueue(
    tx,
    CONNECTOR_QUEUE,
    { workspaceId, sourceId, mode },
    { dedupeKey: options.dedupeKey ?? `${CONNECTOR_QUEUE}:${sourceId}:${mode}`, ...(options.runAt ? { runAt: options.runAt } : {}) },
  );
}

/** Puts every connector source of a base on the queue (a lead pressed Re-sync). */
export async function enqueueBaseConnectorPasses(ctx: PluginContext, tx: PluginTx, workspaceId: string, baseId: string, mode: PassMode = 'force'): Promise<number> {
  const ids = (await tx.query<{ id: string }>(`SELECT id FROM app.knowledge_sources WHERE base_id = $1 AND kind = 'connector' ORDER BY created_at, id`, [baseId])).rows;
  for (const row of ids) await enqueueConnectorPass(ctx, tx, workspaceId, row.id, mode);
  return ids.length;
}

/** The connector sources whose rhythm says they are due, on the queue. Called by the sync pass of jobs.ts; they share its budget. Returns how many it queued. */
export async function enqueueDueConnectorSources(ctx: PluginContext, tx: PluginTx, workspaceId: string, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const due = (
    await tx.query<{ id: string }>(
      `SELECT s.id FROM app.knowledge_sources s JOIN app.knowledge_bases b ON b.id = s.base_id
        WHERE s.kind = 'connector' AND s.sync_minutes IS NOT NULL AND b.workspace_id = $2
          AND (s.last_synced_at IS NULL OR s.last_synced_at + make_interval(mins => s.sync_minutes) <= now())
        ORDER BY s.last_synced_at NULLS FIRST, s.id LIMIT $1`,
      [limit, workspaceId],
    )
  ).rows;
  for (const row of due) await enqueueConnectorPass(ctx, tx, workspaceId, row.id, 'due');
  return due.length;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export function registerConnectorSync(ctx: PluginContext): void {
  // detached: a provider call waits on the network, so no transaction is open while it does; every unit of work is a short transaction of its own
  ctx.jobs.register(
    CONNECTOR_QUEUE,
    async (payload, tx, job: JobInfo) => {
      const workspaceId = textOf(payload['workspaceId']);
      if (!workspaceId) return;
      const teamId = textOf(payload['teamId']);
      const sourceId = textOf(payload['sourceId']);
      const mode: PassMode = payload['mode'] === 'force' || payload['mode'] === 'recheck' ? payload['mode'] : 'due';
      if (teamId && !sourceId) {
        // a team's roster changed: every connector source of the team looks at its documents' access again
        await job.transaction(async (t) => {
          const ids = (await t.query<{ id: string }>(`SELECT s.id FROM app.knowledge_sources s WHERE s.team_id = $1 AND s.kind = 'connector' ORDER BY s.id`, [teamId])).rows;
          for (const row of ids) await enqueueConnectorPass(ctx, t, workspaceId, row.id, 'recheck');
        });
        return;
      }
      if (!sourceId) return;
      let passMode = mode;
      for (let i = 0; i < PASSES_PER_JOB; i++) {
        const done = await runSourcePass(ctx, (fn) => job.transaction(fn), tx, workspaceId, sourceId, passMode);
        if (!done) return;
        job.log.info(`knowledge: connector pass ${done.status}, ${String(done.added)} added, ${String(done.updated)} updated, ${String(done.removed)} removed, ${String(done.skippedLimited)} left out`);
        if (!done.more) return;
        // the rest of a forced read is the feed's pages, not a new full read
        passMode = passMode === 'force' ? 'due' : passMode;
      }
      await job.transaction((t) => enqueueConnectorPass(ctx, t, workspaceId, sourceId, passMode === 'recheck' ? 'recheck' : 'due', { runAt: new Date(ctx.runtime.now().getTime() + FOLLOW_UP_MS), dedupeKey: `${CONNECTOR_QUEUE}:${sourceId}:next` }));
    },
    { detached: true, serialKey: 'sourceId', concurrency: 2, maxAttempts: 1 },
  );

  // Someone joined or left a team: what everyone on it may read has changed, so its connector sources look at every document's access again.
  const onRoster = async (event: PluginEvent, tx: PluginTx): Promise<void> => {
    const e = event.type === 'team.member.added' ? TeamMemberAddedEvent.safeParse(event) : TeamMemberRemovedEvent.safeParse(event);
    if (!e.success) return;
    const has = await tx.query('SELECT 1 FROM app.knowledge_sources WHERE team_id = $1 AND kind = $2 LIMIT 1', [e.data.teamId, 'connector']);
    if (has.rows.length === 0) return;
    await ctx.jobs.enqueue(tx, CONNECTOR_QUEUE, { workspaceId: e.data.workspaceId, teamId: e.data.teamId }, { dedupeKey: `${CONNECTOR_QUEUE}:team:${e.data.teamId}`, runAt: new Date(ctx.runtime.now().getTime() + 10_000) });
  };
  ctx.events.subscribe('team.member.added', onRoster);
  ctx.events.subscribe('team.member.removed', onRoster);
}
