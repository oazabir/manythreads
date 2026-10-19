import { refuseBankFields } from '@manythreads/sdk';
import { z } from 'zod';

// Everything a caller may hand to memory, and nothing about WHERE it goes. No schema here has a `bank`, `team` or `workspace` field, all are
// strict, and `refuseBankFields` runs before parsing so that a forged one gets its own answer instead of a generic "unrecognized key". The same
// schemas shape the provider's own inputs. (`refuseBankFields` itself is the SDK's: the memory plugin's `memory.recall`/`memory.write` doors use it too.)
export { refuseBankFields };

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
  /** Keep only facts carrying all of these labels: a concept's own tags (`tag:<tag>`) or any of the platform's (`okf`, `type:<type>`, `trust:…`). */
  tags: z.array(Tag).max(10).optional(),
  /** Keep only facts about concepts of these OKF `type`s (a fact that is not a concept of the bundle carries none and is left out). */
  types: z.array(z.string().min(1).max(200)).max(20).optional(),
  /**
   * Include the team's `deprecated` concepts, which the mirror takes out of the bank: they are found in the frontmatter index and read from git.
   * Off by default, so a deprecated concept is not recalled (PLAN criterion 17).
   */
  includeDeprecated: z.boolean().optional(),
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
