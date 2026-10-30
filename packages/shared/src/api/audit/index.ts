import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { AuditAction, AuditCategory, AuditEntry, AuditOutcome } from '../../entities/audit.ts';
import type { ApiRoute } from '../client/route.ts';

// The audit console (PLAN P10-05): list, export and the public key that checks an export. Workspace owners and admins only.

/** The most rows one page of the list returns. */
export const AUDIT_PAGE_MAX = 200;
/** The most rows one export carries; a larger history is exported in several files, each saying where the next one starts. */
export const AUDIT_EXPORT_MAX_ROWS = 20_000;

/**
 * A bound of a date range. The database has no year 0 and none past 9999, so the year is held to 0001 to 9999 here (a `0000-...` bound used to
 * reach it and answer 500).
 */
const AuditBound = IsoDateTime.refine((s) => /^(?!0000)\d{4}-/.test(s), 'The year must be between 0001 and 9999');

/** The ways to narrow the history. Every field is optional and they combine with "and". `from` is included, `to` is not. */
const auditFilter = {
  /** Who did it: a person's or bot's id. */
  actor: z.uuid().optional(),
  category: AuditCategory.optional(),
  /** An exact action such as `proposal.applied`. */
  action: AuditAction.optional(),
  team: z.uuid().optional(),
  /** What it was done to: a kind such as `proposal`, and optionally one thing's id. */
  targetKind: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  /** One thing's id: ids and codes only (letters, digits and `_ . : -`), which is all a row's target id can hold; a NUL or other control character is refused. */
  targetId: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/).optional(),
  outcome: AuditOutcome.optional(),
  from: AuditBound.optional(),
  to: AuditBound.optional(),
};

export const ListAuditQuery = z.object({
  ...auditFilter,
  /** The `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(50),
});
export type ListAuditQuery = z.infer<typeof ListAuditQuery>;

export const ListAuditResponse = z.object({
  /** Newest first. */
  entries: z.array(AuditEntry),
  /** Pass back as `cursor` for the next, older page; null on the last page. */
  nextCursor: z.string().nullable(),
});
export type ListAuditResponse = z.infer<typeof ListAuditResponse>;
export const listAuditRoute = { method: 'GET', path: '/api/admin/audit' } as const satisfies ApiRoute;

/**
 * Export the rows that match, as a signed file. `after` continues a file that was cut short by the row cap (the previous file's manifest gives
 * it as `resumeAfter`). The answer is not JSON: the body is the file itself (one JSON object per line) and the signature is in headers.
 */
export const ExportAuditRequest = z.strictObject({ ...auditFilter, after: z.string().min(1).max(200).optional() });
export type ExportAuditRequest = z.infer<typeof ExportAuditRequest>;
export const exportAuditRoute = { method: 'POST', path: '/api/admin/audit/export' } as const satisfies ApiRoute;

/** The first line of an export file: what was asked for and what the file holds. The other lines are `AuditEntry` objects, oldest first. */
export const AuditExportManifest = z.object({
  kind: z.literal('manythreads.audit.export'),
  version: z.literal(1),
  workspaceId: z.uuid(),
  generatedAt: IsoDateTime,
  filters: z.record(z.string(), z.string()),
  rowCount: z.number().int().nonnegative(),
  /** True when the row cap stopped the file short; `resumeAfter` then goes in the next export's `after`. */
  truncated: z.boolean(),
  resumeAfter: z.string().nullable(),
  /** Always true: the file holds no message text, file contents, secrets or memory text. */
  contentBlind: z.literal(true),
  signature: z.object({ algorithm: z.literal('ed25519'), keyId: z.string() }),
});
export type AuditExportManifest = z.infer<typeof AuditExportManifest>;

/** The headers that carry the signature of an export. The signature covers the exact bytes of the body. */
export const AUDIT_SIGNATURE_HEADER = 'x-audit-signature';
export const AUDIT_KEY_ID_HEADER = 'x-audit-key-id';
export const AUDIT_SHA256_HEADER = 'x-audit-sha256';

/** The public key an auditor checks exports with. */
export const AuditSigningKey = z.object({
  keyId: z.string(),
  algorithm: z.literal('ed25519'),
  /** The public key as a PEM block ("-----BEGIN PUBLIC KEY-----"). */
  publicKeyPem: z.string(),
  createdAt: IsoDateTime,
});
export type AuditSigningKey = z.infer<typeof AuditSigningKey>;
export const getAuditSigningKeyRoute = { method: 'GET', path: '/api/admin/audit/signing-key' } as const satisfies ApiRoute;
