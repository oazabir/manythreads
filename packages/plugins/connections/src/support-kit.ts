import type { ToolApprovalCard } from '@manythreads/sdk';
import { z } from 'zod';
import { ProviderError } from './oauth/api.ts';
import { cardOf, oneLine, str } from './person-kit.ts';

// The shared pieces of the support and CRM tools (PLAN P16-07): support-tools.ts (Zendesk, Intercom) and crm-tools.ts (HubSpot, Salesforce) are made of them. The rules
// they hold the tools to, learned from the mail tools (MISTAKES.md):
//
//   * An id is checked against the form that provider's ids really have, never a pattern that lets a dot, a slash or a space through; it is encoded again when it goes
//     into a path. A value that goes into a query language (Zendesk search, SOQL) is quoted for it, never concatenated raw.
//   * Everything that changes something outside is a `write` with a card. The card leads with the act and the target and keeps its summary under the 300 characters the
//     approvals store keeps; the text that will be sent is split into pieces of at most 250 characters, so the store (300 characters a string, ten items a list) keeps ALL of
//     it, and the person approving reads exactly the text that goes out.
//   * An error, an answer for the model or an event carries our words, an id and a count, never the words of a ticket, a customer or a case. The text of a ticket reaches the
//     model only in the answer of a read tool, which tells the model it is data.

/** A number the provider gave as a decimal string (a Zendesk ticket, a HubSpot object): no sign, no leading zero, no dot, at most 15 digits. */
export const numericId = (what: string): z.ZodString => z.string().regex(/^[1-9][0-9]{0,14}$/, 'not an id').describe(`The id of the ${what}, as an earlier search answered it.`);
/** An id made of letters and digits only (an Intercom conversation). */
export const wordId = (what: string): z.ZodString => z.string().regex(/^[A-Za-z0-9]{1,40}$/, 'not an id').describe(`The id of the ${what}, as an earlier search answered it.`);
/** A Salesforce record id: 15 characters, or 18 with the case check at the end. */
export const salesforceId = (what: string): z.ZodString => z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/, 'not a Salesforce id').describe(`The id of the ${what}, as an earlier search answered it.`);

/** The id a provider gave for a thing, as a short string (a number becomes its digits); null when it is neither. */
export const idStr = (v: unknown): string | null => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : str(v, 40));

/** Characters that make text read differently from how it is shown: control characters (except a line break and a tab), and the marks that reorder or hide text. */
function plainText(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200b || c === 0xfeff) return false;
  }
  return true;
}

/** The most characters of a reply or a note: the whole of it fits on the approval card (`CARD_PIECE` * `CARD_PIECES`). */
export const MAX_NOTE = 2000;
export const noteText = (what: string): z.ZodString => z.string().min(1).max(MAX_NOTE).refine(plainText, 'plain text only').refine((v) => v.trim() !== '', 'empty').describe(what);
export const searchWords = z.string().min(1).max(200).refine(plainText, 'plain text only').describe('Words to look for.');

export const CARD_PIECE = 250;
export const CARD_PIECES = 8;
/** The text cut in pieces of at most 250 characters, in order, so that joining them gives the text back. A piece never splits a surrogate pair. */
export function pieces(text: string, size = CARD_PIECE): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    if (current.length + ch.length > size) {
      out.push(current);
      current = '';
    }
    current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

/**
 * The card of a tool that sends or saves text. The summary leads with what is done and where, then as much of the text as fits under the platform's 300 characters;
 * `text` holds all of it, in pieces the store keeps whole. `facts` are the short lines that say what the act does to the customer.
 */
export function textCard(lead: string, text: string, facts: Record<string, string | number | boolean>): ToolApprovalCard {
  const room = Math.max(0, 276 - lead.length);
  const excerpt = room > 20 ? oneLine(text, room) : '';
  return cardOf(excerpt === '' ? lead : `${lead}: “${excerpt}”`, { ...facts, text: pieces(text).slice(0, CARD_PIECES) });
}

/** A plain text as HTML for a provider that renders HTML (Intercom, HubSpot notes): what shows is the text that was approved, not markup the model wrote. */
export const htmlOf = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replace(/\r\n?|\n/g, '<br>');

/** Removes the characters that would end a quoted word in a search language, and anything that is not text; the rest of the quoting is the caller's. */
const bare = (s: string): string => {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
};

/** Zendesk's search syntax: the words as one quoted phrase, with a quote or backslash in them dropped so they can never become a filter of their own. */
export const zendeskPhrase = (s: string): string => `"${bare(s).replaceAll('"', ' ').replaceAll('\\', ' ').replace(/\s+/g, ' ').trim()}"`;

/** SOQL's string literal: a backslash and a quote are escaped; `like` also escapes the wildcards, so a word is looked for as it is. Newlines and the like are spaces. */
export function soqlString(s: string, like = false): string {
  let out = bare(s).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  if (like) out = out.replaceAll('%', '\\%').replaceAll('_', '\\_');
  return `'${out}'`;
}

/** A provider that answered without what a write needs (the admin id Intercom wants): our words, no provider text. */
export const unexpected = (what: string): ProviderError => new ProviderError(502, `${what} answered in a way that cannot be used, so nothing was changed.`);
