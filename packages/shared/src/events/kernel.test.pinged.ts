import { z } from 'zod';
import { WorkspaceId } from '../ids.ts';

/** Test-only event proving the registry and upcast mechanism (v1). */
export const KernelTestPingedEvent = z.object({
  type: z.literal('kernel.test.pinged'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  note: z.string(),
});
export type KernelTestPingedEvent = z.infer<typeof KernelTestPingedEvent>;
