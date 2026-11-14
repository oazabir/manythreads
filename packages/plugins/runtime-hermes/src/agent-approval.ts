import { createHash } from 'node:crypto';
import { NoEligibleApproverError, type ApprovalProvider, type BotRunHandle, type BotRuntimeEvent, type JobInfo, type PluginContext } from '@manythreads/sdk';
import { previewText } from './holds.ts';

/*
 * The bot's own program stopped to ask a person (P24-02). Hermes pauses a run when its shell wants to run a command it thinks is risky and waits, inside the run, for
 * an answer. Nothing used to answer it: the run sat until Hermes gave up (five minutes) and the command was refused, the bot saying "blocked, waiting for approval".
 *
 * Now the question becomes an approval of source `agent` — the card in the thread and the line in the team's Approvals — and the run waits for a person. When one
 * decides, the answer is passed to the program (`once` or `deny`, with what the person wrote), and the run goes on. Nothing is run by the platform: the program runs
 * its own command, as it would have, only when a person said so.
 */

/** How long a run waits for a person before the command is refused ("silence is not consent"). Hermes' own wait (`approvals.timeout`, profile.ts) is longer, so this ends first. */
export const AGENT_APPROVAL_WAIT_MS = 30 * 60 * 1000;
/** How often the approval is looked at, and how often the run's endpoint is kept alive while it waits. */
const POLL_MS = 3000;
const KEEP_ALIVE_MS = 60_000;
/** The endpoint of the run stays usable this long past each look: the tools of the run must still answer once the person has decided. */
const KEEP_ALIVE_SECONDS = 15 * 60;

type Question = Extract<BotRuntimeEvent, { type: 'approval' }>;

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How much of the command or the plan the card keeps: the bridge sends up to about 2000 characters, ending in a cut mark when it was longer. */
export const COMMAND_PREVIEW_CHARS = 2100;

/** One line of what is asked for the list: its first line, clipped. A plan to approve (Codex asks to leave plan mode) is not "a command". */
export function commandSummary(command: string, kind?: string): string {
  const first = (command.split('\n').find((l) => l.trim() !== '') ?? command).replace(/\s+/g, ' ').trim();
  return `${kind === 'switch_mode' ? 'Approve a plan' : 'Run a command'}: ${clip(first, 200)}`;
}

export interface AgentApprovalInput {
  ctx: PluginContext;
  job: Pick<JobInfo, 'log' | 'transaction'>;
  run: BotRunHandle;
  question: Question;
  approvers: readonly string[];
  /** True once the person who asked pressed Stop: the wait ends and the command is refused. */
  stopped?: () => boolean;
  /** For a test: how long to wait for a person, and how often to look. */
  waitMs?: number;
  pollMs?: number;
}

/**
 * Files the question, waits for a person, and answers the program. Never throws: whatever goes wrong, the program is told "deny" so the run can end by itself.
 * Returns what the program was told.
 */
export async function settleAgentApproval(input: AgentApprovalInput): Promise<'once' | 'session' | 'deny'> {
  const { ctx, job, run, question } = input;
  const log = (line: string): void => job.log.info(`runtime-hermes: run ${run.runId}: ${line}`);
  const answer = async (choice: 'once' | 'session' | 'deny', note: string): Promise<'once' | 'session' | 'deny'> => {
    const delivered = await question.answer(choice, note).catch(() => false);
    if (!delivered) log(`the answer (${choice}) could not be delivered: the program no longer waits`);
    return choice;
  };
  try {
    const approvals = ctx.providers.get<ApprovalProvider>('approvals');
    if (!approvals) return await answer('deny', 'Nobody can approve commands here, so it was not run.');

    // What an approver reads of the command goes through the same redaction as any text that leaves for a person (a key-like string is shown as [redacted:...]).
    const shown = await job.transaction((tx) => previewText(ctx, tx, run.workspaceId, question.command));
    let approvalId: string;
    try {
      const filed = await ctx.runs.asBot(run, (tx) =>
        approvals.request(tx, {
          runId: run.runId,
          source: 'agent',
          tool: 'agent.command',
          summary: commandSummary(shown, question.kind),
          argsPreview: { command: clip(shown, COMMAND_PREVIEW_CHARS), why: clip(question.description, 300) },
          argsTruncated: shown.length > COMMAND_PREVIEW_CHARS,
          resume: { kind: 'handoff', payload: { kind: 'command', runId: run.runId } },
          approvers: input.approvers,
          dedupeKey: `agent.command:${createHash('sha256').update(question.command).digest('hex').slice(0, 24)}`,
        }),
      );
      approvalId = filed.approvalId;
    } catch (err) {
      if (err instanceof NoEligibleApproverError) return await answer('deny', 'Nobody in this conversation can approve a command, so it was not run. Say what you need instead.');
      throw err;
    }
    log(`waiting for a person to decide approval ${approvalId} (a command the program wants to run)`);

    const waitMs = input.waitMs ?? AGENT_APPROVAL_WAIT_MS;
    const pollMs = input.pollMs ?? POLL_MS;
    const startedAt = Date.now();
    let lastKeepAlive = 0;
    for (;;) {
      if (Date.now() - lastKeepAlive >= KEEP_ALIVE_MS) {
        lastKeepAlive = Date.now();
        await ctx.runs.extend(run.runId, KEEP_ALIVE_SECONDS).catch(() => false);
      }
      // The program ended the question itself (the bridge cuts its wait and says so): nobody waits for an answer any more, so the run goes on with it refused.
      const ended = question.expired?.() ?? null;
      if (ended !== null) {
        log(`the program ended the question itself: ${ended}`);
        return 'deny';
      }
      const state = await job.transaction((tx) => approvals.answerOf(tx, approvalId, { botId: run.botId }));
      if (state === null) return await answer('deny', 'The approval could not be found, so the command was not run.');
      if (state.status === 'approved') {
        const told = await answer('once', state.note);
        await job.transaction((tx) => approvals.claim(tx, approvalId, { botId: run.botId, source: 'agent' })).catch(() => null);
        return told;
      }
      if (state.status === 'denied') return await answer('deny', state.note);
      if (state.status === 'expired') return await answer('deny', 'The approval expired without an answer, so the command was not run.');
      if (input.stopped?.() === true) return await answer('deny', 'The run was stopped.');
      if (Date.now() - startedAt >= waitMs) return await answer('deny', 'Nobody answered in time, so the command was not run.');
      await sleep(pollMs);
    }
  } catch (err) {
    job.log.warn(`runtime-hermes: run ${run.runId}: the approval of a command failed: ${err instanceof Error ? err.message : String(err)}`);
    return await answer('deny', 'The question could not be put to a person, so the command was not run.');
  }
}
