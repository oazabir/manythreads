import { createHash } from 'node:crypto';
import type { ApprovalProvider, BotRunHandle, PluginContext } from '@manythreads/sdk';
import { BotRunTrigger, approvalSummary, previewArgs } from '@manythreads/shared';

// A call whose grant says `needsApproval` (SPEC §7.3) does not run: it becomes a pending approval in the Approvals inbox, through the approvals
// plugin's one handler, and the model is told so in the tool's own answer. Approving later re-runs exactly this call once, as the bot, with the
// arguments stored here. If the approvals plugin is not loaded the call is refused, as it was before the plugin existed — running a call the
// grant says a person must approve is the one thing the flag is there to stop.

/** Arguments in a stable text form, so asking twice for the same thing is one approval (`dedupeKey`). */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(record[k])}`)
    .join(',')}}`;
}

export type ApprovalAnswer =
  | { ok: false; code: 'approval_pending'; approvalId: string; message: string }
  | { ok: false; code: 'approval_required'; message: string };

export async function askForApproval(
  ctx: PluginContext,
  run: BotRunHandle,
  tool: string,
  input: Record<string, unknown>,
): Promise<ApprovalAnswer> {
  const approvals = ctx.providers.get<ApprovalProvider>('approvals');
  if (!approvals) return { ok: false, code: 'approval_required', message: 'This call needs a person’s approval before it runs.' };
  const dedupeKey = createHash('sha256').update(`${tool}\n${stable(input)}`).digest('hex');
  const { approvalId } = await ctx.runs.asBot(run, (tx) =>
    approvals.request(tx, {
      runId: run.runId,
      source: 'grant',
      tool,
      summary: approvalSummary(tool, input),
      argsPreview: previewArgs(input),
      resume: { kind: 'tool', capability: tool, args: input, trigger: BotRunTrigger.parse(run.trigger) },
      dedupeKey,
    }),
  );
  return {
    ok: false,
    code: 'approval_pending',
    approvalId,
    message:
      'This call did not run: it needs a person’s approval, and it is now waiting in the team’s Approvals inbox. Tell the person it is waiting; do not call it again. Once approved it runs once, as you, with these arguments.',
  };
}
