import { describe, expect, it } from 'vitest';
import { wordsOf } from '../src/email/dummy.ts';
import { triggerMatches } from '../src/index.ts';

// The pure half of the inbox watch (PLAN P8-30): which mails a bot's `inbox` trigger fires for. No database.

const mail = { folder: 'INBOX', subject: 'Refund for order 1042', from: 'Customer <customer@example.com>' };

describe('triggerMatches', () => {
  it('a trigger with no narrowing fires for any mail in the inbox', () => {
    expect(triggerMatches({ type: 'inbox' }, 'support-mail', mail)).toBe(true);
  });

  it('a trigger that names a connection fires for that connection only', () => {
    expect(triggerMatches({ type: 'inbox', connection: 'support-mail' }, 'support-mail', mail)).toBe(true);
    expect(triggerMatches({ type: 'inbox', connection: 'billing-mail' }, 'support-mail', mail)).toBe(false);
  });

  it('the folder defaults to INBOX and is compared in any case', () => {
    expect(triggerMatches({ type: 'inbox' }, 'c', { ...mail, folder: 'Sent' })).toBe(false);
    expect(triggerMatches({ type: 'inbox', folder: 'sent' }, 'c', { ...mail, folder: 'Sent' })).toBe(true);
    expect(triggerMatches({ type: 'inbox', folder: 'Archive' }, 'c', mail)).toBe(false);
  });

  it('every filter word must appear in the subject or the sender, in any case', () => {
    expect(triggerMatches({ type: 'inbox', filter: 'refund' }, 'c', mail)).toBe(true);
    expect(triggerMatches({ type: 'inbox', filter: 'REFUND example.com' }, 'c', mail)).toBe(true);
    expect(triggerMatches({ type: 'inbox', filter: 'refund invoice' }, 'c', mail)).toBe(false);
    expect(triggerMatches({ type: 'inbox', filter: 'password' }, 'c', mail)).toBe(false);
  });

  it('the filter is plain words, never a pattern: nothing in it, or in a mail, can make the match slow or wrong', () => {
    expect(triggerMatches({ type: 'inbox', filter: '(a+)+$' }, 'c', { ...mail, subject: `${'a'.repeat(50_000)}!` })).toBe(false);
    expect(triggerMatches({ type: 'inbox', filter: '.*' }, 'c', mail)).toBe(false);
  });
});

describe('wordsOf', () => {
  it('splits on white space, lower-cases, and drops the empty', () => {
    expect(wordsOf('  Refund   ORDER\t1042\n')).toEqual(['refund', 'order', '1042']);
    expect(wordsOf(undefined)).toEqual([]);
    expect(wordsOf('')).toEqual([]);
  });

  it('keeps at most eight words of at most sixty characters', () => {
    expect(wordsOf('a b c d e f g h i j')).toHaveLength(8);
    expect(wordsOf('x'.repeat(500))[0]).toHaveLength(60);
  });
});
