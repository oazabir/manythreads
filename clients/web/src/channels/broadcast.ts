import { broadcastSentence, broadcastWordsIn, type BroadcastReach, type BroadcastWord } from '@manythreads/shared';

/*
 * `@channel` and `@here` in the composer (PLAN P14-02). A message that uses either word is checked against how many people it would notify here; above the
 * limit the person is asked first, and the message is sent with `confirmBroadcast` once they agree. The server applies the same rule, so a page that did
 * not ask is still refused (409), and nothing is sent twice.
 */

/** `people` is how many the page counted; null when the question comes from the server's refusal (its sentence is kept as it is). */
export type BroadcastAsk = { words: BroadcastWord[]; people: number | null; text: string };

/** The question to ask before sending `body`, or null when no question is needed (no such word, or few enough people). */
export function broadcastAsk(body: string, reach: BroadcastReach): BroadcastAsk | null {
  const words = broadcastWordsIn(body);
  if (words.length === 0) return null;
  // @channel tells everybody; @here only those online; a message with both tells the larger set
  const people = words.includes('channel') ? reach.channel : reach.here;
  if (people <= reach.confirmAbove) return null;
  return { words, people, text: `${broadcastSentence(words, people)} Send it anyway?` };
}

/** The question for a send or a schedule the server refused with 409 `broadcast_needs_confirmation` (the room grew since the page counted, or the count could not be had). */
export function broadcastAskFromRefusal(body: string, serverSentence: string): BroadcastAsk {
  return { words: broadcastWordsIn(body), people: null, text: `${serverSentence.replace(/\s*Confirm to send it\.$/, '')} Send it anyway?` };
}
