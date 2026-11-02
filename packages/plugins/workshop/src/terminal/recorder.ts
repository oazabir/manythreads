import { TerminalText } from '@manythreads/shared';

// The record of one terminal (PLAN P7-09): the lines the shell printed, as text, passed through the data-protection redaction, cut at a size limit. Only the shell's OUTPUT is recorded (it
// includes what the shell echoes of the keys typed); the keystrokes themselves are never stored, so a password typed where nothing is echoed is not in the record at all.
//
// The redaction is the platform's own `pre_egress` chain (the same guard every outgoing message passes). It is asked for in whole lines, because a secret is found in a line, and a private
// key block (`-----BEGIN ... PRIVATE KEY-----` to `-----END`) is held until it is complete so that it is masked as one piece. When the guard cannot be reached the text is withheld, never stored.

const HOLD_LIMIT = 16 * 1024;
const WITHHELD = '[a part of the output is not recorded: it could not be checked for secrets]\n';
const CUT_NOTE = '\n[the record stops here: it reached the size limit]\n';

export type Redact = (text: string) => Promise<string>;

export class Recorder {
  private readonly screen = new TerminalText(1);
  private waiting = '';
  private chain: Promise<void> = Promise.resolve();
  private recorded = '';
  private cut = false;

  constructor(
    private readonly maxChars: number,
    private readonly redact: Redact,
  ) {}

  /** The record so far (redacted). */
  get text(): string {
    return this.recorded;
  }

  /** True when the record was cut at the size limit. */
  get truncated(): boolean {
    return this.cut;
  }

  /** Adds what the shell printed. Cheap and synchronous; the redaction runs in `flush`. */
  push(output: string): void {
    if (this.cut) return;
    this.screen.feed(output);
    this.waiting += this.screen.take();
    // never grow without bound if the redaction is slow: output is capped upstream, this is the backstop
    if (this.waiting.length > 4 * this.maxChars) this.waiting = this.waiting.slice(-this.maxChars);
  }

  /** Redacts and stores the finished lines. `final` also takes the unfinished last line and any held key block. Calls run one after another. */
  flush(final = false): Promise<void> {
    this.chain = this.chain.then(() => this.drain(final)).catch(() => undefined);
    return this.chain;
  }

  private async drain(final: boolean): Promise<void> {
    if (this.cut) return;
    if (final) this.waiting += this.screen.takeRest();
    let text = this.waiting;
    if (text === '') return;
    if (!final) {
      const open = text.lastIndexOf('-----BEGIN ');
      if (open >= 0 && text.indexOf('-----END ', open) < 0) {
        if (text.length - open <= HOLD_LIMIT) text = text.slice(0, open);
      }
    }
    if (text === '') return;
    this.waiting = this.waiting.slice(text.length);
    let safe: string;
    try {
      safe = await this.redact(text);
    } catch {
      safe = WITHHELD;
    }
    const room = this.maxChars - this.recorded.length;
    if (safe.length > room) {
      this.recorded += safe.slice(0, Math.max(0, room)) + CUT_NOTE;
      this.cut = true;
      this.waiting = '';
      return;
    }
    this.recorded += safe;
  }
}
