import type { DocumentAccess } from '@manythreads/shared';

// Work package D2 (P16-08, decision D14): the team-base rule, "everyone on the team may read it at the source". A document goes into a TEAM base only when the service says that
// everyone on the team can open it: a public link, or every member's verified email address is at a listed domain, or every member's address is listed one by one. A share with a group,
// or an answer that could not be read, is NOT everyone: it fails closed. Pure, so it is tested without a service.
//
// Reading of the answer (the documents door gives `{ anyone, domains, users, groups }`, see packages/shared/src/entities/connector-source.ts):
//  * `anyone`  a public link. Everybody may open it, so it passes whatever else is listed and however many members there are.
//  * `groups`  shared with a group, or the answer could not be read (the door says `groups: true` for both). A group's members are not known here, so the document is NOT everyone's.
//  * otherwise every person on the team must be covered: by a listed domain (their verified address ends in `@<domain>`, exactly: a subdomain is another domain) or by being listed.
//    Bots and guests are not people of the team for this rule and are skipped. An address that is not verified covers nobody. A team with nobody to check proves nothing, so it
//    is "not everyone" (the safe side), except for a public link.

export interface TeamMemberAddress {
  /** The member's address as the workspace holds it. Any case; compared lower case. */
  email: string;
  /** True when the workspace has verified that the person owns the address (a sign-in or a link they followed). */
  verified: boolean;
  /** Other addresses of the same person that the workspace has verified; any one of them may be the listed one. */
  others?: readonly string[];
  /** `person` (the default) counts; a `bot` or a `guest` is left out of the rule. */
  kind?: 'person' | 'bot' | 'guest';
}

const lower = (value: string): string => value.trim().toLowerCase();

/** The part after the last `@`, lower case, or null when the text is not an address. */
function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1);
}

export function everyoneMayRead(access: DocumentAccess, members: readonly TeamMemberAddress[]): boolean {
  if (access.anyone) return true;
  if (access.groups) return false;
  const people = members.filter((m) => (m.kind ?? 'person') === 'person');
  if (people.length === 0) return false;
  const domains = new Set(access.domains.map(lower).filter((d) => d !== ''));
  const users = new Set(access.users.map(lower).filter((u) => u !== ''));
  if (domains.size === 0 && users.size === 0) return false;
  return people.every((m) => {
    if (!m.verified) return false;
    return [m.email, ...(m.others ?? [])].map(lower).some((email) => {
      if (email === '') return false;
      if (users.has(email)) return true;
      const domain = domainOf(email);
      return domain !== null && domains.has(domain);
    });
  });
}
