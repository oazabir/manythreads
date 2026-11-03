import {
  OKF_BUNDLE_MAX_FILE_BYTES,
  OKF_BUNDLE_MAX_FILES,
  OKF_BUNDLE_MAX_BYTES,
  bundleAbsoluteLinks,
  checkOkfBundle,
  conceptText,
  parseConcept,
  pointsIntoReferences,
  renderBundleLog,
  stripReferenceLinks,
  type DigestImportRefusal,
  type OkfBundleProblem,
  type OkfFrontmatter,
  type OkfSource,
  OkfTrustTier,
} from '@manythreads/shared';

// What a received bundle must be before any of it is filed, and what is filed (PLAN P8-25; SPEC §12.3). Pure: text in, text out, no database, no clock but the one it is given.
// The whole bundle is judged first and refused whole at the first problem, so nothing is ever half filed. What is filed is rewritten, never copied: only the keys the receiving
// side knows are kept, `verified` never survives (trust does not travel), the platform stamps where it came from, and links that were the sender's own are re-pointed into the
// folder the bundle lands in. `index.md` and `log.md` of the bundle are not filed: the repository writer regenerates the team's own.

/** The most bytes a bundle dropped from outside may hold once unpacked. A digest from a team is smaller (SHARE_MAX_BUNDLE_BYTES) and judged against the OKF default. */
export const FOREIGN_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;

export type BundleKind = 'digest' | 'external';

export type PreparedBundle =
  | { ok: true; files: { path: string; content: string }[]; skipped: number; bytes: number }
  | { ok: false; code: DigestImportRefusal; message: string };

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The refusal code of a conformance problem. */
function codeOf(problem: OkfBundleProblem): DigestImportRefusal {
  const m = problem.message;
  if (problem.path === '' && /files; the most/.test(m)) return 'too_many_files';
  if (problem.path === '' || /larger than/.test(m)) return 'too_large';
  if (m.includes('NUL')) return 'not_utf8';
  if (/^(the path|only Markdown|two files differ)/.test(m)) return 'unsafe_path';
  if (problem.path === 'index.md' || problem.path === 'log.md') return 'bad_index';
  return 'bad_concept';
}

export const isPlatformFile = (path: string): boolean => path === 'index.md' || path === 'log.md' || path.endsWith('/index.md') || path.endsWith('/log.md');

/** A zip often wraps everything in one folder (`notes/index.md`, `notes/facts/a.md`). With no `index.md` at the top and a single folder around every file, the folder is taken off. */
export function withoutSingleRoot(files: ReadonlyMap<string, string>): Record<string, string> {
  const names = [...files.keys()];
  const plain: Record<string, string> = {};
  const first = names[0]?.split('/')[0];
  const wrapped = names.length > 0 && !files.has('index.md') && first !== undefined && names.every((n) => n.includes('/') && n.split('/')[0] === first);
  for (const [name, text] of files) plain[wrapped ? name.slice(first.length + 1) : name] = text;
  return plain;
}

const ABSOLUTE_LINK = /\]\(\s*(\/(?!\/)[^)\s]*)((?:\s+"[^"]*")?)\s*\)/g;
const ABSOLUTE_DEFINITION = /^(\s{0,3}\[[^\]\n]+\]:[ \t]*)(\/(?!\/)\S*)/gm;

/** Resolves `target` against `base` (both `/`-separated, relative to `memory/`); null when it climbs above `memory/`. */
function resolveUnder(base: string, target: string): string | null {
  const out: string[] = [];
  for (const segment of `${base}/${target}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Whether a link target of a filed concept stays inside `memory/shared/<folder>/`. A target that is somebody else's (a scheme, `//host`) or only an anchor is not a path here and
 * stays. Everything else is resolved the way a reader would: against the concept's own folder (a `/`-absolute target against `memory/`), after percent-decoding and with `\` read as
 * `/`, the raw spelling too. A target that climbs above the bundle root, or lands anywhere outside the folder, is outside.
 */
function staysInside(rawTarget: string, fromPath: string, folder: string): boolean {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  if (target === '' || target.startsWith('#') || target.startsWith('//') || SCHEME.test(target)) return true;
  const root = `shared/${folder}`;
  const dir = fromPath.includes('/') ? `${root}/${fromPath.slice(0, fromPath.lastIndexOf('/'))}` : root;
  const spellings = new Set<string>([target]);
  try {
    spellings.add(decodeURIComponent(target));
  } catch {
    // an undecodable spelling is judged as written
  }
  for (const spelling of [...spellings]) spellings.add(spelling.replace(/\\/g, '/'));
  for (const spelling of spellings) {
    const path = spelling.replace(/[?#].*$/s, '');
    if (SCHEME.test(path) || path.startsWith('//')) return false;
    const resolved = resolveUnder(path.startsWith('/') ? '' : dir, path);
    if (resolved === null || (resolved !== root && !resolved.startsWith(`${root}/`))) return false;
  }
  return true;
}

const INLINE_LINK = /(?:(!?)\[([^[\]\n]{0,300}))?\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const DEFINITION_LINE = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)[^\n]*$/gm;
const HTML_ADDRESS = /\s*\b(?:href|src)\s{0,4}=\s{0,4}(?:"([^"\n]{0,600})"|'([^'\n]{0,600})'|([^\s"'>]{1,600}))/gi;

/** Takes the target off every link, definition and `href`/`src` of `body` that does not stay inside the folder: the link text stays, the way stays out. One linear pass each. */
function neutraliseOutsideLinks(body: string, fromPath: string, folder: string): string {
  const inside = (target: string): boolean => staysInside(target, fromPath, folder);
  return body
    .replace(INLINE_LINK, (whole, _image: string | undefined, label: string | undefined, target: string) => (inside(target) ? whole : label === undefined ? ']' : label))
    .replace(DEFINITION_LINE, (whole, target: string) => (inside(target) ? whole : ''))
    .replace(HTML_ADDRESS, (whole, a: string | undefined, b: string | undefined, c: string | undefined) => (inside(a ?? b ?? c ?? '') ? whole : ''));
}

/**
 * A link written from the bundle's own root (`/facts/x.md`) means the bundle's own file: once the bundle lives under `memory/shared/<folder>/`, so must the link. One linear pass each.
 * Afterwards no link may lead out of that folder: a relative link that climbs above it (`../../../people/x.md`, which would read as the receiving team's own memory), a
 * `/`-absolute one that does not land in it (`/../x.md`), and the same written with `%2e%2e` or `\\` all lose their target and keep their text.
 */
export function repointLinks(body: string, fromPath: string, folder: string): string {
  const absolute = bundleAbsoluteLinks(stripReferenceLinks(body), `memory/${fromPath}`);
  const repointed = absolute
    .replace(ABSOLUTE_LINK, (_whole, target: string, title: string) => `](/shared/${folder}${target}${title})`)
    .replace(ABSOLUTE_DEFINITION, (_whole, lead: string, target: string) => `${lead}/shared/${folder}${target}`);
  return neutraliseOutsideLinks(repointed, fromPath, folder);
}

function keptSources(sources: OkfFrontmatter['sources']): OkfSource[] | undefined {
  if (sources === undefined) return undefined;
  const kept = sources.filter((s) => !pointsIntoReferences(typeof s === 'string' ? s : s.resource));
  return kept.length > 0 ? kept : undefined;
}

/**
 * One concept as it is filed: only the keys the receiving side knows are kept. `verified`, `generated`, `origin`, `from` and `share` of the sender are never kept (the platform
 * stamps its own), so a received concept can neither claim a human reviewed it nor pass itself off as the team's own, nor switch its own sharing.
 */
function filedFrontmatter(fm: OkfFrontmatter, kind: BundleKind, fromTeamId: string | null, now: Date): Record<string, unknown> {
  const out: Record<string, unknown> = { type: fm.type };
  if (fm.title !== undefined) out['title'] = fm.title;
  if (fm.description !== undefined) out['description'] = fm.description;
  if (fm.tags !== undefined) out['tags'] = fm.tags;
  if (fm.status !== undefined) out['status'] = fm.status;
  if (fm.stale_after !== undefined) out['stale_after'] = fm.stale_after;
  const sources = keptSources(fm.sources);
  if (sources !== undefined) out['sources'] = sources;
  const resource = fm['resource'];
  if (typeof resource === 'string' && resource !== '' && !pointsIntoReferences(resource)) out['resource'] = resource;
  if (fm.usage_window !== undefined) out['usage_window'] = fm.usage_window;
  // how far the sender trusted it is kept as information; here nobody has reviewed it, and `verified` is what would say so
  const claimed = OkfTrustTier.safeParse(fm['origin_trust']);
  out['origin_trust'] = kind === 'digest' && claimed.success ? claimed.data : 'unverified';
  out['origin'] = kind === 'digest' ? 'share' : 'import';
  if (kind === 'digest' && fromTeamId !== null) out['from'] = fromTeamId;
  out['generated'] = { by: 'process:share', at: now.toISOString() };
  return out;
}

export interface PrepareInput {
  /** The bundle's files, path to text. */
  files: Readonly<Record<string, string>>;
  kind: BundleKind;
  /** The folder under `memory/shared/` the bundle is filed in. */
  folder: string;
  /** The sending team of a digest. */
  fromTeamId: string | null;
  now: Date;
}

/** Judges a received bundle whole, then rewrites it for filing. Never throws. */
export function prepareBundle(input: PrepareInput): PreparedBundle {
  const digest = input.kind === 'digest';
  // a bundle from outside may have no log.md; the platform never files it, so a stand-in is enough for the check
  const checked: Record<string, string> =
    !digest && input.files['log.md'] === undefined ? { ...input.files, 'log.md': renderBundleLog([{ date: input.now.toISOString().slice(0, 10), text: 'Received.' }]) } : { ...input.files };
  const result = checkOkfBundle(checked, { digest, maxFiles: OKF_BUNDLE_MAX_FILES, maxBytes: digest ? OKF_BUNDLE_MAX_BYTES : FOREIGN_BUNDLE_MAX_BYTES });
  if (!result.ok) {
    const first = result.problems[0];
    if (first === undefined) return { ok: false, code: 'bad_concept', message: 'The bundle is not a well-formed OKF bundle.' };
    return { ok: false, code: codeOf(first), message: cut(`${first.path === '' ? '' : `${first.path}: `}${first.message}`, 300) };
  }

  const files: { path: string; content: string }[] = [];
  let skipped = 0;
  let bytes = 0;
  for (const path of Object.keys(input.files).sort()) {
    if (isPlatformFile(path)) {
      skipped += 1;
      continue;
    }
    const parsed = parseConcept(input.files[path] ?? '');
    if (!parsed.ok) return { ok: false, code: 'bad_concept', message: cut(`${path}: ${parsed.reason}`, 300) };
    const target = `memory/shared/${input.folder}/${path}`;
    if (target.length > 500) return { ok: false, code: 'unsafe_path', message: cut(`${path}: the path is too long once filed`, 300) };
    const content = conceptText(filedFrontmatter(parsed.frontmatter, input.kind, input.fromTeamId, input.now), repointLinks(parsed.body, path, input.folder));
    const again = parseConcept(content);
    if (!again.ok) return { ok: false, code: 'bad_concept', message: cut(`${path}: ${again.reason}`, 300) };
    const size = Buffer.byteLength(content);
    if (size > OKF_BUNDLE_MAX_FILE_BYTES) return { ok: false, code: 'too_large', message: cut(`${path}: the file is too large once filed`, 300) };
    bytes += size;
    files.push({ path: target, content });
  }
  if (files.length === 0) return { ok: false, code: 'bad_concept', message: 'The bundle has no concept files, only its index and log.' };
  return { ok: true, files, skipped, bytes };
}
