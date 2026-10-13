import { createHash } from 'node:crypto';
import { memoryContentDigest } from '@manythreads/sdk';
import { trustTier, type OkfFrontmatter, type TrustTier } from '@manythreads/shared';
import { MAX_DOC_CHARS } from './constants.ts';

// Pure text work for the mirror: what a concept becomes as a memory document, the digest that recognises it again and the id the engine files it
// under. No database, no clock, no engine. Linear in the input (slices, joins and one hash; no regular expression with a nested quantifier), and
// every output is bounded: a document is at most `MAX_DOC_CHARS`, a metadata value at most 500 characters, a tag at most 64.

/** The source id of a concept in `memory_retain_log` and the work list: the team and the path (a path alone is not unique across teams). */
export const conceptSourceId = (teamId: string, path: string): string => `${teamId}/${path}`;

/** `okf:<first 24 hex of sha-256(path)>:<first 16 hex of the keyed digest>`; the reserved `run:` / `platform:` and the feed's `feed:` are never used. */
export function documentIdFor(path: string, digest: string): string {
  return `okf:${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 24)}:${digest.slice(0, 16)}`;
}

/** The first `max` characters of `text`, never ending inside a surrogate pair, with an ellipsis when something was cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Collapses runs of blank lines and trailing spaces; keeps the author's own line structure. Linear: one pass over the lines. */
export function tidy(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let blank = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '') {
      blank += 1;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

/** A tag value: lowercase letters, digits and `._-`, at most 40 characters; `unknown` for something with none. */
function slug(value: string): string {
  let out = '';
  let dash = false;
  for (const ch of value.normalize('NFKD').toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_') {
      out += ch;
      dash = false;
    } else if (!dash && out !== '') {
      out += '-';
      dash = true;
    }
    if (out.length >= 40) break;
  }
  const trimmed = out.replace(/-+$/, '');
  return trimmed === '' ? 'unknown' : trimmed;
}

const tag = (prefix: string, value: string): string => `${prefix}:${slug(value)}`.slice(0, 64);

export interface ConceptInput {
  path: string;
  teamSlug: string;
  frontmatter: OkfFrontmatter;
  body: string;
  authorId: string | null;
  authorName: string | null;
  /** When the commit that last touched the file was made (ISO). */
  committedAt: string;
}

export interface ConceptItem {
  content: string;
  /** The label of the document, at most 200 characters. */
  context: string;
  timestamp: string;
  tags: string[];
  metadata: Record<string, string>;
  /** What the digest is taken over: the text, and everything the tags and metadata say, so a change of trust, type, status or origin is a new document. */
  hashInput: string;
  trust: TrustTier;
}

const baseName = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
};

const meta = (entries: Record<string, string | null | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === undefined || value === '') continue;
    out[key.slice(0, 64)] = clip(value, 500);
  }
  return out;
};

/**
 * One concept as the document the engine distils facts from. The frontmatter's own YAML is not sent (provenance is the platform's, and `sources`
 * and `verified` are not for the engine to read as claims): the document says what the concept is (path, type, status, trust, origin, last
 * author) and then its title, description and body. A concept longer than the engine takes is cut and says so.
 */
export function renderConcept(input: ConceptInput): ConceptItem {
  const fm = input.frontmatter;
  const trust = trustTier(fm);
  const status = fm.status ?? 'stable';
  const title = (fm.title ?? '').trim() === '' ? baseName(input.path) : (fm.title as string).trim();
  const origin = (fm.origin ?? '').trim();
  const day = input.committedAt.slice(0, 16).replace('T', ' ');
  const headerBits = [`type ${fm.type}`, `status ${status}`, `trust ${trust}`];
  if (origin !== '') headerBits.push(`origin ${origin}`);
  if (input.authorName !== null && input.authorName !== '') headerBits.push(`last written by ${input.authorName} on ${day}`);
  else headerBits.push(`last written on ${day}`);
  const parts: string[] = [`Memory concept ${input.path} (${headerBits.join(', ')}):`, `# ${title}`];
  const description = (fm.description ?? '').trim();
  if (description !== '') parts.push(description);
  const body = tidy(input.body);
  if (body !== '') parts.push(body);
  const full = parts.join('\n\n');
  const content = full.length > MAX_DOC_CHARS ? `${clip(full, MAX_DOC_CHARS - 40)}\n\n[the concept continues in the file]` : full;

  const tags = ['okf', 'kind:concept', tag('type', fm.type), tag('trust', trust), tag('status', status)];
  if (origin !== '') tags.push(tag('origin', origin));
  for (const t of (fm.tags ?? []).slice(0, 8)) tags.push(tag('tag', t));
  const unique = [...new Set(tags)].slice(0, 20);

  const metadata = meta({
    feed_kind: 'concept',
    feed_id: input.path,
    concept_path: input.path,
    concept_type: fm.type,
    status,
    trust_tier: trust,
    origin,
    stale_after: fm.stale_after,
    actor: input.authorId,
    actor_name: input.authorName,
    occurred_at: input.committedAt,
    link: `/t/${input.teamSlug}/files?open=${encodeURIComponent(input.path)}`,
  });
  return {
    content,
    context: clip(`Concept: ${title}`, 200),
    timestamp: input.committedAt,
    tags: unique,
    metadata,
    hashInput: JSON.stringify([content, unique, fm.type, status, trust, origin, fm.stale_after ?? null]),
    trust,
  };
}

/** The keyed digest of what a concept is (see `ConceptItem.hashInput`), lowercase hex. */
export const conceptDigest = (item: ConceptItem, key: Buffer | string): string => memoryContentDigest(item.hashInput, key);
