import { createHash } from 'node:crypto';
import { NoEligibleApproverError, type ApprovalProvider, type PluginContext } from '@manythreads/sdk';
import { matchHandle, type HandleSubject } from '@manythreads/shared';

/*
 * `approvals.ask` (P24-03): the one tool every bot has, whatever runtime runs it (Hermes, Claude, Codex…), for "I need a person to say yes or no before I go on".
 * It files an approval of source `agent` — the card in the thread and the line in the team's Approvals — and answers at once; the bot ends its turn. When a person
 * decides, the runtime wakes the bot in the same thread with the answer (the decided event; runtime-hermes `registerAskAnswer`). The bot is never left waiting on a
 * prompt of its own program that nothing shows to anyone.
 */

export const ASK_TOOL = 'approvals.ask';

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * What a person reads of an ask is the whole of it: the question and its details are stored in the approval's preview as the bot wrote them (line breaks kept), up to these
 * bounds, not at the 300 characters the generic call preview keeps. The list line (`summary`) is still one short line. A bot that writes more than this is clipped with a "…",
 * and the card says the end is not kept (there is no longer copy to open: an ask stores no call).
 */
export const ASK_QUESTION_MAX = 4_000;
export const ASK_DETAILS_MAX = 20_000;
const tidy = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** At most this many names in one question's `approvers`. */
export const ASK_APPROVERS_MAX = 10;
const ROLE = /^role:[a-z][a-z0-9-]*$/;
const PERSON = /^person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who could decide a question asked in this run: the team's members who can read where it was asked, and the role tags they hold. */
export interface AskCandidates {
  people: readonly HandleSubject[];
  /** Role tag name (`role:on-call`) to the ids of the candidates holding it. */
  roles: ReadonlyMap<string, readonly string[]>;
}

/**
 * The `approvers` a bot named (owner 2026-11-19: "this change needs Nadia's permission"), as the principals an approval stores: `@handle` (or a bare handle)
 * and `person:<id>` name one person, `role:<tag>` everyone holding the tag. Each one must be somebody who can read the conversation and decide for the team,
 * so a card never waits on a person who cannot see it or press it; only members of the team (they are the ones its card names and its pushes reach); a name that matches nobody, or more than one person, is refused with a sentence, never guessed.
 */
export function resolveApprovers(raw: unknown, candidates: AskCandidates): { ok: true; principals: string[]; names: string[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ASK_APPROVERS_MAX || raw.some((x) => typeof x !== 'string')) {
    return { ok: false, message: `approvers: a list of 1 to ${String(ASK_APPROVERS_MAX)} names (@handle, or role:<tag>). Leave it out to let the team's usual approvers decide.` };
  }
  const principals: string[] = [];
  const names: string[] = [];
  const add = (principal: string, name: string): void => {
    if (principals.includes(principal)) return;
    principals.push(principal);
    names.push(name);
  };
  for (const entry of raw as string[]) {
    const word = entry.trim();
    if (ROLE.test(word)) {
      if ((candidates.roles.get(word) ?? []).length === 0) return { ok: false, message: `approvers: nobody who can read this conversation holds ${word}.` };
      add(word, word);
      continue;
    }
    if (PERSON.test(word)) {
      const person = candidates.people.find((c) => c.id === word.slice(7));
      if (!person) return { ok: false, message: `approvers: ${word} is not someone who can read this conversation and decide for the team.` };
      add(word, person.displayName);
      continue;
    }
    const handle = word.replace(/^@/, '');
    const id = handle === '' ? null : matchHandle(handle, candidates.people);
    if (id === null) return { ok: false, message: `approvers: nobody who can read this conversation and decide for the team answers to @${handle}, or more than one person does. Use their full handle.` };
    add(`person:${id}`, candidates.people.find((c) => c.id === id)?.displayName ?? `@${handle}`);
  }
  return { ok: true, principals, names };
}

/** The candidates of a run, read as the system: the bot itself may not read the people of a private conversation, and must not need to. */
async function candidatesOf(ctx: PluginContext, runId: string): Promise<AskCandidates> {
  return ctx.db.system(async (tx) => {
    const people = (
      await tx.query<{ id: string; display_name: string; email: string }>(
        `SELECT pe.id, pe.display_name, pe.primary_email AS email
           FROM app.bot_runs r
           JOIN app.people pe ON pe.workspace_id = r.workspace_id AND pe.status = 'active'
           JOIN app.workspace_members wm ON wm.person_id = pe.id AND wm.workspace_id = r.workspace_id AND wm.role <> 'guest'
           JOIN app.actors k ON k.kind = 'person' AND k.ref_id = pe.id AND k.workspace_id = r.workspace_id
           JOIN app.team_members tm ON tm.team_id = r.team_id AND tm.actor_id = k.id
           LEFT JOIN app.channels c ON c.id = r.channel_id
          WHERE r.id = $1::uuid
            AND (c.id IS NULL OR NOT coalesce(c.private, false)
                 OR EXISTS (SELECT 1 FROM app.channel_members cm WHERE cm.channel_id = c.id AND cm.person_id = pe.id))`,
        [runId],
      )
    ).rows;
    const ids = people.map((p) => p.id);
    const held = ids.length === 0 ? [] : (
      await tx.query<{ name: string; person_id: string }>(
        `SELECT r.name, rm.person_id FROM app.role_members rm JOIN app.roles r ON r.id = rm.role_id AND r.workspace_id = rm.workspace_id WHERE rm.person_id = ANY ($1::uuid[])`,
        [ids],
      )
    ).rows;
    const roles = new Map<string, string[]>();
    for (const h of held) roles.set(h.name, [...(roles.get(h.name) ?? []), h.person_id]);
    return { people: people.map((p) => ({ id: p.id, displayName: p.display_name, email: p.email })), roles };
  });
}

export function registerAsk(ctx: PluginContext, approvals: ApprovalProvider): void {
  ctx.capabilities.register(ASK_TOOL, async (input, tx) => {
    const askedQuestion = typeof input['question'] === 'string' ? tidy(input['question']) : '';
    const askedDetails = typeof input['details'] === 'string' ? tidy(input['details']) : '';
    // the one-line form the list and the dedupe key use
    const question = askedQuestion.replace(/\s+/g, ' ');
    const details = askedDetails;
    if (question.length < 3) return { ok: false, code: 'invalid_input', message: 'question: say, in one sentence, what you need a person to decide.' };
    // the run the call was made in: the transaction carries it (`app.run_id()`), so a bot cannot name another run
    const runId = (await tx.query<{ id: string | null }>('SELECT app.run_id()::text AS id')).rows[0]?.id ?? null;
    if (!runId) return { ok: false, code: 'no_open_run', message: 'Asking works only while you are answering a message.' };
    let named: { principals: string[]; names: string[] } | null = null;
    if (input['approvers'] !== undefined && input['approvers'] !== null) {
      const resolved = resolveApprovers(input['approvers'], await candidatesOf(ctx, runId));
      if (!resolved.ok) return { ok: false, code: 'invalid_input', message: resolved.message };
      named = resolved;
    }
    const truncated = askedQuestion.length > ASK_QUESTION_MAX || details.length > ASK_DETAILS_MAX;
    const preview = { question: clip(askedQuestion, ASK_QUESTION_MAX), ...(details === '' ? {} : { details: clip(details, ASK_DETAILS_MAX) }) };
    try {
      const filed = await approvals.request(tx, {
        runId,
        source: 'agent',
        tool: ASK_TOOL,
        summary: clip(question, 300),
        argsPreview: preview,
        argsTruncated: truncated,
        resume: { kind: 'handoff', payload: { kind: 'ask', runId } },
        // the same question for other deciders is a question of its own
        dedupeKey: `ask:${createHash('sha256').update(named === null ? question : `${question}\u0000${[...named.principals].sort().join(',')}`).digest('hex').slice(0, 24)}`,
        ...(named === null ? {} : { approvers: named.principals }),
      });
      const where = filed.visibleTo === 'conversation' ? 'to the people who can read this conversation' : 'to the team’s Approvals and to this thread';
      const who = named === null ? '' : ` Only ${named.names.join(', ')} can answer it; mention them in your line so they see it.`;
      return {
        ok: true,
        approvalId: filed.approvalId,
        message: `Asked ${where}.${who} Do not wait and do not ask again: end your turn now with one short line saying what you are waiting for. When a person answers, you are woken in this thread with the answer (yes or no, and what they wrote).`,
      };
    } catch (err) {
      if (err instanceof NoEligibleApproverError) return { ok: false, code: 'no_approver', message: err.message };
      throw err;
    }
  });
}
