import { z } from 'zod';
import { ReadStateEntry, ReadTargetType } from '../../entities/read-state.ts';

/** One target as the query writes it: `channel:<uuid>` or `thread:<uuid>`. */
export const ReadStateTargetSpec = z
  .string()
  .regex(/^(channel|thread):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be channel:<uuid> or thread:<uuid>');
export type ReadStateTargetSpec = z.infer<typeof ReadStateTargetSpec>;

const splitTargets = (list: string): string[] => list.split(',').map((t) => t.trim());

/** `targets` is a comma-separated list of 1 to 100 target specs. */
export const GetReadStateRequest = z.strictObject({
  targets: z
    .string()
    .min(1)
    .max(4_000)
    .refine(
      (list) => {
        const parts = splitTargets(list);
        return parts.length >= 1 && parts.length <= 100 && parts.every((p) => ReadStateTargetSpec.safeParse(p).success);
      },
      { message: 'must be 1 to 100 comma-separated targets, each channel:<uuid> or thread:<uuid>' },
    ),
});
export type GetReadStateRequest = z.infer<typeof GetReadStateRequest>;

/** One entry per requested target, in order; a target nothing was ever received for is `{ lastReadId: null, unreadCount: 0, followed: false }`. */
export const GetReadStateResponse = z.object({ states: z.array(ReadStateEntry) });
export type GetReadStateResponse = z.infer<typeof GetReadStateResponse>;
export const getReadStateRoute = { method: 'GET', path: '/api/read-state' } as const;

/** Targets of a validated `targets` query value. */
export const parseReadStateTargets = (list: string): Array<{ targetType: ReadTargetType; targetId: string }> =>
  splitTargets(list).map((spec) => {
    const [type = '', id = ''] = spec.split(':');
    return { targetType: ReadTargetType.parse(type), targetId: id.toLowerCase() };
  });
