import { describe, expect, it } from 'vitest';
import { TeamTemplate } from '../src/index.ts';

const ok = {
  id: 'engineering',
  name: 'Engineering',
  description: 'Ship software.',
  version: 1,
  channels: [{ name: '#general', purpose: 'Everyone.' }, { name: '#secret', private: true, purpose: 'Leads.' }],
  board: { name: 'Board', columns: ['Open', 'Done'] },
  bots: [{ slug: 'brain', name: 'Brain', role: 'Memory.' }],
  roleTags: ['role:on-call'],
  teamMd: '# Engineering\n',
};

describe('TeamTemplate', () => {
  it('round-trips a valid template', () => {
    expect(TeamTemplate.parse(ok)).toEqual(ok);
  });

  it('rejects unknown keys at every level (strict)', () => {
    expect(TeamTemplate.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, board: { ...ok.board, extra: 1 } }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, channels: [{ name: '#a', purpose: 'p', extra: 1 }] }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, bots: [{ ...ok.bots[0], extra: 1 }] }).success).toBe(false);
  });

  it('requires Brain', () => {
    expect(TeamTemplate.safeParse({ ...ok, bots: [{ slug: 'coder', name: 'Coder', role: 'r' }] }).success).toBe(false);
  });

  it('rejects malformed channel names, role tags, duplicates and bad versions', () => {
    expect(TeamTemplate.safeParse({ ...ok, channels: [{ name: 'general', purpose: 'p' }] }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, channels: [{ name: '#General', purpose: 'p' }] }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, roleTags: ['on-call'] }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, channels: [ok.channels[0], ok.channels[0]] }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, version: 0 }).success).toBe(false);
  });
});
