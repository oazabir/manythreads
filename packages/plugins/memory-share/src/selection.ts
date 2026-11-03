import { SHARE_MAX_CONCEPTS, type ShareConceptRef, type ShareExcludedConcept, type ShareExclusionReason, type ShareSelect } from '@manythreads/shared';

// The selection engine (SPEC §12.3: "Selection is the platform's, not a model's"; PLAN P8-22). A pure function of the team's concept index (`memory_concepts`: the
// frontmatter of each concept, never the body), the share's `select`, and what the last delivery carried. No database, no clock, no model: the same inputs always
// give the same answer, so the preview and the run can never disagree. Each concept the filters matched either goes into the digest or is left out with exactly
// one reason, the first of the order in EXCLUSION_ORDER that applies.

export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';
const TRUST_RANK: Readonly<Record<TrustTier, number>> = { unverified: 0, 'machine-confirmed': 1, 'human-reviewed': 2 };

/** One row of `memory_concepts`, as the engine reads it. */
export interface SelectableConcept {
  /** The repo path (`memory/decisions/x.md`). */
  path: string;
  type: string;
  title: string;
  description: string | null;
  tags: readonly string[];
  status: 'draft' | 'stable' | 'deprecated';
  staleAfter: Date | null;
  trustTier: TrustTier;
  origin: string;
  /** The team that sent this concept (`from` in its header), when it came from another team. */
  fromTeam?: string | null;
  shareNever: boolean;
  /** The git blob hash of the file: the content hash the delta compares. */
  blobSha: string;
  generatedAt: Date | null;
}

/** The order in which reasons are tried; a concept has one reason, the first that applies. */
export const EXCLUSION_ORDER: readonly ShareExclusionReason[] = ['received', 'original', 'personal', 'draft', 'deprecated', 'team_only', 'trust', 'stale'];

export const MEMORY_PREFIX = 'memory/';
/** The path inside the bundle (`decisions/x.md`). */
export const relPath = (path: string): string => (path.startsWith(MEMORY_PREFIX) ? path.slice(MEMORY_PREFIX.length) : path);
export const conceptName = (c: Pick<SelectableConcept, 'path' | 'title'>): string => {
  if (c.title.trim() !== '') return c.title;
  const rel = relPath(c.path);
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
};
export const refOf = (c: Pick<SelectableConcept, 'path' | 'title'>): ShareConceptRef => ({ path: c.path, title: conceptName(c).slice(0, 500) });

/** `decisions/` or `decisions` (a folder) and `playbooks/release.md` (a file), under `memory/`, with a leading `/` or `memory/` tolerated. */
function normalisePath(entry: string): string {
  let p = entry.trim().replace(/^\/+/, '');
  if (p.startsWith(MEMORY_PREFIX)) p = p.slice(MEMORY_PREFIX.length);
  return p;
}

function pathMatches(rel: string, entries: readonly string[]): boolean {
  for (const raw of entries) {
    const entry = normalisePath(raw);
    if (entry === '') return true;
    if (entry.endsWith('.md')) {
      if (rel === entry) return true;
    } else {
      const folder = entry.endsWith('/') ? entry : `${entry}/`;
      if (rel.startsWith(folder)) return true;
    }
  }
  return false;
}

/** What the filters match: `paths`, `types` (case-insensitive, any of), `tags` (any of). Without `paths` the parts of memory that are not the team's own words are not matched at all. */
export function matchesFilters(c: SelectableConcept, select: Pick<ShareSelect, 'paths' | 'types' | 'tags'>): boolean {
  const rel = relPath(c.path);
  const paths = select.paths ?? [];
  if (paths.length > 0) {
    if (!pathMatches(rel, paths)) return false;
  } else if (rel.startsWith('shared/') || rel.startsWith('references/')) {
    return false;
  }
  if (select.types && select.types.length > 0) {
    const t = c.type.toLowerCase();
    if (!select.types.some((x) => x.toLowerCase() === t)) return false;
  }
  if (select.tags && select.tags.length > 0) {
    const have = new Set(c.tags.map((x) => x.toLowerCase()));
    if (!select.tags.some((x) => have.has(x.toLowerCase()))) return false;
  }
  return true;
}

/** Why a matched concept stays out, or null when it may go. `now` only decides staleness. */
export function exclusionOf(c: SelectableConcept, select: Pick<ShareSelect, 'minTrust' | 'skipStale'>, now: Date): ShareExclusionReason | null {
  const rel = relPath(c.path);
  if (c.origin === 'share' || (c.fromTeam !== undefined && c.fromTeam !== null) || rel.startsWith('shared/')) return 'received';
  if (rel.startsWith('references/') || c.type.toLowerCase() === 'reference') return 'original';
  if (c.origin === 'person') return 'personal';
  if (c.status === 'draft') return 'draft';
  if (c.status === 'deprecated') return 'deprecated';
  if (c.shareNever) return 'team_only';
  if (TRUST_RANK[c.trustTier] < TRUST_RANK[select.minTrust]) return 'trust';
  if (select.skipStale && c.staleAfter !== null && c.staleAfter.getTime() <= now.getTime()) return 'stale';
  return null;
}

export interface IncludedConcept {
  concept: SelectableConcept;
  change: 'added' | 'changed';
}

export interface SelectionInput {
  concepts: readonly SelectableConcept[];
  select: Pick<ShareSelect, 'paths' | 'types' | 'tags' | 'minTrust' | 'skipStale'>;
  /** Path to blob hash of what the last sent digest (of the same mode) carried; null when nothing was ever sent. */
  baseline: Readonly<Record<string, string>> | null;
  now: Date;
  /** The most concepts one digest carries (default SHARE_MAX_CONCEPTS). */
  max?: number;
}

export interface SelectionResult {
  /** How many concepts the filters matched. */
  matched: number;
  /** New or changed since the last delivery, in path order: these go in the digest. */
  included: IncludedConcept[];
  /** Passed every rule and are the same as the last delivery: they do not go again. */
  unchanged: SelectableConcept[];
  /** Matched and left out, one reason each, in path order. */
  excluded: Array<{ concept: SelectableConcept; reason: ShareExclusionReason }>;
  /** Carried by the last delivery and no longer shared (deprecated, or marked team only): the receiving side is told. */
  retired: SelectableConcept[];
  /** Path to blob hash of everything that passes (included and unchanged): the baseline of the next run. */
  manifest: Record<string, string>;
}

/** Runs the engine. Deterministic: the concepts are taken in path order. */
export function selectConcepts(input: SelectionInput): SelectionResult {
  const max = input.max ?? SHARE_MAX_CONCEPTS;
  const sorted = [...input.concepts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const result: SelectionResult = { matched: 0, included: [], unchanged: [], excluded: [], retired: [], manifest: {} };
  for (const c of sorted) {
    if (input.baseline !== null && input.baseline[c.path] !== undefined && (c.status === 'deprecated' || c.shareNever)) result.retired.push(c);
    if (!matchesFilters(c, input.select)) continue;
    result.matched += 1;
    const reason = exclusionOf(c, input.select, input.now);
    if (reason !== null) {
      result.excluded.push({ concept: c, reason });
      continue;
    }
    const before = input.baseline?.[c.path];
    if (before === c.blobSha) {
      result.unchanged.push(c);
      result.manifest[c.path] = c.blobSha;
      continue;
    }
    if (result.included.length >= max) {
      result.excluded.push({ concept: c, reason: 'too_large' });
      continue;
    }
    result.included.push({ concept: c, change: before === undefined ? 'added' : 'changed' });
    result.manifest[c.path] = c.blobSha;
  }
  return result;
}

/**
 * Takes concepts the later steps could not send (unreadable, stopped by the data rules, no room left) out of the result: they join the left-out list with
 * their reason and leave the manifest, so the next run tries them again.
 */
export function withdraw(result: SelectionResult, dropped: ReadonlyMap<string, ShareExclusionReason>): SelectionResult {
  if (dropped.size === 0) return result;
  const included: IncludedConcept[] = [];
  const excluded = [...result.excluded];
  const manifest = { ...result.manifest };
  for (const item of result.included) {
    const reason = dropped.get(item.concept.path);
    if (reason === undefined) included.push(item);
    else {
      excluded.push({ concept: item.concept, reason });
      delete manifest[item.concept.path];
    }
  }
  excluded.sort((a, b) => (a.concept.path < b.concept.path ? -1 : a.concept.path > b.concept.path ? 1 : 0));
  return { ...result, included, excluded, manifest };
}

/** Left-out concepts as the pages list them. A concept the data rules stopped is named by its path, never its title (the title may be what tripped them). */
export function excludedRefs(result: SelectionResult): ShareExcludedConcept[] {
  return result.excluded.map(({ concept, reason }) => ({
    path: concept.path,
    title: reason === 'dlp' ? relPath(concept.path).slice(0, 500) : refOf(concept).title,
    reason,
  }));
}

/** How many concepts were left out for each reason (the content-blind "what was withheld" record). */
export function withheldCounts(result: SelectionResult): Partial<Record<ShareExclusionReason, number>> {
  const out: Partial<Record<ShareExclusionReason, number>> = {};
  for (const { reason } of result.excluded) out[reason] = (out[reason] ?? 0) + 1;
  return out;
}
