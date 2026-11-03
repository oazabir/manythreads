import { createHash } from 'node:crypto';
import { OKF_VERSION, bundleAbsoluteLinks, pointsIntoReferences, renderBundleLog, serializeConcept, stripReferenceLinks, type OkfFrontmatter, type ShareMode } from '@manythreads/shared';
import { conceptName, relPath, type IncludedConcept, type SelectableConcept } from './selection.ts';

// The digest builder (SPEC §12.3, PLAN P8-23): a pure function from what the selection engine chose to the files of a small OKF bundle. The platform writes every
// word of it (the sender's Archivist writes the summary once there is one; until then the summary is a plain list), so the same selection always gives the same
// bytes and the same fingerprint. Nothing here reads a clock, the database or a model. The bundle is:
//   index.md   frontmatter `okf_version: "0.2"` and nothing else, one line of body
//   log.md     one dated entry
//   digest.md  `type: Digest`; `from`, `to`, `share`, `period`; a `sources` entry per included concept; the summary, each line footnoted to its source
//   <path>.md  in `full` mode, a copy of each included concept at its own path (and a short "retired" notice for each retired one)

export { stripReferenceLinks };

/** Who wrote the digest (`generated.by`): `<producer>/<version>`. */
export const DIGEST_PRODUCER = 'memory-share/0.1';

/** A concept file read from the team's repo and parsed. */
export interface ConceptFile {
  frontmatter: OkfFrontmatter;
  body: string;
}

export interface DigestItem extends IncludedConcept {
  /** Present in `full` mode: the file the copy is made from. */
  file?: ConceptFile;
}

export interface DigestInput {
  team: { id: string; slug: string; name: string };
  share: { slug: string; name: string };
  mode: ShareMode;
  /** `YYYY-MM-DD`: the day of the digest. */
  period: string;
  /** The day of the digest this one follows, when there was one. */
  since: string | null;
  included: readonly DigestItem[];
  retired: readonly SelectableConcept[];
}

export interface BuiltDigest {
  files: Record<string, string>;
  /** Fingerprint of the files (sha-256 over every path and text in path order). */
  sha: string;
  bytes: number;
}

/** One line of plain text, safe to sit in a Markdown list: no control characters, no footnote look-alike, cut at `max`. */
export function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\[\^/g, '[\\^');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/** The `resource` of a copied concept, or none when it points at an original or the sender's references. */
function copiedResource(resource: unknown): string | undefined {
  if (typeof resource !== 'string' || resource === '') return undefined;
  if (pointsIntoReferences(resource) || /^(\/)?inbox\//i.test(resource.trim())) return undefined;
  return resource;
}

function originSource(team: DigestInput['team'], c: SelectableConcept): Record<string, unknown> {
  const source: Record<string, unknown> = { resource: `team:${team.slug}:/${relPath(c.path)}`, title: conceptName(c).slice(0, 500) };
  if (c.generatedAt) source['last_modified'] = c.generatedAt.toISOString();
  return source;
}

/** One concept as the receiving team gets it (SPEC §12.3): the same words, the origin as the only source, trust as `origin_trust`, no link into `references/`. */
export function copyOfConcept(team: DigestInput['team'], c: SelectableConcept, file: ConceptFile): string {
  const fm: Record<string, unknown> = { type: file.frontmatter.type };
  if (file.frontmatter.title !== undefined) fm['title'] = file.frontmatter.title;
  if (file.frontmatter.description !== undefined) fm['description'] = file.frontmatter.description;
  if (file.frontmatter.tags !== undefined) fm['tags'] = file.frontmatter.tags;
  const resource = copiedResource(file.frontmatter['resource']);
  if (resource !== undefined) fm['resource'] = resource;
  if (file.frontmatter.status !== undefined) fm['status'] = file.frontmatter.status;
  if (file.frontmatter.stale_after !== undefined) fm['stale_after'] = file.frontmatter.stale_after;
  fm['sources'] = [originSource(team, c)];
  fm['origin_trust'] = c.trustTier;
  return serializeConcept(fm, stripReferenceLinks(bundleAbsoluteLinks(file.body, c.path)));
}

/**
 * How a retired concept is named: by its path, never by its title. A concept is retired because it is now deprecated or marked team only, so its present title may be
 * words the team has just decided not to share; only what was delivered before (the path, which the earlier digest carried) is sent.
 */
export function retiredName(c: Pick<SelectableConcept, 'path'>): string {
  const rel = relPath(c.path);
  return (rel.endsWith('.md') ? rel.slice(0, -3) : rel).slice(0, 300);
}

/** The notice that stands in for a concept the sender has retired: its name from the path, a status, and no content (no type, title, tags or trust of today). */
export function retiredCopy(team: DigestInput['team'], c: SelectableConcept): string {
  const fm: Record<string, unknown> = {
    type: 'Retired',
    title: retiredName(c),
    description: 'The sending team has retired this concept.',
    status: 'deprecated',
    sources: [{ resource: `team:${team.slug}:/${relPath(c.path)}`, title: retiredName(c) }],
  };
  return serializeConcept(fm, `${team.name} has retired this concept, so it should no longer be relied on.`);
}

function summaryLine(c: SelectableConcept, id: string): string {
  const description = c.description !== null && c.description.trim() !== '' ? `: ${oneLine(c.description, 240)}` : '';
  return `- ${oneLine(conceptName(c), 160)}${description} [^${id}]`;
}

const fingerprint = (files: Readonly<Record<string, string>>): string => {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    const text = files[path] ?? '';
    hash.update(`${path}\0${Buffer.byteLength(text)}\0`).update(text).update('\0');
  }
  return hash.digest('hex');
};

/** Builds the digest. The concepts of `included` and `retired` are expected in path order (the engine's order). */
export function buildDigest(input: DigestInput): BuiltDigest {
  const { team } = input;
  const files: Record<string, string> = {};
  const added = input.included.filter((i) => i.change === 'added');
  const changed = input.included.filter((i) => i.change === 'changed');

  const sources: Array<Record<string, unknown>> = [];
  const footnotes: string[] = [];
  const idOf = new Map<string, string>();
  input.included.forEach((item, n) => {
    const id = `s${n + 1}`;
    idOf.set(item.concept.path, id);
    const source: Record<string, unknown> = { id, resource: relPath(item.concept.path), title: conceptName(item.concept).slice(0, 500) };
    if (item.concept.generatedAt) source['last_modified'] = item.concept.generatedAt.toISOString();
    sources.push(source);
    footnotes.push(`[^${id}]: ${oneLine(relPath(item.concept.path), 300)}`);
  });

  const lines: string[] = [`# ${oneLine(input.share.name, 120)}`, ''];
  const since = input.since === null ? 'the first digest of this share' : `the digest of ${input.since}`;
  lines.push(
    `${oneLine(team.name, 120)} shares what is new in its memory since ${since}: ${added.length} new, ${changed.length} updated, ${input.retired.length} retired.`,
    '',
  );
  const section = (title: string, items: readonly DigestItem[]): void => {
    if (items.length === 0) return;
    lines.push(`## ${title}`, '');
    for (const item of items) lines.push(summaryLine(item.concept, idOf.get(item.concept.path) ?? ''));
    lines.push('');
  };
  section('New', added);
  section('Updated', changed);
  if (input.retired.length > 0) {
    lines.push('## Retired', '');
    for (const c of input.retired) lines.push(`- ${oneLine(retiredName(c), 160)}: ${oneLine(team.name, 120)} has retired this concept.`);
    lines.push('');
  }
  if (footnotes.length > 0) lines.push(...footnotes, '');

  const period: Record<string, string> = { to: input.period };
  if (input.since !== null) period['from'] = input.since;
  const frontmatter: Record<string, unknown> = {
    type: 'Digest',
    title: `${oneLine(input.share.name, 120)} (${input.period})`,
    description: `What changed in ${oneLine(team.name, 120)}’s memory: ${input.included.length} new or updated, ${input.retired.length} retired.`,
    from: team.id,
    share: input.share.slug,
    period,
    sources,
    generated: { by: DIGEST_PRODUCER },
  };
  files['digest.md'] = serializeConcept(frontmatter, lines.join('\n'));

  if (input.mode === 'full') {
    for (const item of input.included) {
      if (item.file === undefined) continue;
      files[relPath(item.concept.path)] = copyOfConcept(team, item.concept, item.file);
    }
    for (const c of input.retired) files[relPath(c.path)] ??= retiredCopy(team, c);
  }

  files['index.md'] = serializeConcept(
    { okf_version: OKF_VERSION },
    `# ${oneLine(input.share.name, 120)}\n\nA digest of ${oneLine(team.name, 120)}’s memory. Start with [the summary](/digest.md).`,
  );
  files['log.md'] = renderBundleLog([
    { date: input.period, text: `Digest from ${oneLine(team.name, 120)}: ${added.length} new, ${changed.length} updated, ${input.retired.length} retired.` },
  ]);

  const bytes = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  return { files, sha: fingerprint(files), bytes };
}
