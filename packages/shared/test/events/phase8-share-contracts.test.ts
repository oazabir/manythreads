import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  ShareApproval,
  ShareDefinition,
  ShareExclusionReason,
  ShareLinkEnd,
  ShareLinkState,
  ShareMode,
  SharePreview,
  ShareRun,
  ShareRunState,
  ShareRunTrigger,
  ShareStatus,
  SHARE_EXCLUSION_WORDS,
  eventRegistry,
  parseEvent,
  shareHeadline,
} from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P8-22 and P8-23 (`pnpm test:events`): the three memory share events (ids, counts and reason codes only: never a path, a title or any text of a concept)
// and the shapes the share routes answer with.

const AT = '2026-11-02T08:00:00.000Z';
const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};
const base = { schemaVersion: 1, workspaceId: uuid(1), teamId: uuid(2), at: AT };
const counts = { matched: 12, included: 4, leftOut: 3, unchanged: 5, retired: 1, redacted: 0 };

describe('the memory share events', () => {
  const events = {
    'memory.share.defined': { type: 'memory.share.defined', ...base, slug: 'release-notes', status: 'active', problem: null, destinations: 2, mode: 'summary', approval: 'review', definedBy: uuid(4) },
    'memory.share.built': {
      type: 'memory.share.built',
      ...base,
      shareId: uuid(5),
      slug: 'release-notes',
      runId: uuid(6),
      trigger: 'manual',
      state: 'awaiting_approval',
      counts,
      withheld: { draft: 2, dlp: 1 },
      destinations: 2,
      approvalId: uuid(7),
      requestedBy: uuid(4),
    },
    'memory.share.settled': { type: 'memory.share.settled', ...base, shareId: uuid(5), slug: 'release-notes', runId: uuid(6), outcome: 'ready', approvalId: uuid(7), decidedBy: uuid(8) },
  } as const;

  it.each(Object.entries(events))('%s is registered at version 1 and round-trips', (type, payload) => {
    expect(Object.keys(eventRegistry[type as keyof typeof eventRegistry])).toEqual(['1']);
    expect(parseEvent(payload)).toEqual(payload);
  });

  it.each([
    ['memory.share.defined', 'status', { status: 'broken' }],
    ['memory.share.defined', 'slug', { slug: 'Not A Slug' }],
    ['memory.share.defined', 'destinations', { destinations: -1 }],
    ['memory.share.built', 'state', { state: 'sent-ish' }],
    ['memory.share.built', 'trigger', { trigger: 'whenever' }],
    ['memory.share.built', 'withheld.draft', { withheld: { draft: 0 } }],
    ['memory.share.settled', 'outcome', { outcome: 'sent' }],
    ['memory.share.settled', 'approvalId', { approvalId: null }],
  ] as const)('%s refuses a bad %s', (type, field, over) => expect(failsAt({ ...events[type], ...over })).toContain(field));

  it('carry ids, short codes and counts only: no name, path, text, title or sentence', () => {
    for (const payload of Object.values(events)) {
      const keys = Object.keys(payload);
      expect(keys.filter((k) => /name|path|text|title|body|content|message|sentence|reason$/i.test(k))).toEqual([]);
    }
  });
});

describe('share shapes', () => {
  it('every value of the database is one the shape knows', () => {
    expect(ShareStatus.options).toEqual(['active', 'invalid', 'removed']);
    expect(ShareMode.options).toEqual(['full', 'summary']);
    expect(ShareApproval.options).toEqual(['review', 'auto']);
    expect(ShareLinkState.options).toEqual(['requested', 'accepted', 'paused', 'revoked']);
    expect(ShareLinkEnd.options).toEqual(['removed', 'by_team']);
    expect(ShareRunTrigger.options).toEqual(['schedule', 'manual']);
    expect(ShareRunState.options).toEqual(['building', 'empty', 'blocked', 'awaiting_approval', 'ready', 'denied', 'expired', 'failed', 'sent']);
  });

  it('every reason a concept can be left out for has words for a person', () => {
    for (const reason of ShareExclusionReason.options) expect(SHARE_EXCLUSION_WORDS[reason].length).toBeGreaterThan(10);
  });

  it('the headline is "Matches N concepts · M left out", singular for one', () => {
    expect(shareHeadline(12, 3)).toBe('Matches 12 concepts · 3 left out');
    expect(shareHeadline(1, 0)).toBe('Matches 1 concept · 0 left out');
  });

  it('a preview and a run round-trip', () => {
    const preview = {
      shareId: uuid(5),
      counts,
      headline: shareHeadline(12, 3),
      included: [{ path: 'memory/decisions/a.md', title: 'A' }],
      excluded: [{ path: 'memory/decisions/b.md', title: 'B', reason: 'draft' }],
      diff: { added: [{ path: 'memory/decisions/a.md', title: 'A' }], changed: [], retired: [], unchanged: 5 },
      destinations: [{ teamId: uuid(9), slug: 'support', name: 'Support', link: 'requested' }],
    };
    expect(SharePreview.parse(preview)).toEqual(preview);
    const run = {
      id: uuid(6),
      shareId: uuid(5),
      teamId: uuid(2),
      trigger: 'manual',
      state: 'awaiting_approval',
      reason: null,
      mode: 'summary',
      period: '2026-11-02',
      digestSha: 'a'.repeat(64),
      bundleBytes: 1200,
      counts,
      included: preview.included,
      excluded: preview.excluded,
      diff: preview.diff,
      destinations: preview.destinations,
      approvalId: uuid(7),
      requestedBy: uuid(4),
      settledBy: null,
      createdAt: AT,
      builtAt: AT,
      settledAt: null,
      sentAt: null,
    };
    expect(ShareRun.parse(run)).toEqual(run);
  });
});

describe('ShareDefinition', () => {
  it('fills in the safe defaults: a summary, by hand, reviewed, the leads approve', () => {
    const def = ShareDefinition.parse({ name: 'Release notes', to: ['support'] });
    expect(def.mode).toBe('summary');
    expect(def.when).toBe('manual');
    expect(def.approval).toBe('review');
    expect(def.approvers).toEqual(['role:lead']);
    expect(def.select).toEqual({ minTrust: 'unverified', skipStale: true });
  });

  it('reads the example of the spec', () => {
    const def = ShareDefinition.parse({
      name: 'Release notes for Support and Marketing',
      to: ['customer-support', 'marketing'],
      select: { paths: ['decisions/', 'playbooks/'], types: ['Decision', 'Playbook', 'Metric'], tags: ['release', 'customer-impact'], minTrust: 'machine-confirmed', skipStale: true },
      mode: 'full',
      when: { cron: '0 8 * * MON' },
      approval: 'review',
      approvers: ['role:lead'],
    });
    expect(def.mode).toBe('full');
  });

  it.each([
    ['an unknown key (a typo must not loosen what is shared)', { name: 'x', to: ['a'], mood: 'full' }],
    ['no destination', { name: 'x', to: [] }],
    ['a destination that is not a slug', { name: 'x', to: ['Support Team'] }],
    ['a path that climbs out of memory', { name: 'x', to: ['a'], select: { paths: ['../secrets/'] } }],
    ['a bad cron', { name: 'x', to: ['a'], when: { cron: 'every day' } }],
    ['an unknown trust', { name: 'x', to: ['a'], select: { minTrust: 'trusted' } }],
    ['an approver that is neither a role nor a person', { name: 'x', to: ['a'], approvers: ['everyone'] }],
    ['an unknown mode', { name: 'x', to: ['a'], mode: 'everything' }],
  ])('refuses %s', (_label, value) => {
    expect(ShareDefinition.safeParse(value).success).toBe(false);
  });
});

describe('the delivery and receiving events (P8-24, P8-25)', () => {
  const events = {
    'memory.share.linked': { type: 'memory.share.linked', ...base, destTeamId: uuid(5), shareId: uuid(6), linkId: uuid(7), from: 'requested', to: 'accepted', endedReason: null, changedBy: uuid(4) },
    'memory.sharing.switched': { type: 'memory.sharing.switched', schemaVersion: 1, workspaceId: uuid(1), enabled: false, changedBy: uuid(4), at: AT },
    'memory.digest.delivered': { type: 'memory.digest.delivered', ...base, destTeamId: uuid(5), shareId: uuid(6), slug: 'release-notes', runId: uuid(8), deliveryId: uuid(9), itemId: uuid(10), files: 3, bytes: 1200 },
    'memory.digest.imported': { type: 'memory.digest.imported', ...base, itemId: uuid(10), fromTeamId: uuid(5), outcome: 'refused', reason: 'unsafe_path', files: 0, bytes: 0 },
  };
  it.each(Object.entries(events))('%s is registered and parses', (type, payload) => {
    expect(eventRegistry).toHaveProperty([type]);
    expect(parseEvent(payload)).toMatchObject({ type });
  });
  it('refuses a reason code that is not one of the known codes, and an unknown key is stripped, never carried', () => {
    expect(failsAt({ ...events['memory.digest.imported'], reason: 'because I said so' })).toContain('reason');
    expect(failsAt({ ...events['memory.share.linked'], to: 'open' })).toContain('to');
    expect(failsAt({ ...events['memory.sharing.switched'], enabled: 'yes' })).toContain('enabled');
    expect(failsAt({ ...events['memory.digest.delivered'], files: -1 })).toContain('files');
  });
});
