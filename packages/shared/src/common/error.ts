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
  /** 422: bytes that are not text (a NUL byte anywhere, or invalid UTF-8) or larger than 1 MB were sent to the team repo, which holds text only; upload them as an attachment. */
  'attachment_not_in_repo',
  /** 413: the team repository is over its size or file-count quota (`MANYTHREADS_REPO_MAX_BYTES`, `MANYTHREADS_REPO_MAX_FILES`); delete files or ask an admin to raise it. */
  'repo_quota_exceeded',
  /** 409: a conversation cannot be opened with a bot whose BOT.md lists no `conversation` trigger; nothing would ever answer in it (conversations plugin). */
  'bot_has_no_conversation_trigger',
  /** 422: a file under `memory/` that is not valid OKF (no frontmatter, no `type`, bad YAML); the envelope names the file and the reason, nothing is committed. */
  'okf_invalid',
  /** 409: a message that names `@here` or `@channel` in a room with more people than the confirmation limit must be sent with `confirmBroadcast: true`; the message says how many people it would notify (channels plugin, P14-02). */
  'broadcast_needs_confirmation',
  /** 422: a person's yes (`allowed: true`) for a bot that never asks to read Personal files (its BOT.md has no `personal.read`); nothing is recorded, a no is still accepted (bots plugin, P20-09). */
  'bot_cannot_ask_personal',
  /** 409: the person's Personal Memory already holds the most files it can (2,000). Unlike `conflict` (the file moved since it was opened), reloading does not help: delete a file first (memory plugin, P20-05). */
  'personal_memory_full',
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
