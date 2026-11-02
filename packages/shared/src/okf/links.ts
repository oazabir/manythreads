import { isMemoryPath } from '../entities/repo-paths.ts';
import { isConceptPath, parseConcept, serializeConcept } from './concept.ts';

// Two pure helpers every writer of the OKF bundle shares: the `memory.write` tool (the memory plugin) and the memory inbox's commit step. They live here
// so neither plugin imports the other.

/**
 * One concept as text, in the order `parseConcept` reads it back (so the writer's own stamping changes nothing): `serializeConcept` of the
 * frontmatter and body, then the round trip through the parser. A frontmatter the parser refuses is returned as serialized — the caller parses it
 * and answers `okf_invalid` with the parser's own reason, the same sentence a person's raw save would get.
 */
export function conceptText(frontmatter: Record<string, unknown>, body: string): string {
  const text = serializeConcept(frontmatter, body);
  const parsed = parseConcept(text);
  return parsed.ok ? serializeConcept(parsed.frontmatter, parsed.body) : text;
}

// ---- relative links become bundle-absolute ones (SPEC §12.2 step 5) -------------------------------------------------------------------

/** An inline Markdown link or image: `](target)` with an optional title. One linear pass; a target cannot contain a bare `)`. */
const LINK = /\]\(\s*([^)\s]+)((?:\s+"[^"]*")?)\s*\)/g;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** `memory/facts/a.md` + `../facts/b.md` → `facts/b.md`, resolving `.`/`..`; null when the target climbs out of the bundle. */
function resolvePosix(fromDir: string, target: string): string | null {
  const out: string[] = [];
  for (const segment of `${fromDir}${target}`.split('/')) {
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

/** The `/`-absolute target of a bundle link (OKF §6.1: `/facts/x.md` is `memory/facts/x.md`), or null to leave the link as the author wrote it. */
function bundleTarget(target: string, fromDir: string): string | null {
  if (target === '' || target.startsWith('#') || target.startsWith('/')) return null;
  if (SCHEME.test(target) || target.includes('%')) return null;
  const hash = target.indexOf('#');
  const path = hash === -1 ? target : target.slice(0, hash);
  const fragment = hash === -1 ? '' : target.slice(hash);
  const resolved = resolvePosix(fromDir, path);
  if (resolved === null || !isMemoryPath(resolved) || !isConceptPath(resolved)) return null;
  return `/${resolved.slice('memory/'.length)}${fragment}`;
}

/**
 * Rewrites every relative link of a concept body that points at another concept of the same bundle into a bundle-absolute one (`/facts/x.md`), the
 * form the platform's own `index.md` and `log.md` use (SPEC §12.2 step 5, OKF §6.1). A link to somewhere else — a URL, an anchor, a repo file
 * outside `memory/`, or a target that climbs out of the bundle — is left exactly as written. Linear in the body.
 */
export function bundleAbsoluteLinks(body: string, fromPath: string): string {
  const fromDir = fromPath.slice(0, fromPath.lastIndexOf('/') + 1);
  return body.replace(LINK, (whole, target: string, title: string) => {
    const absolute = bundleTarget(target, fromDir);
    return absolute === null ? whole : `](${absolute}${title})`;
  });
}
