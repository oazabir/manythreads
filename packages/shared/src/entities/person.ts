import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { PersonEmailId, PersonId, WorkspaceId } from '../ids.ts';

// PLAN.md A.2 `people` and `person_emails`. PersonStatus matches the SQL CHECK in 0004_identity.sql.

export const PersonStatus = z.enum(['active', 'suspended']);
export type PersonStatus = z.infer<typeof PersonStatus>;

export const Person = z.object({
  id: PersonId,
  workspaceId: WorkspaceId,
  displayName: z.string().min(1),
  primaryEmail: z.string().min(3),
  status: PersonStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Person = z.infer<typeof Person>;

/** An extra address of a person; `verifiedAt` is null until the verification link was used. */
export const PersonEmail = z.object({
  id: PersonEmailId,
  workspaceId: WorkspaceId,
  personId: PersonId,
  email: z.string().min(3),
  verifiedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type PersonEmail = z.infer<typeof PersonEmail>;
