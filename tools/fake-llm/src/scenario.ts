/**
 * The demo scenario: deterministic, persona-routed completions so the UI can be
 * exercised end to end with no model provider and no API key.
 *
 * Hermes renders one profile per run (the BOT.md body as SOUL.md, the gateway
 * URL plus the bot's own virtual key) and sends the run's prompt through the
 * gateway. This fake sits where the gateway points, so all it ever sees is an
 * OpenAI chat-completions body: a model (an alias such as `smart`) and a list
 * of messages. It never sees the bot slug — the virtual key is opaque here —
 * so routing is by what the messages *say*, which is also what makes it usable
 * from any client: name the persona in the text and the persona answers.
 *
 * The chain the user asked for:
 * - `orchestrator` takes a task, writes the plan, and delegates step 1 to coder.
 * - `coder` implements, shows the diff, and hands to tester.
 * - `tester` runs the checks, confirms, and reports back to orchestrator.
 * - `orchestrator` reads the confirmation and plans the next step.
 * - `brain` answers workspace questions grounded in the seeded memory facts
 *   below, so the memory panel has something real to show.
 *
 * Deterministic on purpose: the same messages always produce the same text, so
 * Playwright assertions and screenshots are stable. No network, no clock, no
 * randomness — the only state is the caller-supplied conversation.
 */

export interface ScenarioMessage {
  role: string;
  content: string;
}

export interface ScenarioRequest {
  model: string;
  messages: ScenarioMessage[];
  authorized: boolean;
}

/** Seeded workspace facts the brain persona quotes. Keep them obviously fake. */
export const DEMO_MEMORY_FACTS = [
  'Workspace runs the demo seed: gateway at MANYTHREADS_LITELLM_URL, fake proxy holds aliases smart/fast/code/local.',
  'Deploy command is `pnpm ship:dev`; last green deploy was rev 13 with 39 migrations.',
  'On-call rotation: Omar (lead), Sameera (support), Tariq (content); incidents live in #incidents.',
  'Lesson 2026-09-18: per-bot virtual keys are minted on bots.bot.loaded and revoked on bots.bot.removed.',
  'Lesson 2026-10-02: a proxy key with models [] may call every model, so the gateway never sends an empty list.',
] as const;

const textOf = (messages: ScenarioMessage[]): string => messages.map((m) => m.content).join('\n');

const lastUserText = (messages: ScenarioMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return message.content;
  }
  return messages[messages.length - 1]?.content ?? '';
};

const includesAny = (haystack: string, needles: readonly string[]): boolean => needles.some((n) => haystack.includes(n));

/**
 * The prompt wrapper names the author on leading `Name:` header lines (`Omar:` above the message). Routing reads the
 * message, not the wrapper, so those lines are dropped before the addressee checks: otherwise no last turn ever
 * "starts with" its `@persona` and the chain misroutes.
 */
const stripAuthorHeaders = (text: string): string => {
  const lines = text.split('\n');
  while (lines.length > 0 && BARE_HEADER.test(lines[0]!.trim())) lines.shift();
  return lines.join('\n');
};

const TASK_HINTS = ['orchestrat', '@coder', '@tester', '@orchestrator', 'delegate', 'implement', 'verify', 'plan', 'task'] as const;
const MEMORY_HINTS = ['brain', 'memory', 'recall', 'remember', 'hindsight', 'bank', 'lesson', 'fact', 'what do you know', 'who is on-call', 'on-call', 'deploy'] as const;

/** A bare `Name:` line is the prompt wrapper's author header, not the task. */
const BARE_HEADER = /^[A-Za-z][A-Za-z0-9_. -]{0,39}:$/;

/**
 * A `Name in #channel:` line is the same wrapper with the channel: it names
 * who spoke, never the addressee, so routing drops it before the addressee
 * checks. Without this a bot's own reply (`Coder in #dev:` …) starts with
 * its name and the `coder `/`tester ` prefix checks misroute the chain.
 * Task extraction keeps the line (it quotes the wrapper as the task label).
 */
const CHANNEL_HEADER = /^[A-Za-z][A-Za-z0-9_. -]{0,39} in #[A-Za-z0-9_.-]+:$/;

const stripChannelHeader = (text: string): string => {
  const lines = text.split('\n');
  if (lines.length > 0 && CHANNEL_HEADER.test(lines[0]!.trim())) lines.shift();
  return lines.join('\n').trimStart();
};

const extractTask = (text: string): string => {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length < 160 && !BARE_HEADER.test(l));
  // Prefer a line that is not an addressee paste, but fall back to one: what remains of an `@coder do X` line is `do X`.
  const firstLine = lines.find((l) => !l.startsWith('@')) ?? lines[0] ?? 'the demo task';
  const cleaned = firstLine
    .replace(/^@[A-Za-z0-9_.~-]+\s*/, '')
    .replace(/^[A-Za-z][A-Za-z0-9_. -]{0,39}:\s*/, '')
    .replace(/^(user|system)\s*:\s*/i, '')
    .trim();
  return cleaned.slice(0, 120) || 'the demo task';
};

function brainAnswer(last: string): string {
  const q = last.toLowerCase();
  const relevant = DEMO_MEMORY_FACTS.filter((fact) => {
    const words = fact.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    return words.some((w) => q.includes(w));
  });
  const facts = relevant.length > 0 ? relevant : [...DEMO_MEMORY_FACTS.slice(0, 3)];
  const lines = facts.map((f, i) => `${i + 1}. ${f} (memory://bank/demo-fact-${DEMO_MEMORY_FACTS.indexOf(f as (typeof DEMO_MEMORY_FACTS)[number]) + 1})`);
  return [
    `Brain here — from the team's memory bank, not a guess:`,
    ...lines,
    ``,
    `Ask me "what do you know about <topic>" or "recall the lesson about <topic>" and I will quote the bank again.`,
  ].join('\n');
}

function orchestratorKickoff(task: string): string {
  // Names only @coder with a mention: a mention wakes a bot, so naming @tester
  // here would open a tester run on the kickoff itself (out of order, before
  // any diff exists). Tester fires on coder's handoff below instead.
  return [
    `Orchestrator here. Plan for "${task}":`,
    `1. @coder implements it (small diff, tests included).`,
    `2. Tester runs the checks and confirms.`,
    `3. I review the confirmation and plan the next step.`,
    ``,
    `Next: @coder please implement "${task}" and hand to Tester when the diff is ready.`,
  ].join('\n');
}

function coderAnswer(task: string): string {
  return [
    `Coder here — implemented "${task}":`,
    ``,
    `\`\`\`diff`,
    `+ export function demoTask() {`,
    `+   return "done: ${task}";`,
    `+ }`,
    `\`\`\``,
    ``,
    `Checks I ran: typecheck on the touched file (clean).`,
    `Next: @tester please verify "${task}" and confirm to @orchestrator.`,
  ].join('\n');
}

function testerAnswer(task: string): string {
  return [
    `Tester here — verified "${task}":`,
    `- unit: demoTask returns the expected string — PASS`,
    `- typecheck: clean — PASS`,
    `- no live side effects (read-only run) — PASS`,
    ``,
    `Confirming to @orchestrator: "${task}" is done and green. Over to you for the next step.`,
  ].join('\n');
}

function orchestratorNextStep(task: string): string {
  // Terminal by design: no @-mentions, so no further run opens and the chain
  // ends here. A mention would wake that bot again (and a "from @tester"
  // line would read as a fresh delegation), looping until the depth guard.
  return [
    `Orchestrator here — confirmation from Tester received for "${task}".`,
    `Next step: roll it into the demo log, then pick up the next item in the queue.`,
    `Next: Coder, please take the follow-up (changelog entry for "${task}") unless a person redirects us.`,
  ].join('\n');
}

/**
 * The demo completion: pure, synchronous, deterministic. Route order matters —
 * a tester confirmation also names the orchestrator, so confirmations are
 * checked before kickoffs; memory questions win over the chain because the
 * brain is asked directly.
 */
export function demoScenarioCompletion(request: ScenarioRequest): string {
  const all = textOf(request.messages).toLowerCase();
  const last = stripAuthorHeaders(lastUserText(request.messages));
  const lowerLast = last.toLowerCase();
  const task = extractTask(last);

  // A tester confirmation pasted back to the orchestrator ("PASS …
  // @orchestrator") is the orchestrator's trigger even when it starts with
  // "@tester says …": the confirmation beats the addressee prefix. A fresh
  // "@tester verify …" delegation carries no PASS, so the two never collide.
  // The orchestrator handle keeps its @: a bot's own instructions (its SOUL,
  // Tester says "mark each PASS … to the orchestrator role") must never read
  // as a confirmation of its own work.
  if (/(pass|verified|confirmed|green).{0,80}@orchestrator|@orchestrator.{0,80}(pass|verified|confirmed|green)/s.test(lowerLast)) {
    return orchestratorNextStep(task);
  }
  // An explicit addressee at the start of the last turn otherwise wins: pasted
  // history quotes earlier steps (a kickoff names @tester, a handoff quotes
  // @coder), so whole-history keyword search alone would misroute the chain.
  // Routing reads the message past the wrapper; the task label keeps it.
  const routed = stripChannelHeader(last);
  const lowerRouted = routed.toLowerCase();
  const addressed = lowerRouted.trimStart();
  if (addressed.startsWith('@tester') || addressed.startsWith('tester:')) return testerAnswer(task);
  if (addressed.startsWith('@coder') || addressed.startsWith('coder:')) return coderAnswer(task);
  // The chain's handoff line (`Next: @persona …`) names the next owner
  // mid-turn: the prompt wrapper (`Name in #channel:`) keeps the turn from
  // *starting* with it, and word search alone would hand the kickoff ("hand
  // to Tester") to the tester. The handoff line beats the word fallbacks.
  const handoff = /^next:\s*@(tester|coder)\b/im.exec(routed);
  if (handoff?.[1]?.toLowerCase() === 'tester') return testerAnswer(task);
  if (handoff?.[1]?.toLowerCase() === 'coder') return coderAnswer(task);
  if (includesAny(lowerRouted, MEMORY_HINTS) || lowerRouted.startsWith('brain')) return brainAnswer(last);
  if (/(pass|verified|confirmed|green).{0,80}@orchestrator|@orchestrator.{0,80}(pass|verified|confirmed|green)/s.test(all)) {
    return orchestratorNextStep(task);
  }
  if (lowerRouted.includes('@tester') || (lowerRouted.includes('tester') && includesAny(lowerRouted, ['verify', 'confirm', 'hand', 'diff', 'implemented']))) {
    return testerAnswer(task);
  }
  if (lowerRouted.includes('@coder') || includesAny(lowerRouted, ['implement', 'build it', 'code it', 'delegate'])) return coderAnswer(task);
  if (all.includes('@orchestrator') || all.includes('orchestrat')) return orchestratorKickoff(task);
  if (includesAny(all, TASK_HINTS)) return orchestratorKickoff(task);
  if (includesAny(all, MEMORY_HINTS)) return brainAnswer(last);
  // No persona named: keep the demo moving through the orchestrator.
  return orchestratorKickoff(task);
}
