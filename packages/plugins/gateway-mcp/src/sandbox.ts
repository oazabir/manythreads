import { RunEndedError, SANDBOX_TEST_WRITE, type BotRunHandle, type McpToolsProvider, type PluginContext } from '@manythreads/sdk';
import { callTool, holdBack, offeredTools, wasHeld } from './protocol.ts';

// The sandbox of the Workshop's Rehearse mode (PLAN P7-05). A rehearsal of the bot page's Test action holds its writes back at `callTool` because the run's own row says "rehearsal". The
// Workshop needs the same promise for a conversation it runs itself, and it is not a runtime: it may not open runs. This file is the broker's side of that: it opens a run that is ALWAYS
// a rehearsal, and it decides, from the run's row and never from the caller's say-so, that a call is made in a live rehearsal at all. A write is held back in `callTool` (`sandbox: true`):
// every tool that is not a read, the reply tool included, plus `test.write`, a write that exists only here so the hold can be shown without a real tool.

const TEST_WRITE_DESCRIPTOR = {
  name: SANDBOX_TEST_WRITE,
  description:
    'A test write: pretends to save a note. It exists only while the bot is being rehearsed, so the Workshop can show that writes are held back. It does nothing anywhere.',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string', maxLength: 2000, description: 'What would be saved.' } },
    additionalProperties: false,
  },
} as const;

type RunRow = {
  rehearsal: boolean;
  status: string;
  bot_id: string;
  team_id: string;
  asker_id: string | null;
  trigger_type: string;
};

/**
 * The run as its own row says it is: a running rehearsal of the same bot, team and asker as the handle the caller holds. A handle is a plain object the caller could have made up or
 * kept past the run's end, so it is never believed: anything else is refused, and the handle that goes on is built from the row (`rehearsal: true`).
 */
async function liveRehearsal(ctx: PluginContext, run: BotRunHandle): Promise<BotRunHandle> {
  const row = await ctx.db.system(
    async (tx) =>
      (await tx.query<RunRow>('SELECT rehearsal, status, bot_id, team_id, asker_id, trigger_type FROM app.bot_runs WHERE id = $1::uuid', [run.runId])).rows[0],
    { workspaceId: run.workspaceId },
  );
  if (!row || row.status !== 'running') throw new RunEndedError(run.runId);
  if (!row.rehearsal || row.trigger_type !== 'conversation' || row.bot_id !== run.botId || row.team_id !== run.teamId || row.asker_id !== run.askerActorId) {
    // never a normal run: the sandbox is the one door that must not be usable on a real run
    throw new Error('The sandbox was asked to act for a run that is not a rehearsal of this bot.');
  }
  return { ...run, rehearsal: true };
}

export function sandboxMembers(ctx: PluginContext): Pick<McpToolsProvider, 'openSandbox' | 'sandboxTools' | 'sandboxCall' | 'closeSandbox'> {
  return {
    openSandbox: async (input) => {
      const { run } = await ctx.runs.open({
        botId: input.botId,
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        trigger: 'conversation',
        askerActorId: input.askerActorId,
        rehearsal: true,
        // a turn of a Workshop conversation is a few model calls; the run is closed at its end and this is only the backstop
        ttlSeconds: 15 * 60,
      });
      return run;
    },
    sandboxTools: async (run) => {
      const live = await liveRehearsal(ctx, run);
      const offered = (await offeredTools(ctx, live)).map((o) => ({
        name: o.descriptor.name,
        description: o.descriptor.description ?? '',
        inputSchema: o.descriptor.inputSchema as Record<string, unknown>,
      }));
      return [...offered.filter((t) => t.name !== SANDBOX_TEST_WRITE), { ...TEST_WRITE_DESCRIPTOR, inputSchema: { ...TEST_WRITE_DESCRIPTOR.inputSchema } }];
    },
    sandboxCall: async (run, name, args) => {
      const live = await liveRehearsal(ctx, run);
      if (name === SANDBOX_TEST_WRITE) {
        // not a capability: nothing implements it, so there is nothing to run. It is held like any write, and shown as such.
        const held = await holdBack(ctx, live, name, args, false);
        return { text: held.content.map((c) => c.text).join('\n'), isError: held.isError === true, held: wasHeld(held) };
      }
      const result = await callTool(ctx, live, { name, arguments: args }, { sandbox: true });
      return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true, held: wasHeld(result) };
    },
    closeSandbox: async (run, status) => {
      // a run id is a uuid anyone could name: only a live rehearsal run is closed here, so the door cannot end a real run
      await liveRehearsal(ctx, run).then(
        () => ctx.runs.close(run.runId, status).then(() => undefined),
        () => undefined,
      );
    },
  };
}

