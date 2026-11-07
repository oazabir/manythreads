import { describe, expect, it } from 'vitest';
import { EMPTY_ACTION_ITEMS_FILE, actionLine, applyActionItemOp, parseActionItemsFile, reviewActionItemsRewrite } from '../../src/okf/action-items-file.ts';

const FILE = `# Action items

Kept up to date by my routine.

- [ ] Send the revised quote to Acme (owner: Nadia; due: 2026-11-20)
  - source: mail "Quote for Acme", 3 Nov
- [x] Reply to Rafi about the release
  - source: thread in #eng
  - why: 6 Nov: marked done because the reply was sent in the thread
  - card: 0192f0c4-1111-7000-8000-000000000001
- [ ] Book the room
`;

describe('reading the file', () => {
  it('reads the actions with their sources, reasons and card, and skips the rest', () => {
    const items = parseActionItemsFile(FILE);
    expect(items.map((i) => [i.what, i.owner, i.due, i.done])).toEqual([
      ['Send the revised quote to Acme', 'Nadia', '2026-11-20', false],
      ['Reply to Rafi about the release', null, null, true],
      ['Book the room', null, null, false],
    ]);
    expect(items[0]?.source).toBe('mail "Quote for Acme", 3 Nov');
    expect(items[1]?.why).toEqual(['6 Nov: marked done because the reply was sent in the thread']);
    expect(items[1]?.cardTaskId).toBe('0192f0c4-1111-7000-8000-000000000001');
    expect(items.every((i) => /^[0-9a-f]{8}$/.test(i.id))).toBe(true);
  });

  it('gives a repeated action its own id', () => {
    const items = parseActionItemsFile('- [ ] Call Sam\n- [ ] Call Sam\n');
    expect(items[0]?.id).not.toBe(items[1]?.id);
    expect(items[1]?.id).toMatch(/-2$/);
  });

  it('handles an empty or odd file without throwing', () => {
    expect(parseActionItemsFile('')).toEqual([]);
    expect(parseActionItemsFile('no list here\n  - source: stray\n')).toEqual([]);
  });
});

describe('a person changing the list', () => {
  const NOW = new Date('2026-11-07T10:00:00Z');
  const id = (what: string): string => parseActionItemsFile(FILE).find((i) => i.what === what)!.id;

  it('ticks an action and writes why, leaving the rest of the file alone', () => {
    const res = applyActionItemOp(FILE, { op: 'tick', id: id('Book the room'), done: true }, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('- [x] Book the room\n  - why: 7 Nov: ticked by you\n');
    expect(res.text.startsWith('# Action items\n\nKept up to date by my routine.\n')).toBe(true);
    expect(res.text.replace('- [x] Book the room\n  - why: 7 Nov: ticked by you\n', '- [ ] Book the room\n')).toBe(FILE);
  });

  it('opens an action again and keeps the earlier reasons', () => {
    const res = applyActionItemOp(FILE, { op: 'tick', id: id('Reply to Rafi about the release'), done: false }, NOW);
    if (!res.ok) throw new Error('expected ok');
    const item = parseActionItemsFile(res.text).find((i) => i.what.startsWith('Reply'))!;
    expect(item.done).toBe(false);
    expect(item.why).toHaveLength(2);
  });

  it('edits the words, owner and due date', () => {
    const res = applyActionItemOp(FILE, { op: 'edit', id: id('Book the room'), what: 'Book the big room', owner: 'Rafi', due: '2026-12-01' }, NOW);
    if (!res.ok) throw new Error('expected ok');
    expect(res.text).toContain('- [ ] Book the big room (owner: Rafi; due: 2026-12-01)');
    expect(parseActionItemsFile(res.text).find((i) => i.id === res.id)?.what).toBe('Book the big room');
  });

  it('adds an action after the last one, and starts a file when there is none', () => {
    const res = applyActionItemOp(FILE, { op: 'add', what: 'Pay the invoice', owner: 'Nadia', due: '2026-11-30', source: 'my own list' }, NOW);
    if (!res.ok) throw new Error('expected ok');
    const items = parseActionItemsFile(res.text);
    expect(items.at(-1)).toMatchObject({ what: 'Pay the invoice', owner: 'Nadia', due: '2026-11-30', source: 'my own list' });
    const fresh = applyActionItemOp(EMPTY_ACTION_ITEMS_FILE, { op: 'add', what: 'First thing' }, NOW);
    if (!fresh.ok) throw new Error('expected ok');
    expect(fresh.text).toBe('# Action items\n\n- [ ] First thing\n  - why: 7 Nov: added by you\n');
  });

  it('records the card of an action', () => {
    const res = applyActionItemOp(FILE, { op: 'card', id: id('Book the room'), taskId: '0192f0c4-2222-7000-8000-000000000002' }, NOW);
    if (!res.ok) throw new Error('expected ok');
    expect(parseActionItemsFile(res.text).find((i) => i.what === 'Book the room')?.cardTaskId).toBe('0192f0c4-2222-7000-8000-000000000002');
  });

  it('refuses an action that is gone and empty words', () => {
    expect(applyActionItemOp(FILE, { op: 'tick', id: 'deadbeef', done: true }, NOW)).toMatchObject({ ok: false, code: 'not_found' });
    expect(applyActionItemOp(FILE, { op: 'add', what: '   ' }, NOW)).toMatchObject({ ok: false, code: 'empty' });
    expect(applyActionItemOp(FILE, { op: 'edit', id: id('Book the room'), what: ' ' }, NOW)).toMatchObject({ ok: false, code: 'empty' });
  });

  it('writes the line form the inbox reads, and keeps hostile words on one line', () => {
    expect(actionLine({ what: 'A (owner: x)\nB', owner: 'Nadia; (Q)', due: null, done: false })).toBe('- [ ] A [owner: x) B (owner: Nadia   Q)');
  });
});

describe('a rewrite of the whole file by the routine', () => {
  it('lets new actions in and a done mark with a reason', () => {
    const next = FILE.replace('- [ ] Book the room\n', '- [x] Book the room\n  - why: 7 Nov: the room card moved to Done\n') + '- [ ] New one from mail\n';
    expect(reviewActionItemsRewrite(FILE, next)).toEqual([]);
  });

  it('refuses a removed action, a done mark without a reason and an action opened again', () => {
    const removed = FILE.replace(/- \[ \] Book the room\n/, '');
    expect(reviewActionItemsRewrite(FILE, removed)[0]).toMatch(/never deleted/);
    const noReason = FILE.replace('- [ ] Book the room\n', '- [x] Book the room\n');
    expect(reviewActionItemsRewrite(FILE, noReason)[0]).toMatch(/without saying why/);
    const reopened = FILE.replace('- [x] Reply to Rafi', '- [ ] Reply to Rafi');
    expect(reviewActionItemsRewrite(FILE, reopened)[0]).toMatch(/opened again/);
  });

  it('counts a repeated action twice', () => {
    const two = '- [ ] Call Sam\n- [ ] Call Sam\n';
    expect(reviewActionItemsRewrite(two, '- [ ] Call Sam\n')).toHaveLength(1);
    expect(reviewActionItemsRewrite(two, two)).toEqual([]);
  });
});
