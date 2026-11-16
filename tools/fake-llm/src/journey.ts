/*
 * The journey scenario of the fake proxy (P27-19): what the setup wizard's Verify Brain step and its test turn need from a model, with no provider.
 *
 * It answers like a model that follows Brain's rules and reads the tools it is offered, in as few turns as a careful one:
 *   1. the question, with `messages_search` offered      -> a call to `messages_search` with the question's words
 *   2. the search answered (a list of hits with ids)     -> a call to `answer_post`: a short body that cites `[1]`, citing the first hit by its message id
 *   3. the post answered                                 -> a last line of text ("Done.")
 * With no tool offered (the wizard's plain test turn, Hermes with its own tools) it answers one sentence of text that carries the word "journey-ok",
 * so a test can look for it. A search with no hits leads to an `answer_post` with no citation and a plain "I could not find it".
 *
 * Pure: the same request gives the same answer, no clock, no randomness. The OpenAI wire shape (`tool_calls`, role `tool`) is what a gateway turn sends.
 */

export interface WireMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
}

export interface WireTool {
  type?: string;
  function?: { name?: string };
}

/** What the scenario answers: plain text, or one or more tool calls. */
export type JourneyAnswer = { text: string } | { toolCalls: Array<{ id: string; name: string; arguments: string }> };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'object' && p !== null && 'text' in p ? String((p as { text: unknown }).text) : '')).join('\n');
  return '';
};

const offered = (tools: WireTool[] | undefined, pattern: RegExp): string | null => {
  for (const t of tools ?? []) {
    const name = t.function?.name;
    if (typeof name === 'string' && pattern.test(name)) return name;
  }
  return null;
};

/** The question's words, cut to something a search takes. */
const queryOf = (question: string): string =>
  question
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 6)
    .join(' ') || 'team';

export function journeyAnswer(messages: WireMessage[], tools: WireTool[] | undefined): JourneyAnswer {
  const search = offered(tools, /^messages[._]search$/);
  const post = offered(tools, /^answer[._]post$/);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question = textOf(lastUser?.content);
  const last = messages[messages.length - 1];

  if (last?.role === 'tool') {
    const toolMessages = messages.slice(messages.lastIndexOf(lastUser as WireMessage) + 1).filter((m) => m.role === 'tool');
    // the post was answered: the run is over
    const afterPost = messages.some((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((c) => c.function?.name === post));
    if (post !== null && afterPost) return { text: 'Done.' };
    if (post !== null) {
      const hit = toolMessages.map((m) => UUID.exec(textOf(m.content))?.[0]).find((id) => id !== undefined);
      const args =
        hit === undefined
          ? { body: 'I could not find anything written down about that yet. Add a document to the team files and ask again.' }
          : { body: 'The journey check found one message that matches your question [1].', citations: [{ kind: 'message', messageId: hit }] };
      return { toolCalls: [{ id: 'call_journey_post', name: post, arguments: JSON.stringify(args) }] };
    }
    return { text: 'journey-ok: the search answered.' };
  }
  if (search !== null && post !== null) {
    return { toolCalls: [{ id: 'call_journey_search', name: search, arguments: JSON.stringify({ query: queryOf(question) }) }] };
  }
  return { text: `journey-ok: the model answered. You asked: ${question.slice(0, 120)}` };
}
