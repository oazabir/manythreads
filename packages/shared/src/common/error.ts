import { z } from 'zod';

export const ErrorCode = z.enum([
  'validation_failed',
  'not_found',
  'forbidden',
  'rate_limited',
  'conflict',
  'internal',
  'unauthenticated',
  /** 410: a one-time link or token that was used, expired or never existed. */
  'gone',
  /** 422: bytes that are not text (a NUL byte in the first 8 KB) or larger than 1 MB were sent to the team repo, which holds text only; upload them as an attachment. */
  'attachment_not_in_repo',
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
