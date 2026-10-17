import {
  authorizeContext,
  NoEligibleApproverError,
  type ApprovalProvider,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import type { GateVerdict } from './gate.ts';
import type { RunPayload } from './run-job.ts';
import { clip } from '@manythreads/shared';

/**
 * The model call a DLP hold stopped becomes a pending approval (source `dlp`, tool `llm.call`). What an approver sees is the rule names and the
 * **redacted** text; the original prompt travels only in the row's `resume`, and comes back to this plugin when the approval is approved
 * (`registerApprovalResume`). Without the approvals plugin the hold is a refusal: the call never leaves.
 */
export async function holdForApproval(
  ctx: PluginContext,
  tx: PluginTx,
  held: { run: { runId: string }; payload: RunPayload; alias: string; rules: readonly string[]; excerpt: string; approvers: readonly string[] },
): Promise<boolean> {
  const approvals = ctx.providers.get<ApprovalProvider>('approvals');
  if (!approvals) return false; // fail closed: the call is held and nobody can release it; the caller stops the run either way
  const resumable: Record<string, unknown> = { ...held.payload };
  delete resumable['approvalId']; // a held call has no approval yet; the claim adds the one that approves it
  try {
    await approvals.request(tx, {
    runId: held.run.runId,
    source: 'dlp',
    tool: 'llm.call',
    summary: clip(`Model call held · ${held.rules.join(', ')} found in the message`, 280),
    argsPreview: { alias: held.alias, rules: [...held.rules], message: clip(held.excerpt, 1500) },
    resume: { kind: 'handoff', payload: resumable },
    approvers: held.approvers,
    });
    return true;
  } catch (err) {
    // a private conversation where nobody else could decide it: not filed, so the call stays held and the run stops with the reason logged
    if (err instanceof NoEligibleApproverError) return false;
    throw err;
  }
}

/**
 * What an approver may read of a message the gate held: the message through the `pre_egress` chain under the `standard` rule, so a secret in it is
 * shown as `[redacted:api-key]`. With no guardrail loaded the text is not shown at all: a preview that cannot be made safe is left out.
 */
export async function previewText(ctx: PluginContext, tx: PluginTx, workspaceId: string, text: string): Promise<string> {
  const chain = await ctx.hooks.runPreEgress(tx, { destination: 'approval', workspaceId, text, preset: 'standard' });
  // The redaction is guardrails-dlp's: "some hook ran" is not "the one that redacts ran" (another guard registered at this point says nothing about secrets).
  return chain.ran.includes('guardrails-dlp') && chain.outcome !== 'block' ? chain.text : '[the message is not shown: it could not be checked for secrets]';
}

/**
 * A short, visible reply in the thread when the gate stopped a run and no approval card will explain it (a budget or rate limit, the approvals plugin
 * absent, nobody but the asker able to decide in a private conversation): without it the asker sees a bot that never answers. It says what happened and
 * nothing about why — no gate entry, no limit figures, none of the message. Posted as the bot, through the same broker door as its reply, so a bot that was
 * never granted `messages.post` stays silent (and the log says so).
 */
export async function postNotice(
  ctx: PluginContext,
  run: Parameters<PluginContext['runs']['authorize']>[0],
  payload: RunPayload,
  body: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    const args = { channelId: payload.channelId, body, threadRootId: payload.replyRootId };
    const decision = await ctx.runs.authorize(run, 'messages.post', authorizeContext(args));
    if (!decision.allowed) {
      log(`runtime-hermes: run ${run.runId}: no notice posted (${decision.reason})`);
      return;
    }
    await ctx.runs.asBot(run, (inner) => ctx.runs.invoke(inner, 'messages.post', args));
  } catch (err) {
    log(`runtime-hermes: run ${run.runId}: the notice could not be posted: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A message the gate stopped becomes a pending approval (source `dlp` — "held by the guard" — tool `llm.gate`; the closest of the four sources
 * SPEC §7.3 names: the gate is the bot's own Guard section deciding that a model call waits for a person, as the DLP hold is). The approver sees
 * the stage, the gate entry that matched (when one did) and the redacted message; the payload that resumes the run travels only in the row's
 * `resume`. Approving puts the run back with the gate switched off for exactly that message. Without the approvals plugin the hold is a
 * refusal: the message never reaches a model.
 */
export async function holdForGate(
  ctx: PluginContext,
  tx: PluginTx,
  held: { run: { runId: string }; payload: RunPayload; hold: Extract<GateVerdict, { kind: 'hold' }>; excerpt: string; approvers: readonly string[] },
): Promise<string | null> {
  const approvals = ctx.providers.get<ApprovalProvider>('approvals');
  if (!approvals) return null; // fail closed: nobody can release it; the caller stops the run either way
  const resumable: Record<string, unknown> = { ...held.payload, gateHold: true };
  delete resumable['approvalId'];
  delete resumable['gateApprovalId'];
  const why =
    held.hold.stage === 'classifier_unavailable'
      ? 'the gate could not check this message'
      : held.hold.entry !== null
        ? `matched “${clip(held.hold.entry, 60)}”`
        : 'the local classifier flagged a gate topic';
  try {
    const filed = await approvals.request(tx, {
      runId: held.run.runId,
      source: 'dlp',
      tool: 'llm.gate',
      summary: clip(`Message held by the gate · ${why}`, 280),
      argsPreview: {
        stage: held.hold.stage,
        ...(held.hold.entry !== null ? { entry: clip(held.hold.entry, 200) } : {}),
        reason: clip(held.hold.detail, 300),
        message: clip(held.excerpt, 1500),
      },
      resume: { kind: 'handoff', payload: resumable },
      approvers: held.approvers,
    });
    return filed.approvalId;
  } catch (err) {
    // a private conversation where nobody else could decide it: not filed, so the message stays held and the run stops with the reason logged
    if (err instanceof NoEligibleApproverError) return null;
    throw err;
  }
}
