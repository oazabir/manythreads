import { parseDocument, stringify as stringifyYaml, visit } from 'yaml';
import { z } from 'zod';

// OKF concepts (SPEC §12.1, PLAN D6): one Markdown file per concept, YAML frontmatter with a non-empty `type`, the path is the identity.
//
// THIS IS THE MINIMUM P5-14 (`memory-git-mirror`) NEEDS, written so that P5-24 (the full `packages/shared/src/okf`: `OkfIndex`/`OkfLog`,
// `sources` with credibility signals and `usage_window`, the actor convention, `MemoryConcept`, the 40 hostile inputs at 50 ms) extends this file
// in place instead of replacing it: the names below are the ones PLAN P5-24 lists (`parseConcept`, `serializeConcept`, `OkfFrontmatter`,
// `trustTier`, `isStale`); P5-24 adds fields to `OkfFrontmatter`, never renames them. What is here is already the contract of the hard parts:
//
//   * pure and linear-time: the frontmatter is found by a line scan and capped (64 KB) BEFORE any YAML parser sees it; flow nesting deeper than
//     `OKF_MAX_FLOW_DEPTH` is refused by a character scan (a parser's recursion is never fed 64 KB of `[`);
//   * YAML aliases and anchors are refused (no expansion is ever made: `maxAliasCount: 0`, and an anchor is refused even when nothing uses it);
//   * extension keys are kept (`z.looseObject`: OKF §4.1, unknown keys are fine), known keys with the wrong shape are refused with their name.

/** The OKF version the bundle's root `index.md` carries (`okf_version: "0.2"`). */
export const OKF_VERSION = '0.2';
/** The largest frontmatter, in bytes (the closing fence included in neither). */
export const OKF_FRONTMATTER_MAX_BYTES = 64 * 1024;
/** The deepest `[` / `{` nesting a frontmatter may have. */
export const OKF_MAX_FLOW_DEPTH = 32;

/** `draft`, `stable` (the default when the key is absent) or `deprecated` (kept for links and history, never recalled by default). */
export const OkfStatus = z.enum(['draft', 'stable', 'deprecated']);
export type OkfStatus = z.infer<typeof OkfStatus>;

const Verification = z.looseObject({ by: z.string().min(1).max(200), at: z.string().max(64).optional() });

/**
 * The frontmatter of a concept. `type` is the only required key and its value is free (unknown types are fine). The platform sets `generated`,
 * `verified` and `origin`; a person or the Archivist sets the rest. A bare `verified` mapping is read as a one-element list.
 */
export const OkfFrontmatter = z.looseObject({
  type: z.string().trim().min(1).max(200),
  title: z.string().max(500).optional(),
  description: z.string().max(2_000).optional(),
  tags: z.array(z.string().max(100)).max(100).optional(),
  status: OkfStatus.optional(),
  stale_after: z.string().max(64).optional(),
  generated: z.looseObject({ by: z.string().min(1).max(200), at: z.string().max(64).optional() }).optional(),
  verified: z.preprocess((v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? [v] : v), z.array(Verification).max(100)).optional(),
  origin: z.string().max(64).optional(),
  share: z.string().max(64).optional(),
});
export type OkfFrontmatter = z.infer<typeof OkfFrontmatter>;

export type OkfSplit = { ok: true; frontmatter: string; body: string } | { ok: false; reason: string };

/** The frontmatter block and the body after it. Line-scanned (no regular expression over the whole text), a byte-order mark is stripped. */
export function splitConcept(content: string): OkfSplit {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const firstEnd = text.indexOf('\n');
  const first = (firstEnd === -1 ? text : text.slice(0, firstEnd)).replace(/\r$/, '');
  if (first !== '---') return { ok: false, reason: 'the file does not open with a --- frontmatter line' };
  const start = firstEnd + 1;
  let pos = start;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end).replace(/\r$/, '');
    if (line === '---' || line === '...') {
      const frontmatter = text.slice(start, pos);
      if (new TextEncoder().encode(frontmatter).length > OKF_FRONTMATTER_MAX_BYTES) return { ok: false, reason: `the frontmatter is larger than ${OKF_FRONTMATTER_MAX_BYTES} bytes` };
      return { ok: true, frontmatter, body: nl === -1 ? '' : text.slice(nl + 1) };
    }
    // The cap is checked while scanning, so a file that never closes its frontmatter costs one pass up to the cap and no more.
    if (end - start > OKF_FRONTMATTER_MAX_BYTES) return { ok: false, reason: `the frontmatter is larger than ${OKF_FRONTMATTER_MAX_BYTES} bytes` };
    if (nl === -1) break;
    pos = nl + 1;
  }
  return { ok: false, reason: 'the frontmatter never closes with a --- line' };
}

/** The deepest `[` / `{` nesting of the text (quotes are not understood on purpose: this is a ceiling, not a parser). Linear. */
function flowDepth(text: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0x5b || c === 0x7b) {
      depth += 1;
      if (depth > max) max = depth;
    } else if ((c === 0x5d || c === 0x7d) && depth > 0) {
      depth -= 1;
    }
  }
  return max;
}

export type ParsedConcept = { ok: true; frontmatter: OkfFrontmatter; body: string } | { ok: false; reason: string };

/** `okf_invalid` carries a reason in words, never a stack: this is what the writer (P5-25) shows next to the file name. */
const firstIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (issue === undefined) return 'the frontmatter is not valid';
  const path = issue.path.map(String).join('.');
  if (issue.code === 'invalid_type' && path === 'type') return 'the frontmatter has no `type`';
  return `${path === '' ? 'the frontmatter' : `\`${path}\``}: ${issue.message}`.slice(0, 200);
};

/** Parses a concept file: the frontmatter validated, the body untouched. Never throws. */
export function parseConcept(content: string): ParsedConcept {
  const split = splitConcept(content);
  if (!split.ok) return split;
  if (flowDepth(split.frontmatter) > OKF_MAX_FLOW_DEPTH) return { ok: false, reason: `the frontmatter nests deeper than ${OKF_MAX_FLOW_DEPTH} levels` };
  let value: unknown;
  try {
    const doc = parseDocument(split.frontmatter, { uniqueKeys: true, version: '1.2', logLevel: 'silent' });
    if (doc.errors.length > 0) return { ok: false, reason: `the frontmatter is not valid YAML: ${(doc.errors[0]?.message ?? '').split('\n')[0]?.slice(0, 160) ?? ''}` };
    // Nothing is expanded here: an alias or an anchor anywhere is refused, whether or not anything uses it.
    const found: { reason: string | null } = { reason: null };
    visit(doc, {
      Alias() {
        found.reason = 'the frontmatter uses a YAML alias';
        return visit.BREAK;
      },
      Node(_key, node) {
        const anchor = (node as { anchor?: unknown }).anchor;
        if (typeof anchor === 'string' && anchor !== '') {
          found.reason = 'the frontmatter uses a YAML anchor';
          return visit.BREAK;
        }
        return undefined;
      },
    });
    if (found.reason !== null) return { ok: false, reason: found.reason };
    value = doc.toJS({ maxAliasCount: 0 });
  } catch (err) {
    return { ok: false, reason: `the frontmatter could not be read: ${(err instanceof Error ? err.message : 'unknown error').split('\n')[0]?.slice(0, 160) ?? ''}` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'the frontmatter is not a mapping' };
  const parsed = OkfFrontmatter.safeParse(value);
  if (!parsed.success) return { ok: false, reason: firstIssue(parsed.error) };
  return { ok: true, frontmatter: parsed.data, body: split.body };
}

/** A concept as a file: `---`, the frontmatter, `---`, a blank line, the body. The inverse of `parseConcept` for anything it accepted. */
export function serializeConcept(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 });
  return `---\n${yaml}---\n\n${body.replace(/^\s*\n+/, '').replace(/\s+$/, '')}\n`;
}

/** SPEC §12.1: no `verified` → unverified; machine verifiers only → machine-confirmed; a `human:` verifier → human-reviewed. Advisory, never an access rule. */
export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

export function trustTier(frontmatter: Pick<OkfFrontmatter, 'verified'>): TrustTier {
  const verified = frontmatter.verified ?? [];
  if (verified.length === 0) return 'unverified';
  return verified.some((v) => v.by.startsWith('human:')) ? 'human-reviewed' : 'machine-confirmed';
}

/** True when `stale_after` is a date that `now` has reached. An unparseable date is not stale (the concept is shown as it is). */
export function isStale(frontmatter: Pick<OkfFrontmatter, 'stale_after'>, now: Date): boolean {
  if (frontmatter.stale_after === undefined) return false;
  const at = Date.parse(frontmatter.stale_after);
  return Number.isFinite(at) && now.getTime() >= at;
}

/** `memory/**.md` except the platform's own `index.md` and `log.md`: the files the bundle's rules apply to as concepts. */
export function isConceptPath(path: string): boolean {
  if (!path.startsWith('memory/') || !path.endsWith('.md')) return false;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name !== 'index.md' && name !== 'log.md';
}
