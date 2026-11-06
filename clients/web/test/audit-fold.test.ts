import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '@manythreads/shared';
import { FOLD_WINDOW_MS, foldAudit, foldLabel, foldTarget, topActors } from '../src/screens/audit/format';

const OMAR = '11111111-1111-4111-8111-111111111111';
const NADIA = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-11-05T12:00:00.000Z');

let n = 0;
function row(over: { actor?: string; name?: string; kind?: 'person' | 'bot' | 'system'; action?: string; outcome?: AuditEntry['outcome']; minutesAgo: number; target?: string | null }): AuditEntry {
  n += 1;
  return {
    id: `e${n}` as AuditEntry['id'],
    occurredAt: new Date(T0 - over.minutesAgo * 60_000).toISOString() as AuditEntry['occurredAt'],
    actor: { id: over.kind === 'system' ? null : (over.actor ?? OMAR), kind: over.kind ?? 'person', name: over.name ?? 'Omar' },
    category: 'sign_in',
    action: over.action ?? 'sign_in.succeeded',
    target: { kind: over.target === null ? null : 'person', id: null, label: over.target ?? null },
    team: null,
    outcome: over.outcome ?? 'ok',
    reason: null,
    source: 'event',
  };
}

describe('folding repeated audit rows', () => {
  it('folds neighbours with the same actor, action and outcome within ten minutes, newest first', () => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((m) => row({ minutesAgo: m }));
    const groups = foldAudit(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(7);
    expect(groups[0]!.key).toBe(rows[0]!.id);
    expect(foldLabel(groups[0]!)).toBe('Omar signed in ×7');
  });

  it('measures the gap between neighbours, so a long steady run is one group, and a gap over ten minutes splits it', () => {
    const steady = foldAudit([0, 9, 18, 27].map((m) => row({ minutesAgo: m })));
    expect(steady).toHaveLength(1);
    const split = foldAudit([0, 5, 16, 20].map((m) => row({ minutesAgo: m })));
    expect(split.map((g) => g.rows.length)).toEqual([2, 2]);
    expect(FOLD_WINDOW_MS).toBe(10 * 60_000);
  });

  it('keeps rows apart when the actor, the action or the outcome differs, and only folds neighbours', () => {
    const rows = [
      row({ minutesAgo: 0 }),
      row({ minutesAgo: 1, actor: NADIA, name: 'Nadia' }),
      row({ minutesAgo: 2 }),
      row({ minutesAgo: 3, action: 'sign_in.signed_out' }),
      row({ minutesAgo: 4, outcome: 'failed' }),
    ];
    expect(foldAudit(rows).map((g) => g.rows.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it('tells apart two unknown actors by name, and folds a failed sign-in of the same name', () => {
    const a = (m: number, name: string) => row({ minutesAgo: m, kind: 'system', name, action: 'sign_in.failed', outcome: 'failed' });
    expect(foldAudit([a(0, 'x@y.z'), a(1, 'x@y.z'), a(2, 'q@y.z')]).map((g) => g.rows.length)).toEqual([2, 1]);
  });

  it('names the target only when the rows agree, and leaves one row as a plain sentence', () => {
    const same = foldAudit([row({ minutesAgo: 0, target: 'Rafi' }), row({ minutesAgo: 1, target: 'Rafi' })])[0]!;
    expect(foldTarget(same)).toBe('person: Rafi');
    const mixed = foldAudit([row({ minutesAgo: 0, target: 'Rafi' }), row({ minutesAgo: 1, target: 'Nadia' })])[0]!;
    expect(foldTarget(mixed)).toBe('2 different things');
    expect(foldLabel(foldAudit([row({ minutesAgo: 0 })])[0]!)).toBe('Omar signed in');
    expect(foldLabel(foldAudit([row({ minutesAgo: 0, action: 'sign_in.single_sign_on' }), row({ minutesAgo: 1, action: 'sign_in.single_sign_on' })])[0]!)).toBe('Omar signed in with single sign-on ×2');
  });

  it('is empty for no rows and never reorders', () => {
    expect(foldAudit([])).toEqual([]);
    const rows = [row({ minutesAgo: 0 }), row({ minutesAgo: 30 }), row({ minutesAgo: 31 })];
    expect(foldAudit(rows).flatMap((g) => g.rows.map((r) => r.id))).toEqual(rows.map((r) => r.id));
  });
});

describe('the Who chips', () => {
  it('lists the people who appear most, at most five, and leaves out bots and the system', () => {
    const ids = Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const rows = [
      ...ids.map((id, i) => row({ minutesAgo: i, actor: id, name: `P${i}` })),
      row({ minutesAgo: 9, actor: ids[3]!, name: 'P3' }),
      row({ minutesAgo: 9, actor: ids[3]!, name: 'P3' }),
      row({ minutesAgo: 9, actor: ids[5]!, name: 'P5' }),
      row({ minutesAgo: 9, kind: 'bot', actor: '33333333-3333-4333-8333-333333333333', name: 'Brain' }),
      row({ minutesAgo: 9, kind: 'system', name: 'system' }),
    ];
    const top = topActors(rows);
    expect(top).toHaveLength(5);
    expect(top.map((c) => c.name).slice(0, 2)).toEqual(['P3', 'P5']);
    expect(top.map((c) => c.name)).not.toContain('Brain');
    expect(topActors(rows, 2)).toHaveLength(2);
  });
});
