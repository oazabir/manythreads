import { UNSAFE_CHARS } from './clean.ts';

/**
 * What a terminal's output looks like as plain lines of text (PLAN P7-09). A shell writes a stream with control codes in it: colours, cursor moves, "erase to the end of the line", a
 * carriage return that rewinds to the start of the line. This keeps only the text a person would read on the screen: colours and titles are dropped, a carriage return or a backspace
 * overwrites what is under the cursor, "erase line" cuts the line, "clear screen" empties it. It is NOT a full terminal (no full-screen programs, no colour, no cursor addressing beyond
 * the current line): the page shows a shell's lines, and the server records the same lines. The same code runs in both places, so the record is what the page showed.
 *
 * `feed` takes the stream in any chunking (a code split between two chunks is held until it is complete). `take()` hands back the lines finished since the last call, for the recorder;
 * `lines` and `current` are what the page draws.
 */
/** A cell that `\s` would match, decided without a regular expression for the common cases. */
function isBlank(ch: string): boolean {
  if (ch === ' ') return true;
  if (ch > ' ' && ch < '\u007f') return false;
  return /\s/.test(ch);
}

/** A line is never longer than this many cells (a longer one is cut into lines). */
const LINE_CELLS = 4000;
/** Edits that move or rewrite the cells of a line (insert, delete, erase some) allowed per line: a shell edits a line a few times; a hostile stream asking for thousands per line is ignored past this. */
const EDITS_PER_LINE = 128;
const BLANKS: string[] = Array.from({ length: 200 }, () => ' ');
/** How far past the last written cell the cursor may be moved by "forward" / "column" codes. Blank cells between the text and the cursor are written out when the next character arrives, so an unbounded move would turn 8 bytes into a 4000 character line. */
const REACH = 8;

export class TerminalText {
  /** Finished lines, oldest first; trimmed to `keepLines` when read, and in big steps when written (removing one line from the front of a long list on every newline is slow). */
  private kept: string[] = [];
  private trimmed = 0;
  /** The line being written, where the cursor is. */
  private cells: string[] = [];
  private cursor = 0;
  private fresh: string[] = [];
  private mode: 'text' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'skip1' = 'text';
  private param = '';
  private oscLength = 0;
  private edits = 0;

  constructor(private readonly keepLines = 2000) {}

  /** Finished lines still kept for drawing (the oldest are dropped past `keepLines`). */
  get lines(): string[] {
    this.trim();
    return this.kept;
  }

  /** How many finished lines were dropped from `lines` to stay within `keepLines`. */
  get dropped(): number {
    this.trim();
    return this.trimmed;
  }

  private trim(): void {
    if (this.kept.length <= this.keepLines) return;
    const extra = this.kept.length - this.keepLines;
    this.kept.splice(0, extra);
    this.trimmed += extra;
  }

  /** The line being written, as text (trailing blanks cut with one backward pass: a regular expression for this is slow on a line of blanks followed by a letter). */
  get current(): string {
    let end = this.cells.length;
    while (end > 0 && isBlank(this.cells[end - 1] as string)) end -= 1;
    return end === this.cells.length ? this.cells.join('') : this.cells.slice(0, end).join('');
  }

  feed(chunk: string): void {
    for (const ch of chunk) this.step(ch);
  }

  /** The lines that finished since the last call, each ending in a newline. */
  take(): string {
    if (this.fresh.length === 0) return '';
    const out = this.fresh.join('');
    this.fresh = [];
    return out;
  }

  /** What is on the current line, for the end of a session (the shell ended mid-line). */
  takeRest(): string {
    const rest = this.take();
    const line = this.current;
    this.cells = [];
    this.cursor = 0;
    return line === '' ? rest : `${rest}${line}\n`;
  }

  clear(): void {
    this.kept = [];
    this.cells = [];
    this.cursor = 0;
    this.edits = 0;
  }

  /** Counts one bulk edit of the current line; false when the line already had its share. */
  private spend(): boolean {
    this.edits += 1;
    return this.edits <= EDITS_PER_LINE;
  }

  private newline(): void {
    const line = this.current;
    this.cells = [];
    this.cursor = 0;
    this.edits = 0;
    this.kept.push(line);
    this.fresh.push(`${line}\n`);
    // trimmed in steps: at most twice the wanted number of lines is held, and the list is cut back to the wanted number when it is read
    if (this.kept.length > this.keepLines * 2 + 16) this.trim();
  }

  /** Keeps the cursor within `REACH` cells of the end of the written text (a line erased under a cursor far to the right would otherwise make the next character write thousands of blanks). */
  private reach(): void {
    if (this.cursor > this.cells.length + REACH) this.cursor = this.cells.length + REACH;
  }

  private put(ch: string): void {
    this.reach();
    if (this.cursor < this.cells.length) this.cells[this.cursor] = ch;
    else {
      while (this.cells.length < this.cursor) this.cells.push(' ');
      this.cells.push(ch);
    }
    this.cursor += 1;
    // a line longer than any screen is cut here rather than grown without bound
    if (this.cells.length >= LINE_CELLS) this.newline();
  }

  private step(ch: string): void {
    switch (this.mode) {
      case 'esc':
        if (ch === '[') {
          this.mode = 'csi';
          this.param = '';
        } else if (ch === ']') {
          this.mode = 'osc';
          this.oscLength = 0;
        } else if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#') this.mode = 'skip1';
        else this.mode = 'text';
        return;
      case 'skip1':
        this.mode = 'text';
        return;
      case 'csi':
        // parameter and intermediate bytes, then one final byte
        if ((ch >= '0' && ch <= '?') || ch === ' ' || ch === '!' || ch === '"' || ch === '#' || ch === '$' || ch === '%' || ch === '&' || ch === "'" || ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === ',' || ch === '-' || ch === '.' || ch === '/') {
          if (this.param.length < 32) this.param += ch;
          return;
        }
        this.mode = 'text';
        this.csi(ch, this.param);
        return;
      case 'osc':
        // a title or a link: ends with BEL or ESC \ ; a runaway one is dropped after a while
        this.oscLength += 1;
        if (ch === '\u0007') this.mode = 'text';
        else if (ch === '\u001b') this.mode = 'osc-esc';
        else if (this.oscLength > 2048) this.mode = 'text';
        return;
      case 'osc-esc':
        this.mode = ch === '\\' ? 'text' : 'osc';
        return;
      case 'text':
        break;
    }
    if (ch === '\u001b') {
      this.mode = 'esc';
      return;
    }
    if (ch === '\r') {
      // a carriage return then text overwrites the line (a progress bar); a carriage return then a newline is just a newline
      this.cursor = 0;
      return;
    }
    if (ch === '\n') {
      this.newline();
      return;
    }
    if (ch === '\b' || ch === '\u007f') {
      if (this.cursor > 0) this.cursor -= 1;
      return;
    }
    if (ch === '\t') {
      const stop = 8 - (this.cursor % 8);
      for (let i = 0; i < stop; i += 1) this.put(' ');
      return;
    }
    if (ch === '\u0007') return;
    if ((ch >= ' ' && ch < '\u007f') || ch.replace(UNSAFE_CHARS, '') !== '') this.put(ch);
  }

  private csi(final: string, param: string): void {
    const n = Number.parseInt(param.replace(/[^0-9;].*$/, '').split(';')[0] ?? '', 10);
    const count = Number.isFinite(n) && n > 0 ? n : 1;
    switch (final) {
      case 'K': {
        // erase in line: 0 (default) from the cursor to the end, 1 to the cursor, 2 the whole line
        const mode = Number.isFinite(n) ? n : 0;
        if (mode === 0) this.cells.length = Math.min(this.cells.length, this.cursor);
        else if (mode === 1) {
          if (this.spend()) for (let i = 0; i < Math.min(this.cursor + 1, this.cells.length); i += 1) this.cells[i] = ' ';
        } else this.cells = [];
        return;
      }
      case 'J': {
        // erase in display: 2 and 3 clear the screen; the others only reach the current line here
        const mode = Number.isFinite(n) ? n : 0;
        if (mode === 2 || mode === 3) this.clear();
        else if (mode === 0) this.cells.length = Math.min(this.cells.length, this.cursor);
        return;
      }
      case 'C':
        this.cursor = Math.min(this.cursor + count, this.cells.length + REACH, LINE_CELLS - 1);
        return;
      case 'D':
        this.cursor = Math.max(0, this.cursor - count);
        return;
      case 'G':
        this.cursor = Math.min(Math.max(0, (Number.isFinite(n) && n > 0 ? n : 1) - 1), this.cells.length + REACH, LINE_CELLS - 1);
        return;
      case 'P':
        if (this.spend()) this.cells.splice(this.cursor, count);
        return;
      case '@': {
        // insert blanks at the cursor, pushing the rest right; whatever is pushed past the end of the line is lost, so the line never grows past its cap however many of these arrive
        if (!this.spend()) return;
        this.reach();
        const k = Math.min(count, 200, Math.max(0, LINE_CELLS - 1 - this.cursor));
        if (k === 0) return;
        while (this.cells.length < this.cursor) this.cells.push(' ');
        this.cells.splice(this.cursor, 0, ...BLANKS.slice(0, k));
        if (this.cells.length > LINE_CELLS - 1) this.cells.length = LINE_CELLS - 1;
        return;
      }
      case 'X':
        if (!this.spend()) return;
        for (let i = this.cursor; i < Math.min(this.cursor + count, this.cells.length); i += 1) this.cells[i] = ' ';
        return;
      default:
        // colours (m), cursor position, modes and every other code: not text
        return;
    }
  }
}
