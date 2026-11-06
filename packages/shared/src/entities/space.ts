import { z } from 'zod';
import { PersonId, TeamId } from '../ids.ts';

// P20-01 (docs: Personal and Team spaces). A space is where a kept thing belongs: one person's Personal space, or a team's.
// The database side is kernel migration 0016 (`app.readable_space_ids`, `app.personal_space_access`); every table that
// holds space data carries exactly one of `team_id` / `owner_person_id` (see the policy template in that migration).

export const SpaceKind = z.enum(['person', 'team']);
export type SpaceKind = z.infer<typeof SpaceKind>;

/** A space as an object: `{ kind: 'person', personId }` or `{ kind: 'team', teamId }`. */
export const Space = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), personId: PersonId }),
  z.object({ kind: z.literal('team'), teamId: TeamId }),
]);
export type Space = z.infer<typeof Space>;

/** A space as one short string, for URLs, tool arguments, citations and event fields: `person:<uuid>` or `team:<uuid>`. */
export const SpaceRef = z.string().regex(/^(person|team):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'person:<id> or team:<id>');
export type SpaceRef = z.infer<typeof SpaceRef>;

/** The string form of a space. */
export const spaceRefOf = (space: Space): SpaceRef => (space.kind === 'person' ? `person:${space.personId}` : `team:${space.teamId}`);

/** The object form of a space string; `undefined` when the text is not a well-formed reference (never throws). */
export function parseSpaceRef(ref: string): Space | undefined {
  if (!SpaceRef.safeParse(ref).success) return undefined;
  const at = ref.indexOf(':');
  const id = ref.slice(at + 1).toLowerCase();
  const parsed = Space.safeParse(ref.startsWith('person:') ? { kind: 'person', personId: id } : { kind: 'team', teamId: id });
  return parsed.success ? parsed.data : undefined;
}

/** The id inside a space (the person's or the team's): what `owner_person_id` / `team_id` hold. */
export const spaceIdOf = (space: Space): string => (space.kind === 'person' ? space.personId : space.teamId);
