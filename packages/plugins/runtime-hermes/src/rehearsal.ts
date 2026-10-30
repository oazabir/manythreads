import type { RunPayload } from './run-job.ts';

// A rehearsal run (the bot page's Test action, PLAN P7-11): the run is the ordinary conversation run of one question, except that the gateway holds
// back every write (gateway-mcp, `holdBack`). Three small things belong to the runtime and live here so the run job stays readable:
//   * the note the model is given, so it describes what it would have done instead of claiming it did it, and says so when it has nothing to go on;
//   * the check that a rehearsal can really hold this bot's writes back: a bot whose definition grants the process itself a shell, files or a browser
//     (`capabilities.runtime`) can change things without touching the tool door, so such a run is not started;
//   * the plain sentence for that refusal.

/** What the model is told at the head of a rehearsal prompt. Plain words; no instruction can undo the gateway's hold, this only makes the reply honest. */
export const REHEARSAL_NOTE =
  'REHEARSAL. A team lead is testing your definition with this one question. Answer it exactly as you would for a colleague, and read whatever you need. ' +
  'Every tool that would change something (post a message, write a page, create a card, remember a fact, hand work over) is held back: it answers that it was NOT done, and nothing happens. ' +
  'Never say a held-back action happened; say what you would have done. If the knowledge base has nothing on the question, or the team has no knowledge base, say so plainly and answer only from what you have.';

/**
 * The payload with the note in front of the prompt. Idempotent: a run held for an approval stores the payload it was given (note included) and is parsed
 * and passed through here again when a person approves it.
 */
export function withRehearsalNote(payload: RunPayload): RunPayload {
  if (payload.rehearsal === true && payload.prompt.startsWith(REHEARSAL_NOTE)) return payload;
  return payload.rehearsal === true ? { ...payload, prompt: `${REHEARSAL_NOTE}\n\n${payload.prompt}`.slice(0, 40_000) } : payload;
}

/** The sentence when a rehearsal cannot hold a bot's writes back, or null when it can. `runtimeGrants` is the definition's `capabilities.runtime`. */
export function rehearsalBlocker(runtimeGrants: readonly string[] | undefined): string | null {
  if (runtimeGrants === undefined || runtimeGrants.length === 0) return null;
  return `This test was not run: ${runtimeGrants.join(', ')} ${runtimeGrants.length === 1 ? 'is' : 'are'} granted to this bot's own process, and a rehearsal can only hold back what goes through the platform's tools. Test a copy without it.`;
}
