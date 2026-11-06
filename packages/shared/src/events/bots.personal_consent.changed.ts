import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotId, PersonId, WorkspaceId } from '../ids.ts';

/**
 * A person changed whether a bot may read their Personal space (P20-09). Ids and the answer only. It is enforced on the bot's next tool call, so this is also
 * the event a client listens to when it shows a bot's consent.
 */
export const BotsPersonalConsentChangedEvent = z.object({
  type: z.literal('bots.personal_consent.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  botId: BotId,
  allowed: z.boolean(),
  at: IsoDateTime,
});
export type BotsPersonalConsentChangedEvent = z.infer<typeof BotsPersonalConsentChangedEvent>;
