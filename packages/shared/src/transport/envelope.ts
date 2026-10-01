import { z } from 'zod';
import { ErrorCode } from '../common/error.ts';

/** Every WebSocket message in either direction: `{ type, id, payload }`, nothing else. */
export const WsEnvelope = z.strictObject({
  type: z.string().min(1).max(100),
  /** Client-chosen correlation id; replies and errors echo it. */
  id: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
});
export type WsEnvelope = z.infer<typeof WsEnvelope>;

/** The envelope the hub sends for a rejected message: `type` is `error`, `id` echoes the request (or `""` when unreadable). */
export const WsErrorEnvelope = z.strictObject({
  type: z.literal('error'),
  id: z.string().max(100),
  payload: z.strictObject({
    code: ErrorCode,
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
  }),
});
export type WsErrorEnvelope = z.infer<typeof WsErrorEnvelope>;
