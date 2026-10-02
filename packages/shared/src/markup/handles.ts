/**
 * The handle rule for `@person` mentions: how a typed handle finds a person. Pure, so the server (which stores the mention) and
 * the composer (which offers the autocomplete) apply the same rule.
 *
 * A person answers to up to three lower-case handles:
 *  - `email`: the local part of the primary email (`nadia.k` for nadia.k@example.com);
 *  - `name`: the display name with every run of characters that are not letters or digits turned into `-`, trimmed of `-`
 *    (`nadia-khan` for "Nadia Khan");
 *  - `first`: the first word of the display name (`nadia`).
 *
 * `email` and `name` are exact: a handle that equals one of them finds that person, and two people sharing one is ambiguous (no
 * mention is made, nobody is guessed). `first` is a convenience and counts only when exactly one candidate has it and no exact
 * match exists. The candidates are the people who can read the channel, so `@nadia` means the Nadia of this conversation.
 */
export interface HandleSubject {
  id: string;
  displayName: string;
  email: string;
}

const NON_WORD = /[^\p{L}\p{N}]+/gu;

/** The exact handles of a person (`email` local part and `name` slug) and the `first` word, all lower-case. */
export function personHandles(person: Pick<HandleSubject, 'displayName' | 'email'>): { exact: string[]; first: string | null } {
  const local = person.email.split('@')[0]?.normalize('NFC').toLowerCase() ?? '';
  const name = person.displayName.normalize('NFC').toLowerCase();
  const slug = name.replace(NON_WORD, '-').replace(/^-+|-+$/g, '');
  const first = name.split(NON_WORD).find((w) => w !== '') ?? null;
  return { exact: [...new Set([local, slug].filter((h) => h !== ''))], first };
}

/** The first word of a handle: what a database prefix filter can narrow candidates by (`nadia.k` and `nadia-khan` give `nadia`). */
export function handlePrefix(handle: string): string {
  return handle.normalize('NFC').toLowerCase().split(/[-._]/)[0] ?? '';
}

/** The id of the one person `handle` means among `candidates`, or null (nobody, or ambiguous). `handle` has no `@`. */
export function matchHandle(handle: string, candidates: readonly HandleSubject[]): string | null {
  const h = handle.normalize('NFC').toLowerCase();
  const exact = candidates.filter((c) => personHandles(c).exact.includes(h));
  if (exact.length > 0) return exact.length === 1 ? (exact[0]?.id ?? null) : null;
  const first = candidates.filter((c) => personHandles(c).first === h);
  return first.length === 1 ? (first[0]?.id ?? null) : null;
}
