import type { DocumentAccess } from '@manythreads/shared';

// Work package D2 (P16-08, decision D14): the team-base rule, "everyone on the team may read it at the source". A document goes into a TEAM base only when the service says that
// everyone on the team can open it: a public link, or every member's verified email address is at a listed domain, or every member's address is listed one by one. A share with a group,
// or an answer that could not be read, is NOT everyone: it fails closed. Pure, so it is tested without a service. STUB: answers "not everyone" for every document until D2 fills it in,
// which is the safe side (nothing is indexed into a team base by mistake).
export interface TeamMemberAddress {
  /** The address as the workspace holds it, lower case. */
  email: string;
  verified: boolean;
}

export function everyoneMayRead(access: DocumentAccess, members: readonly TeamMemberAddress[]): boolean {
  void [access, members];
  return false;
}
