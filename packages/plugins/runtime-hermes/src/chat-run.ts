import type { PluginLogger, PluginTx } from '@manythreads/sdk';
import { modelAliasesOfDefinition } from '@manythreads/shared';
import type { LoadedDefinition, RunPayload } from './run-job.ts';

// What a run in a person's Chat conversation does beyond any other run (PLAN P20-16): it may use the model the person picked for the message, it notes on its
// row which message it answers and which model answered, and it streams. The picks are checked here against the bot's own definition: whatever the payload
// says, an alias the definition does not list (as an alias or a fallback) is ignored and the bot answers with its first one.

/** The conversation run that streams: a person asked in a conversation thread. */
export const streamsLive = (payload: RunPayload): payload is RunPayload & { askerActorId: string; replyRootId: string } =>
  payload.trigger === 'conversation' && payload.askerActorId !== null && payload.replyRootId !== null && payload.scheduledJob === undefined;

/** Put the picked alias first in the definition the run executes (a copy per run), when the definition allows it. Answers the alias the run will use. */
export function applyChatAlias(definition: LoadedDefinition, picked: string | undefined, log: PluginLogger): string | null {
  const model = definition.frontmatter.model;
  if (picked === undefined || picked === definition.alias) return definition.alias;
  const own = modelAliasesOfDefinition(definition.frontmatter);
  const allowed = [...own, ...(model?.fallbacks ?? [])];
  if (own.length === 0 || !allowed.includes(picked)) {
    log.warn(`runtime-hermes: the model "${picked}" picked for this message is not one the bot's definition lists; the bot answers with its first`);
    return definition.alias;
  }
  definition.alias = picked;
  definition.frontmatter = { ...definition.frontmatter, model: { ...model, aliases: [picked, ...own.filter((a) => a !== picked)] } };
  return picked;
}

/** The facts the conversations plugin reads from the run: the message it answers and the model that answered. Written as the system role. */
export async function recordRunFacts(tx: PluginTx, runId: string, payload: RunPayload, alias: string | null): Promise<void> {
  if (payload.trigger !== 'conversation' || payload.messageId === undefined) return;
  await tx.query('UPDATE app.bot_runs SET turn_message_id = $2::uuid, model_alias = $3 WHERE id = $1::uuid', [runId, payload.messageId, alias]);
}

/** The asker pressed Stop. */
export async function recordStopped(tx: PluginTx, runId: string): Promise<void> {
  await tx.query('UPDATE app.bot_runs SET stopped_by_asker = true WHERE id = $1::uuid', [runId]);
}
