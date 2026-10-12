import { definePlugin } from '@manythreads/sdk';
import type { BotRuntimeEvent, BotRuntimeHandle, BotRuntimeInput, BotRuntimeProvider, BotRuntimeScope } from '@manythreads/sdk';

// runtime-rules: the no-model runtime (SPEC §7.1, §8; PLAN P5-10). A bot whose `BOT.md` says `runtime: rules` runs its own
// declared work in order, with no model call anywhere — that is the whole point of it. It is what makes the task substrate's
// locking testable per PR (`pnpm test:runtime-rules`, the counting-benchmark variant of §8, PLAN P6-10): twenty rules bots
// claim, add one and release on one counter, and the log either reads 1→20 or the test says where it broke. A model would
// make that test slow, costly and non-deterministic; this runtime makes it a unit test.
//
// What a rules run is, exactly:
//  * its **rules** are the definition's `capabilities.native`, in the order the author wrote them — the single ordered list a
//    BOT.md already has, so nothing new is invented to describe behaviour (a rules bot has no body-driven persona to render);
//  * a rule's arguments are the trigger's message and its place (`channelId`, `body`, `threadRootId`); see `ruleInput`;
//  * every rule is called through the run's scope, so it is authorized by the broker exactly like a Hermes tool call and its
//    effect carries the run's bot;
//  * the run answers with **no text**: a rules bot does not chat, its effects are the answer. The run row and its audit
//    events say what happened, and a runtime that shelled out to a model would not be this runtime.
//
// Two honest limits: a rule is called with the run's own trigger data (the `prompt`, the channel and the asker) and nothing
// else — the per-rule arguments of a routine arrive with the task substrate (P6); and a definition with no `capabilities.native`
// runs, answers nothing and says so in the log.

/** The provider's id, which is also the `bots.runtime` value it runs. */
export const RULES_RUNTIME_ID = 'rules';

/** The one file a rules profile renders: what this run will do, in order. Kept so `render` is honest about being a profile. */
export interface RulesProfile {
  bot: string;
  trigger: string;
  steps: readonly string[];
}

/** The steps of one run: the definition's native capabilities, in order. */
export function rulesOf(input: BotRuntimeInput): string[] {
  return [...(input.definition.frontmatter.capabilities?.native ?? [])];
}

/**
 * The arguments a rule is called with: the trigger's own message and where it was posted, in the shape the native
 * capabilities take. `messages.post` is `strictObject({ channelId, body, threadRootId })`, so a rule gets exactly those
 * three — extra keys (the trigger name, the bot, the team, the asker) would be refused as unknown keys and the run would fail
 * on its first rule. The bot, the team and the run come from the run's own transaction, never from arguments. Per-rule
 * arguments (a task id, a counter) arrive with the task substrate (P6).
 */
export function ruleInput(input: BotRuntimeInput): Record<string, unknown> {
  return {
    channelId: input.thread?.channelId ?? null,
    body: input.prompt,
    threadRootId: input.thread?.threadRootId ?? null,
  };
}

export const rulesProvider: BotRuntimeProvider = {
  id: RULES_RUNTIME_ID,

  render: (input: BotRuntimeInput) => ({
    home: `${input.bot.slug}-${input.endpoint?.runId ?? 'no-run'}`,
    files: {
      'rules.json': `${JSON.stringify({ bot: input.bot.slug, trigger: input.trigger, steps: rulesOf(input) } satisfies RulesProfile, null, 2)}\n`,
    },
  }),

  async run(input: BotRuntimeInput, scope: BotRuntimeScope): Promise<BotRuntimeHandle> {
    const steps = rulesOf(input);
    return {
      stop: async () => undefined,
      events: (async function* run(): AsyncGenerator<BotRuntimeEvent> {
        if (steps.length === 0) {
          scope.log(`runtime-rules: bot ${input.bot.slug} declares no capabilities.native, so its run does nothing`);
        }
        for (const step of steps) {
          // A refusal or an error in one rule ends the run: a rules bot's order is its contract, and continuing past a
          // failed step would make the log read differently run to run. `ok` is false, and the reason is the error's.
          try {
            yield { type: 'tool', name: step, input: null };
            await scope.invoke(step, ruleInput(input));
            yield { type: 'tool_result', name: step, ok: true };
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            yield { type: 'tool_result', name: step, ok: false };
            scope.log(`runtime-rules: rule ${step} failed for bot ${input.bot.slug}: ${reason}`);
            yield { type: 'result', text: '', ok: false, error: reason, tokens: null };
            return;
          }
        }
        yield { type: 'result', text: '', ok: true, tokens: null };
      })(),
    };
  },
};

/**
 * runtime-rules: the `rules` bot_runtime provider. It registers nothing else — routing, the run row, the source log and the
 * reply all belong to `runtime-hermes`, which runs whatever provider `bots.runtime` names.
 */
export default definePlugin({
  manifest: {
    name: 'runtime-rules',
    version: '0.1.0',
    kind: 'server',
    extends: ['provider.bot_runtime'],
  },
  register(ctx) {
    ctx.providers.register('bot_runtime', rulesProvider);
  },
});
