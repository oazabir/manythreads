import { MemoryError } from '@manythreads/sdk';
import { z } from 'zod';

// Everything a caller may hand to memory, and nothing about WHERE it goes. No schema here has a `bank`, `team` or `workspace` field, all are
// strict, and `refuseBankFields` runs before parsing so that a forged one gets its own answer instead of a generic "unrecognized key". The same
// schemas shape the bot-facing tools (the model sees them as the tool's inputSchema in gateway-mcp's catalog) and the provider's own inputs.

/** Any key that could name a bank, a team, a workspace or a tenant, in any spelling (`bank_id`, `teamId`, `memoryBank`, `Team`). */
const BANK_LIKE = /bank|team|workspace|tenant/i;

/** Rejects a field that names a bank. Looks at the top level of the object and of each item of `items`; values are never inspected. */
export function refuseBankFields(input: unknown): void {
  const check = (obj: unknown): void => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const key of Object.keys(obj)) {
      if (BANK_LIKE.test(key)) {
        throw new MemoryError('bank_not_allowed', `“${key}” is not accepted: the memory bank is chosen by the platform from the run, never by the caller.`);
      }
    }
  };
  if (Array.isArray(input)) {
    for (const item of input) check(item);
    return;
  }
  check(input);
  const items = (input as { items?: unknown } | null)?.items;
  if (Array.isArray(items)) for (const item of items) check(item);
}

export const MAX_CONTENT_CHARS = 20_000;
export const MAX_RECALL_LIMIT = 50;

/** A tag a caller may attach: short, plain, and never one of the platform's own (`mt:` is reserved for provenance). */
const Tag = z
  .string()
  .regex(/^[a-z0-9][a-z0-9:_.-]{0,63}$/, 'tags are lowercase words of letters, digits and : _ . -')
  .refine((t) => !t.startsWith('mt:'), { message: 'the mt: prefix is reserved for the platform' });

export const RecallArgs = z.strictObject({
  query: z.string().trim().min(2).max(500),
  limit: z.number().int().min(1).max(MAX_RECALL_LIMIT).optional(),
  tags: z.array(Tag).max(10).optional(),
});
export type RecallArgs = z.infer<typeof RecallArgs>;

export const RetainArgs = z.strictObject({
  content: z.string().trim().min(1).max(MAX_CONTENT_CHARS),
  context: z.string().trim().min(1).max(200).optional(),
  tags: z.array(Tag).max(10).optional(),
});
export type RetainArgs = z.infer<typeof RetainArgs>;

/** The provider's retain item: what a platform caller may set on top of the tool's (a document id, a timestamp, provenance metadata). */
export const RetainItem = z.strictObject({
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
  context: z.string().min(1).max(200).optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  timestamp: z.iso.datetime({ offset: true }).optional(),
  documentId: z.string().min(1).max(200).optional(),
  metadata: z.record(z.string().max(64), z.string().max(500)).optional(),
});
export const RetainItems = z.array(RetainItem).min(1).max(100);

export const RecallRequest = z.strictObject({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(MAX_RECALL_LIMIT).optional(),
  tags: z.array(z.string().min(1).max(64)).max(10).optional(),
});

export const DocumentIds = z.array(z.string().min(1).max(200)).min(1).max(500);
