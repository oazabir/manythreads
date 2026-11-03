import { HttpError, type PluginContext, type PluginTx, type ViewerReadResult } from '@manythreads/sdk';
import { SURFACE_BIND_RESULT_MAX_CHARS, bindableTool } from '@manythreads/shared';
import { z } from 'zod';
import { TOOLS } from './catalog.ts';

// A read tool called as the person looking at a screen (PLAN P9-06, SPEC §14, principle 7). A screen's part says "my values come from this read tool"; the page asks the
// surfaces plugin for them and that plugin comes here. Everything that makes it safe is in this one function, because it is the one place a tool is run for someone who is
// not a bot's run:
//   * the caller's transaction must be a PERSON's. No other actor (a bot, the system role) gets a read this way, so this door cannot be used to read with more than a person may;
//   * the tool must be on the short list a screen may bind (shared `SURFACE_BINDABLE_TOOLS`) AND be a read in this catalog AND have an implementation here that is a plain
//     capability (not a tool of a person's outside account). All three, so adding a tool to one list never exposes it;
//   * the call runs in a transaction of its own as the same person: READ ONLY (a tool that tried to write would fail), with a statement time limit, so it holds no connection
//     for long and what it sees is exactly what the person's row-level security shows. The bot that wrote the screen is nowhere in this path: its grants are not asked and not used;
//   * the answer is cut off at a size limit, never truncated into something that looks whole.
// Not done here, deliberately: the data-loss check (no model reads this; the rows are ones the person may open anyway) and the run's source log (there is no run).

/** The longest one bound read may run before the database cancels it (milliseconds). */
export const VIEWER_READ_TIMEOUT_MS = 5000;

const refuse = (code: Extract<ViewerReadResult, { ok: false }>['code'], message: string): ViewerReadResult => ({ ok: false, code, message });

export async function readForViewer(ctx: PluginContext, faultLog: (line: string) => void, tx: PluginTx, name: string, args: Record<string, unknown>): Promise<ViewerReadResult> {
  if (tx.actor.kind !== 'person') return refuse('forbidden', 'Only a person’s own screen reads data this way.');
  const bindable = bindableTool(name);
  const described = TOOLS[name];
  if (bindable === undefined || described === undefined || described.kind !== 'read') return refuse('not_bindable', `“${name.slice(0, 60)}” is not a tool a screen can read from.`);
  if (ctx.toolSources.find(name) !== undefined || !ctx.runs.catalog().some((t) => t.name === name)) return refuse('unavailable', 'This data is not available in this deployment.');
  const parsed = bindable.args.safeParse(args);
  if (!parsed.success) return refuse('invalid_args', 'The screen asks for this data in a way the app does not accept.');
  const input = parsed.data as Record<string, unknown>;
  const caller = { actorId: tx.actor.id, kind: 'person' as const, workspaceId: tx.actor.workspaceId, personId: null, sessionId: null };
  try {
    const answer = await ctx.db.as(
      caller,
      async (own) => {
        const decision = await ctx.capabilities.authorize(own, name, {});
        if (!decision.allowed) return refuse('forbidden', 'You cannot read this data.');
        return { ok: true as const, data: await ctx.runs.invoke(own, name, input) };
      },
      { readOnly: true, statementTimeoutMs: VIEWER_READ_TIMEOUT_MS },
    );
    if (!answer.ok) return answer;
    const text = JSON.stringify(answer.data ?? null);
    if (text.length > SURFACE_BIND_RESULT_MAX_CHARS) return refuse('too_large', 'The answer is too large to show. Ask for fewer items.');
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === '57014') return refuse('timeout', 'The data took too long to read. Try again in a moment.');
    if (err instanceof HttpError) return refuse(err.status === 403 ? 'forbidden' : 'unavailable', err.message.slice(0, 300));
    if (err instanceof z.ZodError) return refuse('invalid_args', 'The screen asks for this data in a way the app does not accept.');
    faultLog(`gateway-mcp: a bound read of ${name} for a viewer failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
    return refuse('unavailable', 'The data is not available right now.');
  }
}
