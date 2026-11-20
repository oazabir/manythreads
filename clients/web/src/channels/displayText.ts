/**
 * Small changes to how a message's words are drawn, never to what is stored or copied (P34-01).
 */

/**
 * A handover message starts with its author's own name ("Web smoke tester → @committer: done"), and the row already shows that name in its
 * header, so the row draws "→ @committer: done". Only an exact match of the name followed by the arrow is taken off; any other text is as written.
 */
export function withoutOwnName(body: string, authorName: string): string {
  const name = authorName.trim();
  if (name === '') return body;
  const lead = `${name} → `;
  return body.startsWith(lead) && body.length > lead.length ? `→ ${body.slice(lead.length)}` : body;
}

/** A code span that looks like a commit hash: only hex digits, more than twelve of them, at least one a number and one a letter (a long number, a timestamp or an order id is not a hash). */
export function isLongHash(value: string): boolean {
  return /^[0-9a-f]{13,64}$/i.test(value) && /\d/.test(value) && /[a-f]/i.test(value);
}
