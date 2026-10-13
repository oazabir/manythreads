import { ANSWER_MASKED_KIND, type AnswerPayload } from '../entities/answer.ts';

// "Hand to a bot" (SPEC §12.4, PLAN P5-17): the message the asker sends, as themselves, into their own conversation with another bot. The text is
// made from the question they asked and the copy of the answer (masked for the readers of that conversation, which for a private one is the asker
// alone and so loses nothing). Pure: nothing here reads a database.

const QUESTION_MAX = 2_000;
const MESSAGE_MAX = 39_000;

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** What the receiving bot is given: where it came from, the question, the answer's text, and each source's name. */
export function handoffMessage(input: { fromBot: string; question: string; copy: AnswerPayload }): string {
  const { fromBot, question, copy } = input;
  const quoted = clip(question.trim(), QUESTION_MAX)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  const lines: string[] = [`Handed over from ${fromBot}.`, ''];
  if (question.trim() !== '') lines.push('The question was:', quoted, '');
  lines.push(`${fromBot}'s answer:`, '', copy.body.trim(), '');
  if (copy.citations.length > 0) {
    lines.push('Sources it rests on:');
    for (const c of [...copy.citations].sort((a, b) => a.n - b.n)) {
      lines.push(c.kind === ANSWER_MASKED_KIND ? `[${c.n}] a ${c.source} that is not shared` : `[${c.n}] ${c.label} (${c.kind})`);
    }
  }
  return clip(lines.join('\n').trim(), MESSAGE_MAX);
}
