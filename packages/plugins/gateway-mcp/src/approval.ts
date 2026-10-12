import { requestToolApproval, type BotRunHandle, type PluginContext } from '@manythreads/sdk';
import type { ToolKind } from './catalog.ts';

// A call whose grant says `needsApproval` (SPEC §7.3) does not run: it becomes a pending approval in the Approvals inbox, through the approvals
// plugin's one handler (`requestToolApproval` in the SDK), and the model is told so in the tool's own answer. Approving later re-runs exactly
// this call once, as the bot, with the arguments stored here. If the approvals plugin is not loaded the call is refused, as it was before the
// plugin existed — running a call the grant says a person must approve is the one thing the flag exists to stop.
//
// A *read* never waits: it runs as the person who asked (their visibility decides the rows), and a re-run after approval would run it as the bot.
// Waiting is for tools that act; a read flagged `needsApproval` is refused with a sentence saying so.

export type ApprovalAnswer =
  | { ok: false; code: 'approval_pending'; approvalId: string; message: string }
  | { ok: false; code: 'approval_required'; message: string };

export async function askForApproval(
  ctx: PluginContext,
  run: BotRunHandle,
  tool: string,
  kind: ToolKind,
  input: Record<string, unknown>,
): Promise<ApprovalAnswer | { ok: false; code: 'forbidden'; message: string }> {
  if (kind === 'read') {
    return { ok: false, code: 'forbidden', message: `“${tool}” only reads, so it cannot wait for an approval; ask a lead to remove needsApproval from it.` };
  }
  const filed = await requestToolApproval(ctx, run, tool, input);
  if (!filed) return { ok: false, code: 'approval_required', message: 'This call needs a person’s approval before it runs.' };
  // nobody but the asker could decide it in a private conversation: it was not filed, and the model says so
  if ('refused' in filed) return { ok: false, code: 'forbidden', message: filed.refused };
  const where =
    filed.visibleTo === 'conversation'
      ? 'it is now waiting for the people who can read this conversation and are allowed to decide it (it is not in the whole team’s Approvals inbox)'
      : 'it is now waiting in the team’s Approvals inbox';
  return {
    ok: false,
    code: 'approval_pending',
    approvalId: filed.approvalId,
    message: `This call did not run: it needs a person’s approval, and ${where}. Tell the person it is waiting; do not call it again. Once approved it runs once, as you, with these arguments.`,
  };
}
