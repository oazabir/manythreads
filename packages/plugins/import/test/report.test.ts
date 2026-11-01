import { IMPORT_SKIP_REASONS } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { Tally, buildReport } from '../src/report.ts';

// The sentences of the report, read by a person: a count of one takes the singular noun and verb, any other count the plural. No database.

/** A tally where every count is `n`. */
function tallyOf(n: number): Tally {
  const t = new Tally();
  t.people = { total: n, matched: n, placeholders: n, withoutEmail: n, matchedNotOnTeam: n };
  t.channels = { total: n, public: n, private: n, direct: n, imported: n, skipped: n };
  t.messages = { total: n, imported: n, alreadyImported: n, threads: n, replies: n, reactions: n, mentions: n };
  t.files = { total: n, inArchive: n, notInArchive: n };
  for (const r of IMPORT_SKIP_REASONS) t.skip(r, n);
  return t;
}
const text = (n: number, mode: 'dry' | 'final'): string => buildReport(tallyOf(n), mode).lines.join('\n');

describe('the report grammar', () => {
  // a count of one followed by a plural noun or a plural verb, and a larger count followed by a singular noun or verb
  const ONE_WRONG = [
    /\b1 (?:person|file|message|channel|reaction|mention|reply|matched person) (?:have|are|were|come|start)\b/,
    /\b1 (?:messages|people|channels|files|reactions|mentions|replies|huddles|lines|entries)\b/,
  ];
  const MANY_WRONG = [/\b(?:[02-9]|\d{2,}) (?:person|message|channel|file|reaction|mention|reply|huddle) /, /\b[2-9] (?:has|is|was|comes|starts)\b/];

  for (const mode of ['dry', 'final'] as const) {
    it(`says one of everything in the singular (${mode})`, () => {
      const t = text(1, mode);
      for (const w of ONE_WRONG) expect(t).not.toMatch(w);
      expect(t).toMatch(mode === 'dry' ? /1 person has an account here/ : /1 person had an account here/);
      expect(t).toMatch(mode === 'dry' ? /1 file is named/ : /1 file was named/);
      expect(t).toMatch(/1 starts a thread/);
      expect(t).toMatch(mode === 'dry' ? /1 matched person is not on the chosen team/ : /1 matched person was not on the chosen team/);
      expect(t).toMatch(mode === 'dry' ? /1 reaction comes along/ : /1 reaction came along/);
      expect(t).toMatch(mode === 'dry' ? /1 huddle will be left out or changed/ : /1 huddle was left out or changed/);
      expect(t).toMatch(/1 reply whose first message is not in the archive/);
      expect(t).toMatch(/1 with its bytes/);
      if (mode === 'final') expect(t).toMatch(/1 message came in on an earlier run of this archive and was not written twice/);
    });

    it(`says two of everything in the plural (${mode})`, () => {
      const t = text(2, mode);
      for (const w of MANY_WRONG) expect(t).not.toMatch(w);
      expect(t).toMatch(mode === 'dry' ? /2 people have an account here/ : /2 people had an account here/);
      expect(t).toMatch(mode === 'dry' ? /2 files are named/ : /2 files were named/);
      expect(t).toMatch(/2 start a thread/);
      expect(t).toMatch(mode === 'dry' ? /2 matched people are not on the chosen team/ : /2 matched people were not on the chosen team/);
      expect(t).toMatch(mode === 'dry' ? /2 huddles will be left out or changed/ : /2 huddles were left out or changed/);
      expect(t).toMatch(/2 with their bytes/);
      if (mode === 'final') expect(t).toMatch(/2 messages came in on an earlier run of this archive and were not written twice/);
    });
  }

  it('keeps every sentence under the length the report allows', () => {
    for (const n of [0, 1, 2, 1_234_567]) for (const mode of ['dry', 'final'] as const) for (const line of buildReport(tallyOf(n), mode).lines) expect(line.length).toBeLessThanOrEqual(300);
  });
});
