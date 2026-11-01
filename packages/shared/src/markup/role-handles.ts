import { personHandles, type HandleSubject } from './handles.ts';

/**
 * Role groups (P14-03): a role tag a team defines in `TEAM.md` (`role:on-call`) is also a mention handle (`@on-call`) for the people on that team who hold
 * the tag. This file is the one definition of which tags become handles and who the handle means; the server (which notifies), the composer (which
 * offers the handle) and the bots' `handover.toPerson` check all read the same list. Pure, so every side applies the same rule.
 *
 * Who wins when a handle means more than one thing:
 *  1. an exact person handle wins: if anyone on the team answers to the handle with the local part of their email or their name as a slug, the tag is
 *     not a mention handle and `@handle` keeps meaning the person (or nobody, when two people share it). A first name does NOT close a tag: anyone could
 *     otherwise kill a team's tag by joining with that first name. A first name still finds a person when no tag has the word (see `matchHandle`);
 *  2. a bot wins: a bot of the team with that slug is mentioned by `@slug`, and the tag is not a handle;
 *  3. a few words are reserved (see `RESERVED_GROUP_HANDLES`): they are kept for whole-channel and role words and are never handles, and a team cannot
 *     define a tag with one (`reservedTagReason`).
 * A tag that loses is still a group (`mentionable: false`, with the reason in `closedBy`): approvals and a bot's `handover.toPerson` name the tag, not the
 * handle, so they resolve the same people; only the `@` form is closed.
 */
const RESERVED_BASE = ['here', 'channel', 'everyone', 'everybody', 'all', 'admin', 'administrator', 'owner', 'team', 'staff', 'security', 'moderator', 'mod'];
/** Words that are never a group handle and cannot be a new role tag: whole-channel words and the words people read as an authority (and their plurals). */
export const RESERVED_GROUP_HANDLES: readonly string[] = [...RESERVED_BASE, 'admins', 'administrators', 'owners', 'teams', 'moderators', 'mods', 'channels'];

/** Why a tag is not a mention handle. */
export type GroupClosedBy = 'person' | 'bot' | 'reserved';

/** A plain sentence when `tag` may not be defined as a role tag because its word is reserved, else null. */
export function reservedTagReason(tag: string): string | null {
  const h = roleHandle(tag);
  if (h === null || !RESERVED_GROUP_HANDLES.includes(h)) return null;
  return `"${h}" is kept for everyone-style mentions and for roles people trust; pick another name for the tag, for example ${tag}-group.`;
}

const ROLE_TAG = /^role:([a-z][a-z0-9-]*)$/;

/** `role:on-call` becomes `on-call`; anything that is not a role tag (`person:<id>`, a bare word) is null. */
export function roleHandle(tag: string): string | null {
  const m = ROLE_TAG.exec(tag);
  return m?.[1] ?? null;
}

/** One group: the tag, the handle it would answer to, the people (person ids) who hold it, and whether `@handle` may be used (see the rules above). */
export interface RoleGroup {
  tag: string;
  handle: string;
  personIds: string[];
  mentionable: boolean;
  /** Why `@handle` is closed (`mentionable` is false), else null. */
  closedBy: GroupClosedBy | null;
}

export interface RoleGroupSource {
  /** The role tags to consider, each with the person ids of the team's members who hold it (the teams plugin lists the tags its roster shows; one nobody holds may be left out). */
  tags: ReadonlyArray<{ tag: string; personIds: readonly string[] }>;
  /** The people of the team, for the "a person wins" rule. */
  people: ReadonlyArray<Pick<HandleSubject, 'displayName' | 'email'>>;
  /** The slugs of the team's bots, for the "a bot wins" rule. */
  botSlugs: readonly string[];
}

/** Does anyone in `people` answer to `handle` exactly (an email local part or a name slug)? A first name does not count. */
export function someoneAnswersTo(handle: string, people: ReadonlyArray<Pick<HandleSubject, 'displayName' | 'email'>>): boolean {
  const h = handle.normalize('NFC').toLowerCase();
  return people.some((p) => {
    const hs = personHandles(p);
    return hs.exact.includes(h);
  });
}

/** The groups of a team, in handle order: every role tag given; `mentionable` is false (and `closedBy` says why) when a person, a bot or a reserved word already has its handle. */
export function roleGroups(source: RoleGroupSource): RoleGroup[] {
  const bots = new Set(source.botSlugs.map((s) => s.toLowerCase()));
  const out: RoleGroup[] = [];
  for (const { tag, personIds } of source.tags) {
    const handle = roleHandle(tag);
    if (handle === null) continue;
    const closedBy: GroupClosedBy | null = RESERVED_GROUP_HANDLES.includes(handle) ? 'reserved' : bots.has(handle) ? 'bot' : someoneAnswersTo(handle, source.people) ? 'person' : null;
    out.push({ tag, handle, personIds: [...new Set(personIds)], mentionable: closedBy === null, closedBy });
  }
  return out.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
}
