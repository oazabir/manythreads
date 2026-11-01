import { z } from 'zod';
import { TeamId, WorkspaceId } from '../ids.ts';

/**
 * A team defined a role tag whose `@` handle is already taken (P14-03): `person` (someone on the team answers to the word with their email part or name),
 * `bot` (a bot of the team has the slug). The tag still exists and still works for hand-overs; only `@handle` mentions are closed. A reserved word is
 * refused when the tag is defined, so it never reaches this event. Written once, when the tag is defined: a later rename that takes the word shows in the
 * team's tag list (`closedBy`), not as a new event.
 */
export const TeamTagHandleClosedEvent = z.object({
  type: z.literal('team.tag.handle_closed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  tag: z.string(),
  handle: z.string(),
  reason: z.enum(['person', 'bot', 'reserved']),
});
export type TeamTagHandleClosedEvent = z.infer<typeof TeamTagHandleClosedEvent>;
