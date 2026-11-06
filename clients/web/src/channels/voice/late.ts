import { sayToast } from '../../kernel/toast';
import type { Transcript } from '../../speech';

/**
 * "Send without waiting" (P14-17): the clip is posted at once with no transcript while this device keeps writing it out. When both are true,
 * the message is posted (its id is known) and the words are ready, the words are saved as an ordinary edit of the message body.
 *
 * The server marks an edited voice message `edited`, so a late transcript reads "corrected by hand" rather than "written on the sender's device":
 * the server has no way to take a late `device` transcript, and this stays honest about it.
 */

export const LATE_FAILED = "Couldn't add the words to your voice message. You can add them from its menu.";

export type LateTarget = { channelId: string; rootId: string | null; messageId: string };
export type LateApply = (target: LateTarget, text: string) => Promise<void>;

type Entry = { text: string | null; settled: boolean; target: LateTarget | null };

export class LateTranscripts {
  private readonly entries = new Map<string, Entry>();
  private applier: LateApply = () => Promise.resolve();

  /** The store plugs in how the words are saved. */
  setApplier(fn: LateApply): void {
    this.applier = fn;
  }

  /** The clip with this file id is being written out; `done` settles with the words or null. */
  watch(fileId: string, done: Promise<Transcript | null>): void {
    const entry: Entry = { text: null, settled: false, target: null };
    this.entries.set(fileId, entry);
    void done.then(
      (t) => {
        entry.settled = true;
        entry.text = t?.text.trim() || null;
        this.flush(fileId);
      },
      () => {
        entry.settled = true;
        this.flush(fileId);
      },
    );
  }

  /** The message that carries this clip was posted. */
  posted(fileId: string, target: LateTarget): void {
    const entry = this.entries.get(fileId);
    if (!entry) return;
    entry.target = target;
    this.flush(fileId);
  }

  watching(fileId: string): boolean {
    return this.entries.has(fileId);
  }

  private flush(fileId: string): void {
    const entry = this.entries.get(fileId);
    if (!entry || !entry.settled || !entry.target) return;
    this.entries.delete(fileId);
    if (entry.text === null) return;
    // the message still plays and can be given a transcript from its menu; say so, so the missing words are not a mystery
    void this.applier(entry.target, entry.text).catch(() => sayToast(LATE_FAILED));
  }
}

export const lateTranscripts = new LateTranscripts();
