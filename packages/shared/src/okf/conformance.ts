import { parseDocument } from 'yaml';
import { OKF_VERSION, parseConcept, splitConcept } from './concept.ts';
import { parseLog } from './bundle.ts';

// Does a set of files conform to OKF v0.2? (SPEC §12.1, §12.3; PLAN P5-24, P8-23.) One pure check made of the parts P5-24 built: `splitConcept` and `parseConcept` for every concept,
// `parseLog` for `log.md`, and the rule that the root `index.md` carries `okf_version: "0.2"` and nothing else. The memory-share plugin checks the digest it builds with it
// before anyone is asked to approve it, and the receiving side (P8-25) will check a digest it is handed with the same function, so the two cannot drift.
// Pure and linear: no clock, no database, nothing is run, and the checks that read text are bounded by the sizes below.

/** The most files, the most bytes in one file and the most bytes in all that a bundle may hold. */
export const OKF_BUNDLE_MAX_FILES = 2_000;
export const OKF_BUNDLE_MAX_FILE_BYTES = 1_000_000;
export const OKF_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;

export interface OkfBundleProblem {
  /** The file the problem is in (`index.md`, `decisions/x.md`), or `` for the bundle as a whole. */
  path: string;
  /** One sentence, in words. */
  message: string;
}

export interface OkfBundleCheckOptions {
  /**
   * Check it as a digest too (SPEC §12.3): a `digest.md` of `type: Digest` whose `sources` ids are all used as footnotes; and in every other concept no `verified`
   * (trust does not travel), at most one `sources` entry, and no link or source into the sender's `references/`.
   */
  digest?: boolean;
  maxFiles?: number;
  maxBytes?: number;
}

export interface OkfBundleCheck {
  ok: boolean;
  problems: OkfBundleProblem[];
}

/** A path inside a bundle: relative, `/`-separated, no `.` or `..` segment, no control characters, ending in `.md`. Returns the problem, or null. */
export function bundlePathProblem(path: string): string | null {
  if (path === '' || path.length > 300) return 'the path is empty or longer than 300 characters';
  if (path.startsWith('/') || path.endsWith('/')) return 'the path must be relative and name a file';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\\]/.test(path)) return 'the path has a control character or a backslash';
  if (path.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'the path has an empty, "." or ".." part';
  if (!path.endsWith('.md')) return 'only Markdown files (.md) belong in a bundle';
  return null;
}

/** `[^id]` references in a body, and the ids that have a definition line (`[^id]: …`). A manual scan: every position is visited once, so the time is linear. */
function footnotesOf(body: string): { used: Set<string>; defined: Set<string> } {
  const used = new Set<string>();
  const defined = new Set<string>();
  for (const line of body.split('\n')) {
    const def = /^\[\^([^\]\s]+)\]:/.exec(line);
    if (def?.[1] !== undefined) {
      defined.add(def[1]);
      continue;
    }
    let i = line.indexOf('[^');
    while (i !== -1) {
      let j = i + 2;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if (c === 0x5d || c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0b || c === 0x0c || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0xfeff) break;
        j += 1;
      }
      if (j < line.length && line.charCodeAt(j) === 0x5d && j > i + 2) {
        used.add(line.slice(i + 2, j));
        i = line.indexOf('[^', j + 1);
      } else {
        // not a footnote mark: go on from where the scan stopped (never back), so the whole line is read once
        i = line.indexOf('[^', Math.max(i + 2, j));
      }
    }
  }
  return { used, defined };
}

// ---- links into the sender's references/ ------------------------------------------------------------------------------------------

/**
 * Whether the address of a link points into the sender's `references/` (the platform's copies of originals, which never leave the team). The address is normalised first, so
 * the usual disguises do not work: surrounding `<>`, percent-encoding (also twice), upper case, a backslash, `.` and `..` parts, `memory/` in front, a `team:<slug>:` prefix.
 * An address with a scheme (`https:`, `mailto:`) or that starts with `//` is somebody else's and is never ours. Any part called `references` counts: leaving a harmless link
 * to a folder of that name out is better than letting a way to an original through.
 */
export function pointsIntoReferences(address: string): boolean {
  let t = address.normalize('NFKC');
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2060\uFEFF]/g, '').trim();
  if (t.startsWith('<')) t = t.slice(1);
  if (t.endsWith('>')) t = t.slice(0, -1);
  for (let n = 0; n < 3 && t.includes('%'); n += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(t);
    } catch {
      decoded = t.replace(/%([0-9a-fA-F]{2})/g, (m, h: string) => (Number.parseInt(h, 16) < 0x80 ? String.fromCharCode(Number.parseInt(h, 16)) : m));
    }
    if (decoded === t) break;
    t = decoded;
  }
  t = t.replace(/\\/g, '/').toLowerCase().trim();
  const team = /^team:[^:/]*:/.exec(t);
  if (team) t = t.slice(team[0].length);
  else if (/^[a-z][a-z0-9+.-]*:/.test(t) || t.startsWith('//')) return false;
  const cut = t.search(/[?#]/);
  if (cut !== -1) t = t.slice(0, cut);
  const parts: string[] = [];
  for (const part of t.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part.trim());
  }
  return parts.includes('references');
}

/** One inline link or image in Markdown: where its `]` is, where it ends (after the `)`), and its address as written. */
export interface InlineLink {
  close: number;
  end: number;
  address: string;
}

const ADDRESS_MAX = 600;
const TAIL_MAX = 120;

/** Every `](address)` of a body, left to right. Each `](` is looked at once and costs at most a fixed number of steps, so the scan is linear. */
export function inlineLinks(body: string): InlineLink[] {
  const out: InlineLink[] = [];
  let at = body.indexOf('](');
  while (at !== -1) {
    let i = at + 2;
    while (i < body.length && (body.charCodeAt(i) === 0x20 || body.charCodeAt(i) === 0x09)) i += 1;
    let address = '';
    let ok = false;
    if (body.charCodeAt(i) === 0x3c) {
      const stop = Math.min(body.length, i + 1 + ADDRESS_MAX);
      let j = i + 1;
      while (j < stop && body.charCodeAt(j) !== 0x3e && body.charCodeAt(j) !== 0x0a) j += 1;
      if (j < stop && body.charCodeAt(j) === 0x3e) {
        address = body.slice(i + 1, j);
        i = j + 1;
        ok = true;
      }
    } else {
      const stop = Math.min(body.length, i + ADDRESS_MAX);
      let j = i;
      while (j < stop) {
        const c = body.charCodeAt(j);
        if (c === 0x29 || c === 0x20 || c === 0x09 || c === 0x0a) break;
        j += 1;
      }
      if (j < stop || j === body.length) {
        address = body.slice(i, j);
        i = j;
        ok = true;
      }
    }
    if (ok) {
      // the rest up to the closing parenthesis (a title, spaces); a link that never closes within a short stretch is not a link
      const stop = Math.min(body.length, i + TAIL_MAX);
      let j = i;
      while (j < stop && body.charCodeAt(j) !== 0x29 && body.charCodeAt(j) !== 0x0a) j += 1;
      if (j < stop && body.charCodeAt(j) === 0x29) {
        out.push({ close: at, end: j + 1, address });
        at = body.indexOf('](', j + 1);
        continue;
      }
    }
    at = body.indexOf('](', at + 2);
  }
  return out;
}

const REFERENCE_DEFINITION_LINE = /^ {0,3}\[[^\]\n]{1,200}\]:[ \t]*(<[^>\n]{0,600}>|\S{1,600})/;
const HTML_ADDRESS = /\b(?:href|src|srcset|data|poster|action)\s{0,4}=\s{0,4}(?:"([^"\n]{0,600})"|'([^'\n]{0,600})'|([^\s"'>]{1,600}))/gi;

/** The address of a reference-style definition line (`[name]: address`), or null. */
export function referenceDefinitionAddress(line: string): string | null {
  if (line.length > 1_000) return null;
  return REFERENCE_DEFINITION_LINE.exec(line)?.[1] ?? null;
}

/** Whether a body links into the sender's `references/`: inline links and images, reference-style definitions, and HTML `href`/`src` attributes. Linear. */
export function hasReferencesLink(body: string): boolean {
  for (const link of inlineLinks(body)) if (pointsIntoReferences(link.address)) return true;
  for (const line of body.split('\n')) {
    const address = referenceDefinitionAddress(line);
    if (address !== null && pointsIntoReferences(address)) return true;
  }
  if (body.includes('=')) {
    for (const m of body.matchAll(HTML_ADDRESS)) {
      if (pointsIntoReferences(m[1] ?? m[2] ?? m[3] ?? '')) return true;
    }
  }
  return false;
}

/**
 * Removes every link, image, definition and HTML address of `body` that points into `references/`: the link text stays, the address goes. One pass, linear (a link's label is
 * looked for in a fixed window before its `]`).
 */
export function stripReferenceLinks(body: string): string {
  let out = '';
  let last = 0;
  for (const link of inlineLinks(body)) {
    if (!pointsIntoReferences(link.address)) continue;
    if (link.close < last) continue;
    let open = -1;
    for (let i = link.close - 1; i >= Math.max(last, link.close - 300); i -= 1) {
      const c = body.charCodeAt(i);
      if (c === 0x5d) break;
      if (c === 0x5b) {
        open = i;
        break;
      }
    }
    if (open === -1) {
      out += body.slice(last, link.close);
    } else {
      const image = open > last && body.charCodeAt(open - 1) === 0x21;
      const label = body.slice(open + 1, link.close);
      out += body.slice(last, image ? open - 1 : open) + (image ? label.trim() : label);
    }
    last = link.end;
  }
  out += body.slice(last);
  out = out
    .split('\n')
    .filter((line) => {
      const address = referenceDefinitionAddress(line);
      return address === null || !pointsIntoReferences(address);
    })
    .join('\n');
  if (out.includes('=')) {
    out = out.replace(HTML_ADDRESS, (whole: string, a: string | undefined, b: string | undefined, c: string | undefined) => (pointsIntoReferences(a ?? b ?? c ?? '') ? '' : whole));
  }
  return out;
}

/** Checks the files of a bundle (path to text). Never throws. */
export function checkOkfBundle(files: Readonly<Record<string, string>>, options: OkfBundleCheckOptions = {}): OkfBundleCheck {
  const problems: OkfBundleProblem[] = [];
  const add = (path: string, message: string): void => void problems.push({ path, message });
  const paths = Object.keys(files);
  const maxFiles = options.maxFiles ?? OKF_BUNDLE_MAX_FILES;
  const maxBytes = options.maxBytes ?? OKF_BUNDLE_MAX_BYTES;
  if (paths.length > maxFiles) {
    add('', `the bundle has ${paths.length} files; the most is ${maxFiles}`);
    return { ok: false, problems };
  }
  let total = 0;
  const seen = new Set<string>();
  for (const path of paths) {
    const text = files[path] ?? '';
    const bytes = Buffer.byteLength(text);
    total += bytes;
    const problem = bundlePathProblem(path);
    if (problem !== null) add(path, problem);
    const folded = path.toLowerCase();
    if (seen.has(folded)) add(path, 'two files differ only in upper and lower case');
    seen.add(folded);
    if (bytes > OKF_BUNDLE_MAX_FILE_BYTES) add(path, `the file is larger than ${OKF_BUNDLE_MAX_FILE_BYTES} bytes`);
    if (text.includes('\0')) add(path, 'the file has a NUL character');
  }
  if (total > maxBytes) add('', `the bundle is ${total} bytes; the most is ${maxBytes}`);
  if (problems.length > 0) return { ok: false, problems };

  // The root index: okf_version and nothing else.
  const index = files['index.md'];
  if (index === undefined) add('index.md', 'the bundle has no index.md');
  else {
    const split = splitConcept(index);
    if (!split.ok) add('index.md', split.reason);
    else {
      const doc = parseDocument(split.frontmatter, { uniqueKeys: true, version: '1.2', logLevel: 'silent' });
      // an alias (a hostile index.md) makes toJS throw: the root index may not use one, so it is a problem, not a crash
      let value: unknown = null;
      try {
        value = doc.errors.length > 0 ? null : doc.toJS({ maxAliasCount: 0 });
      } catch {
        value = null;
      }
      const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
      if (keys.length !== 1 || keys[0] !== 'okf_version') add('index.md', 'the root index.md must have okf_version and nothing else in its frontmatter');
      else if (String((value as Record<string, unknown>)['okf_version']) !== OKF_VERSION) add('index.md', `okf_version must be "${OKF_VERSION}"`);
    }
  }

  const log = files['log.md'];
  if (log === undefined) add('log.md', 'the bundle has no log.md');
  else if (parseLog(log).length === 0) add('log.md', 'log.md has no dated entry (## YYYY-MM-DD, then - lines)');

  let digest = false;
  for (const path of paths) {
    if (path === 'index.md' || path === 'log.md' || path.endsWith('/index.md') || path.endsWith('/log.md')) continue;
    const parsed = parseConcept(files[path] ?? '');
    if (!parsed.ok) {
      add(path, parsed.reason);
      continue;
    }
    const fm = parsed.frontmatter;
    if (options.digest !== true) continue;
    if (path === 'digest.md') {
      digest = true;
      if (fm.type !== 'Digest') add(path, 'digest.md must have type: Digest');
      const ids = new Set<string>();
      for (const s of fm.sources ?? []) {
        const id = typeof s === 'string' ? undefined : s.id;
        if (id === undefined) add(path, 'every source of the digest needs an id, for its footnote');
        else if (ids.has(id)) add(path, `two sources share the id "${id}"`);
        else ids.add(id);
      }
      const notes = footnotesOf(parsed.body);
      for (const id of notes.used) if (!ids.has(id)) add(path, `the footnote [^${id}] has no source with that id`);
      for (const id of ids) if (!notes.defined.has(id)) add(path, `the source "${id}" has no footnote`);
      continue;
    }
    if (fm['verified'] !== undefined) add(path, 'a copied concept must not carry verified: trust does not travel');
    if ((fm.sources ?? []).length > 1) add(path, 'a copied concept has at most one source: the concept it was copied from');
    for (const s of fm.sources ?? []) {
      const resource = typeof s === 'string' ? s : s.resource;
      if (pointsIntoReferences(resource)) add(path, 'a copied concept must not point into the sender’s references/');
    }
    if (typeof fm['resource'] === 'string' && pointsIntoReferences(fm['resource'])) add(path, 'a copied concept must not point into the sender’s references/');
    if (hasReferencesLink(parsed.body)) add(path, 'a copied concept must not link into the sender’s references/');
  }
  if (options.digest === true && !digest) add('digest.md', 'the bundle has no digest.md');
  return { ok: problems.length === 0, problems };
}
