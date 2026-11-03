import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ProposalId, SetupSessionId, TeamId } from '../ids.ts';

// Self-setup (PLAN P7-02 to P7-04, SPEC section 9): a person describes a bot in plain words, a setup helper looks at what the team has, grades each
// thing the brief needs, asks one question per gap and proposes the bot's files as proposals. Nothing here is a bot: the helper has no actor of its
// own and grants nothing. These are the shapes the screen, the routes and the helper's tools share.

/**
 * How one requirement of the brief stands against what the team has:
 *  - `covered`   the team has it and the bot may simply be given it (a tool that is not dangerous, a knowledge base, a runner the team may use);
 *  - `grantable` it exists and a person with enough standing can switch it on, which is part of what is approved (a dangerous tool the bot must ask a person to use, a shell the team allows);
 *  - `missing`   the team does not have it yet (an email connection, a knowledge base, a skill nobody wrote): someone has to add it first;
 *  - `blocked`   the team's rules do not allow it for this person or at all (a shell the team has not allowed, a runner the team may not use);
 *  - `unclear`   the brief does not say enough to tell, or names something that does not exist here: the person is asked.
 */
export const GRADES = ['covered', 'grantable', 'missing', 'blocked', 'unclear'] as const;
export const Grade = z.enum(GRADES);
export type Grade = z.infer<typeof Grade>;

/** A grade the person has to do something about: the helper asks one question for each. */
export const GAP_GRADES: readonly Grade[] = ['missing', 'blocked', 'unclear'];
export const isGap = (grade: Grade): boolean => GAP_GRADES.includes(grade);

/** What kind of thing a requirement asks for; the grader looks it up in the matching part of the team's inventory. */
export const REQUIREMENT_KINDS = ['capability', 'runtime', 'connection', 'knowledge', 'skill', 'runner', 'trigger', 'model', 'other'] as const;
export const RequirementKind = z.enum(REQUIREMENT_KINDS);
export type RequirementKind = z.infer<typeof RequirementKind>;

export const SETUP_MAX_REQUIREMENTS = 20;
export const SETUP_MAX_QUESTIONS = 12;
export const SETUP_BRIEF_MIN = 8;
export const SETUP_BRIEF_MAX = 4000;
export const SETUP_ANSWER_MAX = 1000;
/** How many times one conversation may go back to the person with questions. */
export const SETUP_MAX_ROUNDS = 6;

const RequirementId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'lower case letters, digits, "-" or "_", at most 40');

/** One thing the brief needs, as the helper wrote it. `name` is what to look up (a tool name, a knowledge base slug, a runner name, a trigger type). */
export const SetupRequirement = z.strictObject({
  id: RequirementId,
  text: z.string().trim().min(1).max(300),
  kind: RequirementKind,
  name: z.string().trim().min(1).max(120).optional(),
});
export type SetupRequirement = z.infer<typeof SetupRequirement>;

/** A requirement with the grade the platform (not the model) gave it, and the reason in plain words. */
export const GradedRequirement = SetupRequirement.extend({ grade: Grade, reason: z.string().max(500) });
export type GradedRequirement = z.infer<typeof GradedRequirement>;

/** One question for one gap. The person answers with one of the offered options or in their own words. */
export const SetupQuestion = z.object({
  id: z.string().regex(/^q[0-9]{1,3}$/),
  requirementId: RequirementId,
  question: z.string().max(400),
  options: z.array(z.string().max(80)).max(4),
});
export type SetupQuestion = z.infer<typeof SetupQuestion>;

export const SetupAnswer = z.object({ questionId: z.string(), requirementId: RequirementId, question: z.string().max(400), answer: z.string().max(SETUP_ANSWER_MAX) });
export type SetupAnswer = z.infer<typeof SetupAnswer>;

/** The part a person's role plays in what may be granted. `admin` is a workspace owner or admin. */
export const SetupAskerRole = z.enum(['member', 'lead', 'admin']);
export type SetupAskerRole = z.infer<typeof SetupAskerRole>;

/**
 * What `describe_self` tells the helper: the team's inventory as the person who asked may see it. Names and counts only. It never holds an address, a key,
 * a token, the text of a message or anything of another team.
 */
export const SetupInventory = z.object({
  team: z.object({ slug: z.string(), name: z.string() }),
  asker: z.object({
    role: SetupAskerRole,
    /** May switch on a tool that can do harm (it still waits for a person each time it is used). */
    canGrantDestructive: z.boolean(),
    /** May approve the bot being added (only a workspace admin may). */
    canAddBot: z.boolean(),
  }),
  bots: z.array(z.object({ slug: z.string(), name: z.string(), role: z.string(), kind: z.string(), runtime: z.string(), status: z.string() })).max(100),
  knowledge: z.array(z.object({ slug: z.string(), name: z.string() })).max(100),
  skills: z.array(z.object({ slug: z.string() })).max(100),
  runners: z.array(z.object({ name: z.string(), label: z.string(), kind: z.string(), status: z.string(), isDefault: z.boolean() })).max(50),
  models: z.array(z.object({ alias: z.string() })).max(8),
  channels: z.array(z.object({ name: z.string() })).max(100),
  roleTags: z.array(z.string()).max(50),
  capabilities: z.array(z.object({ name: z.string(), destructive: z.boolean() })).max(300),
  triggers: z.array(z.object({ type: z.string(), available: z.boolean(), note: z.string().optional() })).max(20),
  /** The runtime tools (`shell`, `files`, `browser`, ...) this team allows its bots, from the `defaults.botRuntime` key of TEAM.md. Empty: none. */
  runtimeAllowed: z.array(z.string()).max(20),
  /** The guard preset every bot of the team starts from, from `defaults.guardPreset` of TEAM.md (`standard` when it says nothing). */
  guardDefault: z.string(),
  /** Connections to other apps (a mailbox, a CRM). The helper cannot give a bot one yet, so the list is empty; the note says so, so the helper does not invent one. */
  connections: z.array(z.object({ name: z.string(), tools: z.array(z.string()).max(50) })).max(50),
  connectionsNote: z.string(),
});
export type SetupInventory = z.infer<typeof SetupInventory>;

export const SETUP_STATUSES = ['working', 'asking', 'proposed', 'failed', 'cancelled'] as const;
/** `working` the helper is thinking; `asking` it waits for answers; `proposed` the files are filed as proposals; `failed` it could not go on (the message says why). */
export const SetupStatus = z.enum(SETUP_STATUSES);
export type SetupStatus = z.infer<typeof SetupStatus>;

/** A proposal the helper filed: the bot's definition is `bot`; a skill or the team file that goes with it are the others. */
export const SetupProposalRef = z.object({
  proposalId: ProposalId,
  path: z.string(),
  role: z.enum(['bot', 'skill', 'team']),
  title: z.string(),
});
export type SetupProposalRef = z.infer<typeof SetupProposalRef>;

export const SetupSession = z.object({
  id: SetupSessionId,
  teamId: TeamId,
  status: SetupStatus,
  brief: z.string(),
  name: z.string().nullable(),
  /** Every requirement the helper has listed, as the platform graded them (the latest grading of each). */
  requirements: z.array(GradedRequirement),
  /** The questions waiting for an answer (empty unless `asking`). */
  questions: z.array(SetupQuestion),
  /** Questions already answered, oldest first. */
  answers: z.array(SetupAnswer),
  inventory: SetupInventory.nullable(),
  proposals: z.array(SetupProposalRef),
  /** What the bot will not be able to do, written when the proposal is made. */
  limits: z.array(z.string().max(400)),
  /** What the helper last said in words (a short summary), or the one plain sentence of a failure; null before it has said anything. */
  message: z.string().nullable(),
  /** The helper's rounds used so far (each time it went back to the person), out of `SETUP_MAX_ROUNDS`. */
  rounds: z.number().int().min(0),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SetupSession = z.infer<typeof SetupSession>;
