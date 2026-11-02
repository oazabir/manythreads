// Where a bot may be placed, as plain rules the server (the bot loader, the proposal check, the runner catalog) and the web page (the Runs on picker) all share,
// so a bot is never offered a runner in the picker and then refused on save. Nothing here reads a database.

/** The capabilities that let a bot's reply reach the thread: `messages.post` posts the reply the run ends with, `answer.post` is the tool a model finishes with. */
export const REPLY_CAPABILITIES = ['messages.post', 'answer.post'] as const;

/** Does the list of native capabilities of a bot let its reply be posted? A namespace grant (`messages.*`, `answer.*`) counts, as the broker reads it. */
export function canPostReply(native: readonly string[]): boolean {
  return REPLY_CAPABILITIES.some((cap) => native.includes(cap) || native.includes(`${cap.split('.')[0] as string}.*`));
}

/** The sentence for a bot that asks for a shell, files or a browser and is placed on a runner that only calls a model. */
export function modelRunnerRefusal(label: string, runtimeGrants: readonly string[]): string {
  const list = runtimeGrants.slice(0, 5).join(', ');
  return `${label} only calls a model: it has no shell, files or browser to give this bot (the bot asks for: ${list}). Take those out of the bot's runtime capabilities, or pick a Hermes runner.`;
}

/** The sentence for a bot that has no way to post its reply and is placed on a runner that only calls a model (the run would end with "not set up to post messages"). */
export function modelRunnerNoReply(label: string): string {
  return `${label} only calls a model and posts the bot's reply for it, but this bot is not allowed to post: add messages.post (or answer.post) to the bot's native capabilities, or pick a Hermes runner.`;
}

/**
 * Why a bot cannot be placed on a runner that only calls a model, or null. `native` left out means the caller does not know the bot's native capabilities (only the runtime
 * ones are checked). The shell, files or browser refusal is named first, because it cannot be mended by adding a capability.
 */
export function modelRunnerProblem(label: string, bot: { runtime: readonly string[]; native?: readonly string[] | undefined }): string | null {
  if (bot.runtime.length > 0) return modelRunnerRefusal(label, bot.runtime);
  if (bot.native !== undefined && !canPostReply(bot.native)) return modelRunnerNoReply(label);
  return null;
}

/** `placement.runs_on` names a place for Hermes to run a bot; a rules bot runs inside the server and has none. Null when the choice is fine. */
export function runsOnProblem(bot: { runtime: string; placement?: { runs_on?: string | undefined } | undefined }): string | null {
  if (bot.placement?.runs_on === undefined || bot.runtime === 'hermes') return null;
  return 'placement.runs_on is for bots that run on Hermes. A rules bot runs inside the server and has no runner to choose.';
}
