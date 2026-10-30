import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, ExportAuditRequest, ListAuditQuery } from '@manythreads/shared';
import { NO_FILTERS, actionsIn, actionWords, exportFileName, startOfDay, startOfNextDay, targetWords, toExportRequest, toQuery, verifyCommands, type AuditFilters } from '../src/screens/audit/format';

const f = (over: Partial<AuditFilters>): AuditFilters => ({ ...NO_FILTERS, ...over });

describe('audit filters to a request', () => {
  it('sends only what is set, and the range as whole days of the viewer', () => {
    expect(toQuery(NO_FILTERS)).toEqual({});
    const q = toQuery(f({ category: 'approvals', outcome: 'withheld', from: '2026-10-01', to: '2026-10-03' }));
    expect(q).toMatchObject({ category: 'approvals', outcome: 'withheld' });
    const from = new Date(q.from!);
    const to = new Date(q.to!);
    expect(from.getHours()).toBe(0);
    // the last day chosen is included: the bound is the start of the day after
    expect(to.getTime() - from.getTime()).toBeGreaterThanOrEqual(2 * 23 * 3600_000 + 23 * 3600_000);
    expect(to.getTime() - from.getTime()).toBeLessThanOrEqual(3 * 25 * 3600_000);
    expect(ListAuditQuery.safeParse(q).success).toBe(true);
  });

  it('ignores a date that is not a date', () => {
    expect(startOfDay('soon')).toBeUndefined();
    expect(startOfNextDay('')).toBeUndefined();
    expect(toQuery(f({ from: 'x', to: 'y' }))).toEqual({});
  });

  it('keeps a typed year the server cannot take out of the request, and reads a short year as itself', () => {
    expect(startOfDay('0000-05-01')).toBeUndefined();
    expect(startOfDay('275760-01-01')).toBeUndefined();
    expect(startOfNextDay('9999-12-31')).toBeUndefined(); // the day after is year 10000
    expect(startOfDay('0099-05-01')).toMatch(/^0099-/); // not 1999
    expect(toQuery(f({ from: '0000-05-01', to: '9999-12-31' }))).toEqual({});
    const q = toQuery(f({ from: '0100-06-15', to: '9999-06-15' }));
    expect(ListAuditQuery.safeParse(q).success).toBe(true);
    expect(startOfNextDay('2026-02-28')).toBe(new Date(2026, 1, 29).toISOString());
  });

  it('makes an export request without a page marker or a limit, which the export refuses', () => {
    const req = toExportRequest(f({ actor: '0190a000-0000-7000-8000-000000000001', team: '0190a000-0000-7000-8000-000000000002' }));
    expect(req).toEqual({ actor: '0190a000-0000-7000-8000-000000000001', team: '0190a000-0000-7000-8000-000000000002' });
    expect(ExportAuditRequest.safeParse(req).success).toBe(true);
  });
});

describe('audit words', () => {
  it('offers the actions of one group, or all of them', () => {
    expect(actionsIn('').length).toBe(Object.keys(AUDIT_ACTIONS).length);
    expect(actionsIn('approvals').map((a) => a.value).sort()).toEqual(['approval.decided', 'approval.requested', 'approval.resumed']);
  });

  it('describes a row in plain words', () => {
    expect(actionWords({ action: 'proposal.applied' })).toBe('Applied a proposal');
    expect(actionWords({ action: 'something.new' })).toBe('something.new');
    expect(targetWords({ target: { kind: 'proposal', id: 'x', label: 'TEAM.md' } })).toBe('proposal: TEAM.md');
    expect(targetWords({ target: { kind: 'model_alias', id: 'smart', label: null } })).toBe('model alias');
    expect(targetWords({ target: { kind: null, id: null, label: null } })).toBe('—');
  });

  it('names the download after the day and shows the two commands that check it', () => {
    expect(exportFileName(new Date('2026-10-30T08:00:00Z'))).toBe('manythreads-audit-2026-10-30.ndjson');
    const cmds = verifyCommands('a.ndjson');
    expect(cmds[0]).toContain('base64 -d');
    expect(cmds[1]).toContain('-rawin -in a.ndjson');
  });
});
