import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { PersonId, WorkspaceId } from '../ids.ts';

/**
 * A file of a person's own Memory was written, restored or deleted (P20-05). Ids, the kind of change and the version only: never the path, the title or any text
 * (a Personal path can say as much as the file). `authorKind` is who made the change: the person, a bot of a run the person asked, or the platform.
 */
export const MemoryPersonalWrittenEvent = z.object({
  type: z.literal('memory.personal.written'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  op: z.enum(['put', 'delete']),
  versionNo: z.number().int().min(1),
  authorKind: z.enum(['person', 'bot', 'system']),
  at: IsoDateTime,
});
export type MemoryPersonalWrittenEvent = z.infer<typeof MemoryPersonalWrittenEvent>;
