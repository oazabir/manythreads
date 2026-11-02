import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ProposalId, TeamId, WorkshopSessionId } from '../ids.ts';

// The Workshop tab of a bot (PLAN P7-05, P7-06, SPEC section 9): one persistent conversation per mode, owned by one person.
//   build    changes to the bot become proposals (a diff a person approves); a correction becomes a lesson, an eval case and, when it repeats, a rule;
//   rehearse the bot's own prompt, knowledge and read tools in a sandbox: every write is held back by the platform and shown as "not really done";
//   live     questions about the bot's real runs, read from the run records the asker may see.
// Nothing here changes a bot. Everything that would is a proposal that waits for Approve (docs/plugins/proposals.md).

export const WORKSHOP_MODES = ['build', 'rehearse', 'live'] as const;
export const WorkshopMode = z.enum(WORKSHOP_MODES);
export type WorkshopMode = z.infer<typeof WorkshopMode>;

/** `working` the helper (or the rehearsed bot) is answering; `ready` it waits for the person; `ended` the person closed it; `failed` it stopped (the message says why); `cancelled` stopped while working. */
export const WORKSHOP_STATUSES = ['working', 'ready', 'ended', 'failed', 'cancelled'] as const;
export const WorkshopStatus = z.enum(WORKSHOP_STATUSES);
export type WorkshopStatus = z.infer<typeof WorkshopStatus>;

/** Open conversations (working or ready) one person may have in all bots at once. */
export const WORKSHOP_MAX_OPEN = 3;
/** Messages one person may send in one conversation (its rounds). */
export const WORKSHOP_MAX_MESSAGES = 30;
/** Model calls the helper (or the rehearsed bot) may make to answer one message. */
export const WORKSHOP_MAX_STEPS = 8;
export const WORKSHOP_MESSAGE_MAX = 2000;
/** Entries kept in one conversation; a longer one stops accepting messages. */
export const WORKSHOP_MAX_ENTRIES = 200;

/** What a platform badge says next to a write the sandbox held back. */
export const NOT_REALLY_DONE = 'not really done';

/** What became of a tool call: read (it ran, read only), held (a write the sandbox did not do), refused (not allowed or not there), failed, ok (a helper tool answered). */
export const WORKSHOP_STEP_OUTCOMES = ['read', 'held', 'refused', 'failed', 'ok'] as const;
export const WorkshopStepOutcome = z.enum(WORKSHOP_STEP_OUTCOMES);
export type WorkshopStepOutcome = z.infer<typeof WorkshopStepOutcome>;

/** What a filed proposal is for. `bot` a change to BOT.md; `lessons` a line in lessons.md; `eval` a case in the scenario set; `rule` a rule in the bot's instructions; `compaction` a shorter lessons.md; `evals_block` the line in BOT.md that names the scenario set. */
export const WORKSHOP_PROPOSAL_ROLES = ['bot', 'lessons', 'eval', 'rule', 'compaction', 'evals_block'] as const;
export const WorkshopProposalRole = z.enum(WORKSHOP_PROPOSAL_ROLES);
export type WorkshopProposalRole = z.infer<typeof WorkshopProposalRole>;

const EntryBase = { id: z.string().regex(/^e[0-9]{1,4}$/), at: IsoDateTime };

export const WorkshopEntry = z.discriminatedUnion('kind', [
  z.object({
    ...EntryBase,
    kind: z.literal('person'),
    text: z.string().max(WORKSHOP_MESSAGE_MAX),
    /** The reply of a Rehearse conversation this message is about ("Correct this reply"), read by the server from that conversation. */
    about: z.object({ sessionId: WorkshopSessionId, entryId: z.string(), excerpt: z.string().max(600) }).optional(),
  }),
  /** What the helper said (Build, Live) or what the rehearsed bot answered (Rehearse: `rehearsal` is true, and the reply is a test). */
  z.object({ ...EntryBase, kind: z.literal('reply'), text: z.string().max(12_000), rehearsal: z.boolean() }),
  /** One tool call. `what` is a short plain description of where it aimed, never the content of a write. `badge` is `not really done` for a held write. */
  z.object({
    ...EntryBase,
    kind: z.literal('step'),
    tool: z.string().max(100),
    what: z.string().max(300),
    outcome: WorkshopStepOutcome,
    badge: z.string().max(40).nullable(),
  }),
  z.object({ ...EntryBase, kind: z.literal('proposal'), proposalId: ProposalId, path: z.string().max(300), role: WorkshopProposalRole, title: z.string().max(300) }),
  /** A lesson or a change the platform refused, in one plain sentence. */
  z.object({ ...EntryBase, kind: z.literal('refusal'), text: z.string().max(600) }),
  z.object({ ...EntryBase, kind: z.literal('notice'), text: z.string().max(600) }),
]);
export type WorkshopEntry = z.infer<typeof WorkshopEntry>;

/** What a conversation has cost, counted from the model calls it made. A rehearsal's lines in the spend ledger are labelled `rehearsal:<conversation>`. */
export const WorkshopUsage = z.object({
  calls: z.number().int().min(0),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  label: z.enum(['rehearsal', 'workshop']),
});
export type WorkshopUsage = z.infer<typeof WorkshopUsage>;

export const WorkshopSession = z.object({
  id: WorkshopSessionId,
  teamId: TeamId,
  botSlug: z.string(),
  mode: WorkshopMode,
  status: WorkshopStatus,
  /** The first words the person wrote, shortened; the list of earlier conversations shows it. */
  title: z.string(),
  entries: z.array(WorkshopEntry),
  /** Messages the person has sent, out of `WORKSHOP_MAX_MESSAGES`. */
  messageCount: z.number().int().min(0),
  usage: WorkshopUsage,
  /** The one plain sentence of a failure; null otherwise. */
  message: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkshopSession = z.infer<typeof WorkshopSession>;

export const WorkshopSessionSummary = WorkshopSession.pick({ id: true, mode: true, status: true, title: true, messageCount: true, updatedAt: true });
export type WorkshopSessionSummary = z.infer<typeof WorkshopSessionSummary>;
