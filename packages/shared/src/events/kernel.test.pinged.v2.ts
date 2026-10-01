import { z } from 'zod';
import { WorkspaceId } from '../ids.ts';
import type { KernelTestPingedEvent } from './kernel.test.pinged.ts';

/** v2 adds the required `count`; v1 events are upcast with count 0. */
export const KernelTestPingedEventV2 = z.object({
  type: z.literal('kernel.test.pinged'),
  schemaVersion: z.literal(2),
  workspaceId: WorkspaceId,
  note: z.string(),
  count: z.number().int(),
});
export type KernelTestPingedEventV2 = z.infer<typeof KernelTestPingedEventV2>;

export const upcastKernelTestPingedV1ToV2 = (event: KernelTestPingedEvent): KernelTestPingedEventV2 => ({
  type: event.type,
  schemaVersion: 2,
  workspaceId: event.workspaceId,
  note: event.note,
  count: 0,
});
