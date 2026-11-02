import { describe, expect, it } from 'vitest';
import { TerminalText } from '../src/index.ts';

// The screen model the terminal page draws and the server records (P7-09): text a person would read, not the control codes around it.

const run = (...chunks: string[]): TerminalText => {
  const t = new TerminalText();
  for (const c of chunks) t.feed(c);
  return t;
};

describe('TerminalText', () => {
  it('keeps plain lines and the unfinished one', () => {
    const t = run('one\r\ntwo\r\nthree');
    expect(t.lines).toEqual(['one', 'two']);
    expect(t.current).toBe('three');
  });

  it('drops colours, titles and other codes', () => {
    const t = run('\u001b[1;32mgreen\u001b[0m text\u001b]0;a title\u0007 more\u001b]8;;http://x\u001b\\link\u001b[?2004h\n');
    expect(t.lines).toEqual(['green text morelink']);
  });

  it('holds a code split between chunks until it is complete', () => {
    const t = run('a\u001b', '[3', '1mb\n');
    expect(t.lines).toEqual(['ab']);
  });

  it('a carriage return rewinds the line, so a progress bar leaves its last state', () => {
    const t = run('10%\r50%\r100%\n');
    expect(t.lines).toEqual(['100%']);
  });

  it('a backspace and erase-to-end edit the line the way a shell echo does', () => {
    const t = run('ls -lx\b \b\u001b[K\n');
    expect(t.lines).toEqual(['ls -l']);
    const u = run('abcdef\u001b[3D\u001b[K\n');
    expect(u.lines).toEqual(['abc']);
  });

  it('clear screen empties what is shown', () => {
    const t = run('old\nolder\n\u001b[2J\u001b[Hnew\n');
    expect(t.lines).toEqual(['new']);
  });

  it('removes other control characters and direction overrides', () => {
    const t = run('a\u0000b‮c\u0001d\n');
    expect(t.lines).toEqual(['abcd']);
  });

  it('expands a tab', () => {
    const t = run('a\tb\n');
    expect(t.lines).toEqual(['a       b']);
  });

  it('take hands over finished lines once', () => {
    const t = run('one\ntwo\npart');
    expect(t.take()).toBe('one\ntwo\n');
    expect(t.take()).toBe('');
    t.feed('ial\n');
    expect(t.take()).toBe('partial\n');
  });

  it('takeRest also hands over the unfinished line', () => {
    const t = run('one\nlast');
    expect(t.takeRest()).toBe('one\nlast\n');
    expect(t.takeRest()).toBe('');
  });

  it('keeps only the newest lines and counts the dropped', () => {
    const t = new TerminalText(3);
    t.feed('1\n2\n3\n4\n5\n');
    expect(t.lines).toEqual(['3', '4', '5']);
    expect(t.dropped).toBe(2);
  });

  it('never grows a line without bound', () => {
    const t = run('x'.repeat(10_000));
    expect(t.lines.length).toBeGreaterThan(1);
    expect(t.lines.every((l) => l.length <= 4000)).toBe(true);
  });

  it('an unterminated title does not swallow the rest of the stream forever', () => {
    const t = run('\u001b]0;' + 'x'.repeat(5000) + 'visible\n');
    expect(t.lines.join('')).toContain('visible');
  });
  // Hostile streams (the terminal's output is whatever the shell prints, and a shell is something an admin types into): each of these must finish quickly, on the server's own event loop.
  describe('hostile input finishes quickly', () => {
    const timed = (feed: (t: TerminalText) => void): { ms: number; t: TerminalText } => {
      const t = new TerminalText(1);
      const from = performance.now();
      feed(t);
      t.takeRest();
      return { ms: performance.now() - from, t };
    };

    it('a hundred thousand "insert 200 blanks" codes', () => {
      const { ms, t } = timed((x) => x.feed('\u001b[200@'.repeat(100_000)));
      expect(ms).toBeLessThan(1000);
      expect(t.current.length).toBeLessThanOrEqual(4000);
    });

    it('insert-blanks never grows a line past the cap, and keeps what was before the cursor', () => {
      const t = new TerminalText();
      t.feed('abc\u001b[3D\u001b[200@'.repeat(50) + 'Z\n');
      expect(t.lines[0]?.length ?? 0).toBeLessThanOrEqual(4000);
      expect(t.lines[0]).toContain('Z');
    });

    it('the worst a 64 KiB chunk can do: full lines, each followed by as many line edits as it can hold', () => {
      // a line filled to the brim with one code, then a burst of insert/delete codes, then a newline to start the budget again
      const unit = '\u001b[3990C' + 'x' + '\r' + '\u001b[200@\u001b[2P'.repeat(300) + '\n';
      const chunk = unit.repeat(Math.ceil(65_536 / unit.length));
      const { ms, t } = timed((x) => x.feed(chunk));
      expect(ms).toBeLessThan(500);
      expect(t.dropped + t.lines.length).toBeGreaterThan(0);
    });

    it('lines still get their normal edits (a shell edits a line a few times)', () => {
      const t = new TerminalText();
      t.feed('abcdef\u001b[3D\u001b[2@XY\u001b[2P\n');
      expect(t.lines).toEqual(['abcXYf']);
    });

    it('fifty lines of 3990 blanks and then a letter', () => {
      const line = ' '.repeat(3990) + 'x\n';
      const { ms } = timed((x) => x.feed(line.repeat(50)));
      expect(ms).toBeLessThan(1000);
    });

    it('a blank run of 8 MiB', () => {
      const { ms } = timed((x) => x.feed(' '.repeat(8 * 1024 * 1024)));
      expect(ms).toBeLessThan(1000);
    });

    // Cursor moves must not write out the blanks they skip: each of these is 2 MiB (the limit is one second for every MiB) and used to cost ten seconds for each MiB.
    const MIB2 = 2 * 1024 * 1024;
    const hostile = (unit: string, keep = 1): { ms: number; t: TerminalText } => {
      const reps = Math.ceil(MIB2 / unit.length);
      const t = new TerminalText(keep);
      const chunk = unit.repeat(Math.ceil(65_536 / unit.length));
      const from = performance.now();
      for (let sent = 0; sent < reps; sent += Math.ceil(65_536 / unit.length)) t.feed(chunk);
      t.takeRest();
      return { ms: performance.now() - from, t };
    };

    it('2 MiB of "forward 3999, x"', () => {
      const { ms, t } = hostile('\u001b[3999Cx');
      expect(ms).toBeLessThan(2000);
      expect(t.current.length).toBeLessThanOrEqual(4000);
    });

    it('2 MiB of "column 3999, x"', () => {
      expect(hostile('\u001b[3999Gx').ms).toBeLessThan(2000);
    });

    it('2 MiB of a forward move and a newline, alternating', () => {
      expect(hostile('\u001b[3999C\n').ms).toBeLessThan(2000);
      expect(hostile('\u001b[3999Cx\n').ms).toBeLessThan(2000);
    });

    it('2 MiB of "erase the line, then a letter" under a cursor far to the right', () => {
      const { ms } = hostile('x'.repeat(3990) + '\u001b[2Kx'.repeat(2000) + '\n');
      expect(ms).toBeLessThan(2000);
    });

    it('2 MiB mixing moves with insert, delete and erase', () => {
      expect(hostile('\u001b[3999Cx\u001b[200@\u001b[100P\u001b[50X\u001b[3999G\u001b[9D').ms).toBeLessThan(2000);
      expect(hostile('\u001b[3999C\u001b[200@x\r\u001b[3999Gy\u001b[K\n').ms).toBeLessThan(2000);
    });

    it('a cursor moved far away writes a few blanks, not a screenful', () => {
      const t = new TerminalText();
      t.feed('ab\u001b[3999Cx\n');
      expect(t.lines[0]?.length).toBeLessThanOrEqual(2 + 8 + 1);
      expect(t.lines[0]?.startsWith('ab')).toBe(true);
      expect(t.lines[0]?.endsWith('x')).toBe(true);
    });

    it('moving inside the written text still works', () => {
      const t = new TerminalText();
      t.feed('abcdef\r\u001b[3Cxyz\n');
      expect(t.lines[0]).toBe('abcxyz');
    });

    it('a million newlines on the page (a list of 2000 lines) take well under two seconds', () => {
      const t = new TerminalText(2000);
      const from = performance.now();
      t.feed('\n'.repeat(1_000_000));
      expect(performance.now() - from).toBeLessThan(1500);
      expect(t.lines).toHaveLength(2000);
      expect(t.dropped).toBe(1_000_000 - 2000);
    });

    it('8 MiB of text with a code after every few letters', () => {
      const chunk = 'ab\u001b[1m\u001b[0mcd\r\n'.repeat(64 * 1024);
      const { ms } = timed((x) => {
        for (let i = 0; i < 8; i += 1) x.feed(chunk);
      });
      expect(ms).toBeLessThan(3000);
    });

    it('erase and delete codes with huge numbers', () => {
      const { ms } = timed((x) => x.feed('\u001b[99999999999999999P\u001b[99999999999999999X\u001b[1K'.repeat(100_000)));
      expect(ms).toBeLessThan(1000);
    });
  });
});
