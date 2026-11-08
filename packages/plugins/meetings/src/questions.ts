import type { PluginContext } from '@manythreads/sdk';

// Work package S5 (P15-24): questions to the note-taker. A final line of a person who said yes that names the bot is checked by a fast model; the answer run reads only
// what every person present may read, at most one at a time and six a minute per room; the answer is posted in the call thread and pushed as a caption naming the asker.
// STUB: nothing is registered until S5.
export function registerQuestions(ctx: PluginContext): void {
  void ctx;
  // S5: the line scanner, the one-at-a-time queue, the thread @mention path.
}
