import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { AUDIT_ACTIONS, AuditEntry, AuditExportManifest, ExportAuditRequest, ListAuditQuery, auditActionLabel, eventRegistry, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P10-05 (`pnpm test:events`): the one event the export writes, and the shapes of the audit console's rows and requests.

const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('audit.export.created', () => {
  const valid = {
    type: 'audit.export.created',
    schemaVersion: 1,
    workspaceId: uuid(1),
    exportedBy: uuid(2),
    rowCount: 120,
    truncated: false,
    from: null,
    to: '2026-10-30T08:00:00.000Z',
    keyId: 'abcdef0123456789',
    exportedAt: '2026-10-30T08:00:00.000Z',
  };

  it('is registered at version 1 and round-trips', () => {
    expect(Object.keys(eventRegistry['audit.export.created'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
  });

  it.each([
    ['rowCount', { rowCount: -1 }],
    ['truncated', { truncated: 'yes' }],
    ['keyId', { keyId: '' }],
    ['exportedBy', { exportedBy: 'omar' }],
    ['to', { to: 'tomorrow' }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});

describe('AuditEntry', () => {
  const entry = {
    id: uuid(1),
    occurredAt: '2026-10-30T08:00:00.000Z',
    actor: { id: uuid(2), kind: 'person', name: 'Omar' },
    category: 'content',
    action: 'proposal.applied',
    target: { kind: 'proposal', id: uuid(3), label: 'TEAM.md' },
    team: { id: uuid(4), name: 'Engineering' },
    outcome: 'ok',
    reason: null,
    source: 'event',
  };

  it('parses a row, and refuses an action or outcome it does not know', () => {
    expect(AuditEntry.parse(entry)).toEqual(entry);
    expect(AuditEntry.safeParse({ ...entry, outcome: 'maybe' }).success).toBe(false);
    expect(AuditEntry.safeParse({ ...entry, action: 'Not An Action' }).success).toBe(false);
    expect(AuditEntry.safeParse({ ...entry, category: 'everything' }).success).toBe(false);
  });

  it('lists every action once, in a group the filter bar knows, with plain words', () => {
    for (const [action, { category, label }] of Object.entries(AUDIT_ACTIONS)) {
      expect(AuditEntry.safeParse({ ...entry, action, category }).success, action).toBe(true);
      expect(label.length, action).toBeGreaterThan(3);
      expect(auditActionLabel(action)).toBe(label);
    }
    expect(auditActionLabel('some.future_action')).toBe('some.future_action');
  });
});

describe('requests', () => {
  it('ListAuditQuery turns the limit into a number and keeps it in range', () => {
    expect(ListAuditQuery.parse({}).limit).toBe(50);
    expect(ListAuditQuery.parse({ limit: '200' }).limit).toBe(200);
    expect(ListAuditQuery.safeParse({ limit: '201' }).success).toBe(false);
    expect(ListAuditQuery.safeParse({ outcome: 'withheld', actor: uuid(1) }).success).toBe(true);
    expect(ListAuditQuery.safeParse({ outcome: 'lost' }).success).toBe(false);
  });

  it('ExportAuditRequest refuses a field it does not know', () => {
    expect(ExportAuditRequest.safeParse({ category: 'approvals', after: 'abc' }).success).toBe(true);
    expect(ExportAuditRequest.safeParse({ everything: true }).success).toBe(false);
  });

  it('AuditExportManifest says the file is content-blind', () => {
    const manifest = {
      kind: 'manythreads.audit.export',
      version: 1,
      workspaceId: uuid(1),
      generatedAt: '2026-10-30T08:00:00.000Z',
      filters: {},
      rowCount: 0,
      truncated: false,
      resumeAfter: null,
      contentBlind: true,
      signature: { algorithm: 'ed25519', keyId: 'abcdef0123456789' },
    };
    expect(AuditExportManifest.parse(manifest)).toEqual(manifest);
    expect(AuditExportManifest.safeParse({ ...manifest, contentBlind: false }).success).toBe(false);
  });
});
