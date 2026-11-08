import { describe, expect, it } from 'vitest';
import { comparableText, stripHostileText } from '../src/limits.ts';
import { renderTranscriptMarkdown, slugOf, type TranscriptHeader } from '../src/writer.ts';

// What a device or a speech engine sends is hostile input (P15-16): the strip and the compare run in time proportional to the text, and what is written to a file cannot become
// markup.

const time = (fn: () => void): number => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

describe('the text functions are linear', () => {
  const nasty = [
    'a'.repeat(200_000),
    ' \t'.repeat(100_000) + 'x',
    '‮'.repeat(100_000),
    ('a' + '\u0000').repeat(60_000),
    'é'.repeat(100_000),
    '\ud800'.repeat(100_000),
    ('word ' + '‍').repeat(40_000),
    '((((((((((((((((((((((((((((((((((((((((!'.repeat(5_000),
  ];
  it('strip and compare finish a 200 000 character line well inside a second, whatever it holds', () => {
    for (const text of nasty) {
      expect(time(() => stripHostileText(text)), 'strip').toBeLessThan(1_000);
      expect(time(() => comparableText(text)), 'compare').toBeLessThan(1_000);
    }
  });
  it('twice the text takes about twice the time, not four times', () => {
    const one = 'ab ‮ c\u0007 '.repeat(50_000);
    const two = one + one;
    stripHostileText(one); // warm up
    const t1 = Math.max(time(() => stripHostileText(one)), 1);
    const t2 = time(() => stripHostileText(two));
    expect(t2).toBeLessThan(t1 * 8 + 50);
  });
  it('the markdown writer is linear too, and keeps to its size', () => {
    const header: TranscriptHeader = { title: 'T', startedAt: new Date(0), endedAt: new Date(60_000), channelLabel: '#dev', participants: ['A'], language: null, source: 'on-device' };
    const lines = Array.from({ length: 20_000 }, (_, i) => ({ segmentId: null, speakerId: '00000000-0000-4000-8000-000000000001' as never, speakerName: 'A', startMs: i * 1000, endMs: i * 1000 + 500, text: '*_`[<'.repeat(40), transcribed: true, editable: false }));
    let out = { markdown: '', lineCount: 0, truncated: false };
    expect(time(() => (out = renderTranscriptMarkdown(header, lines, 500_000)))).toBeLessThan(2_000);
    expect(Buffer.byteLength(out.markdown)).toBeLessThanOrEqual(500_000);
    expect(out.truncated).toBe(true);
    expect(out.markdown).toContain('longer than a file can hold');
    expect(out.lineCount).toBeLessThan(20_000);
  });
});

describe('stripHostileText', () => {
  it('removes control characters, bidirectional overrides and isolates, and lone surrogates', () => {
    expect(stripHostileText('he\u0000llo\u001b[31m ‮wor⁦ld⁩‬\u007f\u0085!')).toBe('hello[31m world !');
    expect(stripHostileText('a\ud800b')).toBe('ab');
  });
  it('turns breaks and tabs into one space and trims the ends', () => {
    expect(stripHostileText('  one\r\ntwo\t\tthree\u2028four   ')).toBe('one two three four');
    expect(stripHostileText('\n\n')).toBe('');
  });
  it('keeps the joiners that Bangla, Arabic and emoji need, and ordinary text as it is', () => {
    expect(stripHostileText('ক্‌ষ ‍‌')).toBe('ক্‌ষ ‍‌');
    expect(stripHostileText('مرحبا بالعالم')).toBe('مرحبا بالعالم');
    expect(stripHostileText('👩‍💻 ok')).toBe('👩‍💻 ok');
  });
});

describe('comparableText', () => {
  it('folds case, width, punctuation and spacing so two devices hearing the same words compare equal', () => {
    expect(comparableText('Hello,   WORLD!')).toBe(comparableText('hello world'));
    expect(comparableText('ＡＢＣ 123')).toBe('abc 123');
    expect(comparableText('...')).toBe('');
  });
});

describe('what reaches the file', () => {
  const header: TranscriptHeader = { title: '# Sprint <b>review</b>', startedAt: new Date('2026-11-08T14:02:00Z'), endedAt: new Date('2026-11-08T14:32:00Z'), channelLabel: '#dev', participants: ['Nadia "N" Rahman', 'Rafi'], language: 'en', source: 'mixed' };
  const line = (name: string, text: string, transcribed = true) => ({ segmentId: null, speakerId: '00000000-0000-4000-8000-000000000001' as never, speakerName: name, startMs: 65_000, endMs: 66_000, text, transcribed, editable: false });
  it('quotes the front matter and escapes markup in names and words', () => {
    const out = renderTranscriptMarkdown(header, [line('Na*dia', '# not a heading <script>alert(1)</script> [link](http://x) `code` *bold*')], 100_000).markdown;
    expect(out.startsWith('---\ntype: "Meeting Transcript"\n')).toBe(true);
    expect(out).toContain('title: "# Sprint <b>review</b>"');
    expect(out).toContain('participants: ["Nadia \\"N\\" Rahman", "Rafi"]');
    expect(out).toContain('source: mixed');
    expect(out).toContain('# \\# Sprint \\<b\\>review\\</b\\>');
    expect(out).toContain('[00:01:05] **Na\\*dia:** \\# not a heading \\<script\\>alert(1)\\</script\\> \\[link\\](http://x) \\`code\\` \\*bold\\*');
    expect(out).not.toMatch(/^# not a heading/m);
  });
  it('writes a silent speaker as one plain line without words', () => {
    const out = renderTranscriptMarkdown(header, [line('Rafi', 'Rafi spoke (not transcribed)', false)], 100_000).markdown;
    expect(out).toContain('[00:01:05] *Rafi spoke (not transcribed)*');
  });
  it('makes a folder-safe name from any title', () => {
    expect(slugOf('Sprint review: Q4!')).toBe('sprint-review-q4');
    expect(slugOf('  ')).toBe('meeting');
    expect(slugOf('../../etc/passwd')).toBe('etc-passwd');
    expect(slugOf('x'.repeat(100)).length).toBe(40);
    expect(slugOf('مرحبا')).toBe('meeting');
  });
});
