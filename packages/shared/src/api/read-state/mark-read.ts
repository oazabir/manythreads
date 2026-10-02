import { z } from 'zod';
import { ReadStateEntry, ReadTargetType } from '../../entities/read-state.ts';
import { MessageId } from '../../ids.ts';

/** Mark everything up to and including message `upTo` as read. It never moves the read position backwards. */
export const MarkReadRequest = z.strictObject({
  targetType: ReadTargetType,
  targetId: z.uuid(),
  upTo: MessageId,
});
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;
export const MarkReadResponse = ReadStateEntry;
export type MarkReadResponse = z.infer<typeof MarkReadResponse>;
export const markReadRoute = { method: 'POST', path: '/api/read-state/mark' } as const;
