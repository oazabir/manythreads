/**
 * Small changes to how a message's words are drawn, never to what is stored or copied (P34-01).
 */

/**
 * A handover message starts with its author's own name ("Web smoke tester → @committer: done"), and the row already shows that name in its
 * header, so the row draws "→ @committer: done". Match the header name literally and require a Markdown mention followed by a colon.
 */
export function withoutOwnName(body: string, authorName: string): string {
  const lead = `${authorName} → `;
  if (authorName === '' || !body.startsWith(lead)) return body;
  const recipient = /^@[\p{L}\p{N}](?:[\p{L}\p{N}_.-]{0,62}[\p{L}\p{N}])?:/u;
  return recipient.test(body.slice(lead.length)) ? body.slice(authorName.length + 1) : body;
}

/** A code span that looks like a commit hash: only hex digits, more than twelve of them, at least one a number and one a letter (a long number, a timestamp or an order id is not a hash). */
export function isLongHash(value: string): boolean {
  return /^[0-9a-f]{13,64}$/i.test(value) && /\d/.test(value) && /[a-f]/i.test(value);
}
