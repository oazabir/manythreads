/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC answers are documents of many shapes, read defensively */
import { startFakeHermesGateway, type FakeHermesGateway, type FakeHermesRun, type FakeRunStep } from '../../tools/fake-hermes-gateway/src/server.ts';

/*
 * A scripted Hermes for the journey specs (PLAN P8-36): the part of a Hermes gateway the platform talks to for a bot placed on a Hermes gateway runner, with a
 * profile per bot whose "model" is a small deterministic script instead of a language model.
 *
 * What is the platform's own, and real:
 *  - the wire: tools/fake-hermes-gateway answers `POST /v1/runs`, the event stream and the stop door exactly as a Hermes `api_server` does (profile chosen by the URL
 *    prefix, a bearer key per profile, the run id as the idempotency key);
 *  - the tools: for each run the script calls the bot's own MCP endpoint (`<origin>/mcp`, bearer = the bot's pairing token) with JSON-RPC `tools/list` and
 *    `tools/call`, the way a profile's model would. So the broker, the gateway-mcp door, the real `knowledge.search`, `messages.post`, `email.read` and `email.send`
 *    (which waits for a person) are the platform's, not a mock's.
 * What is scripted: the decisions a model would make, here the two mail bots of the support journey (`support-email`, `customer-support`). The scripts read the prompt the
 * platform sent (the fenced mail text, the thread message that tagged the bot) and answer from what the tools gave back; nothing is hard-wired to the mails of one
 * test, so a spec may send any question and the manuals decide whether there is an answer.
 *
 * Every tool call is kept (`calls`, with the answer) and each run's `tools/list` (`offered`), so a spec can assert what a bot did and what it was allowed to see.
 */

export const STAND_IN_KEY = 'stand-in-key-0123456789abcdef';

export interface StandInCall {
  /** The profile (the bot's slug) that made the call. */
  profile: string;
  /** The Hermes run id. */
  runId: string;
  tool: string;
  args: Record<string, unknown>;
  /** The platform's answer: false when the door refused or the tool answered `ok: false` (an approval that is pending is `ok: false` with code `approval_pending`). */
  ok: boolean;
  /** The tool's answer as the model sees it (parsed JSON when it is JSON, else the text). */
  answer: unknown;
}

export interface StandIn {
  readonly gateway: FakeHermesGateway;
  /** Where the platform reaches the stand-in (the address of a runner of kind Hermes gateway). */
  readonly url: string;
  readonly key: string;
  /** Tells the stand-in where a bot's MCP door is and the token that opens it (what a real profile's config holds). */
  register(profile: string, mcp: { url: string; token: string }): void;
  /** Every tool call of every run, oldest first. */
  readonly calls: StandInCall[];
  /** The tool names each run was offered by `tools/list`, by Hermes run id. */
  readonly offered: Map<string, string[]>;
  /** The prompts the platform sent, by profile, oldest first. */
  promptsOf(profile: string): string[];
  close(): Promise<void>;
}

interface McpEndpoint {
  url: string;
  token: string;
}

/** The text of a message after the platform's one line of context (`Name in #channel:`), the way `buildPrompt` writes it. */
export function messageOf(prompt: string): string {
  const cut = prompt.indexOf(':\n\n');
  return cut === -1 ? prompt : prompt.slice(cut + 3);
}

/** The mail facts the platform wrote into an inbox prompt, and the customer's words between the markers. */
export function mailOf(prompt: string): { from: string; subject: string; text: string } | null {
  if (!prompt.includes('<<<BEGIN MAIL TEXT>>>')) return null;
  const from = /^- from: (.*)$/m.exec(prompt)?.[1]?.trim() ?? '';
  const subject = /^- subject: (.*)$/m.exec(prompt)?.[1]?.trim() ?? '';
  const text = /<<<BEGIN MAIL TEXT>>>\n([\s\S]*?)\n<<<END MAIL TEXT>>>/.exec(prompt)?.[1]?.trim() ?? '';
  return { from, subject, text };
}

/** Words of a sentence worth searching for: the rest of the sentence is stop words and the mail's politeness. */
const STOP = new Set(
  'a an and are as at be but by can could do does for from had has have how i if in is it its me my of on or our please so that the their there this to us was we were what when where which who why will with would you your hello hi hey thanks thank dear'.split(
    ' ',
  ),
);
export const keywordsOf = (text: string): string =>
  [...new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 6).join(' ');

export async function startHermesStandIn(): Promise<StandIn> {
  const endpoints = new Map<string, McpEndpoint>();
  const calls: StandInCall[] = [];
  const offered = new Map<string, string[]>();
  const prompts = new Map<string, string[]>();

  let rpcId = 0;
  async function rpc(profile: string, method: string, params: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const mcp = endpoints.get(profile);
    if (!mcp) throw new Error(`the stand-in has no MCP door registered for profile ${profile}`);
    rpcId += 1;
    const res = await fetch(mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the text */
    }
    return { status: res.status, body };
  }

  /** One tool call, as a model's tool-use turn: recorded, and the answer parsed the way the model reads it. */
  async function tool(run: FakeHermesRun, name: string, args: Record<string, unknown>): Promise<StandInCall> {
    const { status, body } = await rpc(run.profile, 'tools/call', { name, arguments: args });
    const text: unknown = body?.result?.content?.[0]?.text;
    let answer: unknown = text ?? body;
    if (typeof text === 'string') {
      try {
        answer = JSON.parse(text);
      } catch {
        answer = text;
      }
    }
    const refused = body?.result?.isError === true || body?.error !== undefined || status >= 400;
    const ok = !refused && !(typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === false);
    const call: StandInCall = { profile: run.profile, runId: run.runId, tool: name, args, ok, answer };
    calls.push(call);
    return call;
  }

  const toolEvents = (made: StandInCall[]): FakeRunStep[] => made.map((c): FakeRunStep => ({ type: 'tool', name: `mcp__manythreads__${c.tool}`, error: !c.ok }));

  // ---- the support-email bot: puts a mail in front of the team, and sends the agreed answer back (which waits for a person)
  async function supportEmail(run: FakeHermesRun, prompt: string): Promise<FakeRunStep[]> {
    const made: StandInCall[] = [];
    const mail = mailOf(prompt);
    if (mail !== null) {
      made.push(await tool(run, 'email.read', { limit: 5 }));
      const quoted = mail.text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      const posted = await tool(run, 'messages.post', {
        body: [`**From:** ${mail.from}`, `**Subject:** ${mail.subject}`, '', quoted, '', '@customer-support please answer this email from the manuals.'].join('\n'),
      });
      made.push(posted);
      return [...toolEvents(made), { type: 'finish', output: posted.ok ? 'Posted the email in the channel and tagged the Customer support bot.' : 'I could not post the email.' }];
    }

    // tagged with an answer: everything but the notes to the team and the tag line is what the customer gets
    const message = messageOf(prompt);
    const answer = message
      .split('\n')
      .filter((line) => !/^notes for the team:/i.test(line) && !/@support-email/.test(line))
      .join('\n')
      .trim();
    if (answer === '' || /no answer was agreed|went to a person/i.test(message)) {
      const said = await tool(run, 'messages.post', { body: 'Nothing was sent: no answer was agreed in this thread.' });
      return [...toolEvents([said]), { type: 'finish', output: 'Nothing sent.' }];
    }
    const sent = await tool(run, 'email.send', { body: answer });
    made.push(sent);
    const pending = (sent.answer as { code?: string } | null)?.code === 'approval_pending';
    made.push(await tool(run, 'messages.post', { body: pending ? 'The reply to the customer is written and waiting for a person to approve it. It is not sent yet.' : sent.ok ? 'The reply was sent to the customer.' : 'The reply could not be sent.' }));
    return [...toolEvents(made), { type: 'finish', output: pending ? 'The reply waits for approval.' : 'Done.' }];
  }

  // ---- the customer-support bot: answers from the manuals, or hands the case to a person
  async function customerSupport(run: FakeHermesRun, prompt: string): Promise<FakeRunStep[]> {
    const made: StandInCall[] = [];
    const message = messageOf(prompt);
    const subject = /\*\*Subject:\*\*\s*(.*)/.exec(message)?.[1]?.trim() ?? '';
    const customerText = message
      .split('\n')
      .filter((line) => line.startsWith('>'))
      .map((line) => line.replace(/^>\s?/, ''))
      .join(' ');
    // search with the subject's words first, then with the customer's own words
    let hits: Array<{ document: string; version: number; text: string; citation: string; score: number }> = [];
    for (const query of [keywordsOf(subject), keywordsOf(customerText)].filter((q, i, all) => q.length >= 2 && all.indexOf(q) === i)) {
      const found = await tool(run, 'knowledge.search', { query });
      made.push(found);
      // a model judges whether a passage answers the question; the script asks for most of the question's words to be in it (the search itself lets a stray word through)
      hits = ((found.answer as { hits?: typeof hits } | null)?.hits ?? []).filter((h) => h.text.trim() !== '' && h.score >= 0.5);
      if (hits.length > 0) break;
    }
    if (hits.length === 0) {
      const said = await tool(run, 'messages.post', {
        body: `Notes for the team: I searched the manuals for “${keywordsOf(subject) || keywordsOf(customerText)}” and found nothing that covers this. I am handing it to a person (role:support-agent). Nothing is sent to the customer.`,
      });
      made.push(said);
      return [...toolEvents(made), { type: 'finish', output: 'Handed to a person; nothing for the customer.' }];
    }
    const best = hits[0]!;
    const posted = await tool(run, 'messages.post', {
      body: [`Notes for the team: found in \`${best.document}\`, version ${best.version}.`, '', best.text.trim(), '', `@support-email the answer above is ready to send to the customer.`].join('\n'),
    });
    made.push(posted);
    return [...toolEvents(made), { type: 'finish', output: 'Answered from the manuals and tagged the Support email bot.' }];
  }

  const gateway = await startFakeHermesGateway({
    profiles: {},
    script: async (run) => {
      const prompt = String(run.body['input'] ?? '');
      prompts.set(run.profile, [...(prompts.get(run.profile) ?? []), prompt]);
      // what a Hermes does first: ask the MCP server for its tools
      const listed = await rpc(run.profile, 'tools/list', {});
      const names: unknown[] = listed.body?.result?.tools ?? [];
      offered.set(run.runId, names.map((t) => String((t as { name?: unknown }).name)));
      if (run.profile === 'support-email') return supportEmail(run, prompt);
      if (run.profile === 'customer-support') return customerSupport(run, prompt);
      return [{ type: 'finish', output: `No script for the profile ${run.profile}.` }];
    },
  });

  return {
    gateway,
    url: gateway.url,
    key: STAND_IN_KEY,
    register(profile, mcp) {
      endpoints.set(profile, mcp);
      gateway.setProfile(profile, { apiKey: STAND_IN_KEY, mcp });
    },
    calls,
    offered,
    promptsOf: (profile) => prompts.get(profile) ?? [],
    close: () => gateway.close(),
  };
}
