import { parseConcept } from '@manythreads/shared';

/**
 * True when the concept's latest author or its last verifier is a person (`human:<id>`): the writer stamps a person's own edit that way, and only
 * a person's verification puts a `human:` entry in `verified` (SPEC §12.1). A bot may never overwrite such a concept — it files a draft sibling.
 */
export function isPersonOwned(text: string): boolean {
  const parsed = parseConcept(text);
  if (!parsed.ok) return false;
  if ((parsed.frontmatter.generated?.by ?? '').startsWith('human:')) return true;
  const verified = parsed.frontmatter.verified ?? [];
  const last = verified[verified.length - 1];
  return last !== undefined && last.by.startsWith('human:');
}
