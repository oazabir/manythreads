import { z } from 'zod';

export const ErrorCode = z.enum([
  'validation_failed',
  'not_found',
  'forbidden',
  'rate_limited',
  'conflict',
  'internal',
  'unauthenticated',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** One validation issue, a plain projection of a ZodIssue (symbols in paths are stringified by the server). */
export const ErrorIssue = z.object({
  code: z.string(),
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
});
export type ErrorIssue = z.infer<typeof ErrorIssue>;

/** Body of every non-2xx response. */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
    details: z.array(ErrorIssue).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
