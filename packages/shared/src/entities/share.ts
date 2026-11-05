import { z } from 'zod';
import { CronExpression } from './scheduled-job.ts';
import { parseCron } from '../common/cron.ts';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ApprovalId, TeamId, WorkspaceId } from '../ids.ts';
import { OkfTrustTier } from '../okf/concept.ts';

// Memory sharing between teams, the sending half (SPEC §12.3, PLAN P8-22, P8-23). A **share** is a file, `routines/shares/<slug>.yaml`, that a team lead or a
// workspace admin writes: which of the team's memory goes to which other teams, in what form, and how often. The platform (not a model) picks the concepts,
// builds a digest (a small OKF bundle: an index, a log, a summary and, in `full` mode, copies of the concepts), checks it and asks a person to approve it.
// Every enum here matches a CHECK of the memory-share plugin's migration 0001_memory_share.sql and is listed in the kernel's schema-enums map.

export const ShareId = z.uuid().brand<'ShareId'>();
export type ShareId = z.infer<typeof ShareId>;
export const ShareLinkId = z.uuid().brand<'ShareLinkId'>();
export type ShareLinkId = z.infer<typeof ShareLinkId>;
export const ShareRunId = z.uuid().brand<'ShareRunId'>();
export type ShareRunId = z.infer<typeof ShareRunId>;
/** One digest handed to one destination team (a row of `memory_share_deliveries`). */
export const ShareDeliveryId = z.uuid().brand<'ShareDeliveryId'>();
export type ShareDeliveryId = z.infer<typeof ShareDeliveryId>;

/** A share's name in the repo: the file name without `.yaml`. Same shape as a team slug. */
export const SHARE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ShareSlug = z.string().regex(SHARE_SLUG_RE, 'lowercase letters, digits and dashes');
export type ShareSlug = z.infer<typeof ShareSlug>;

/** The place a share's definition lives, `routines/shares/<slug>.yaml`. */
export const SHARE_FILE_RE = /^routines\/shares\/([a-z0-9][a-z0-9-]{0,62})\.yaml$/;
export const shareFilePath = (slug: string): string => `routines/shares/${slug}.yaml`;

/** The vocabulary of the `approvers` list: `role:<tag>` (a role tag; `role:lead` is the team's leads) or `person:<id>`. */
const SharePrincipal = z.string().regex(/^(role:[a-z][a-z0-9-]*|person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, 'role:<tag> or person:<id>');

/** A folder or file under `memory/`: no climbing out, no absolute path, nothing the repo would refuse. */
const SharePath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((p) => !p.includes('\\') && !p.includes('\0') && !p.split('/').some((s) => s === '..' || s === '.'), 'a path inside memory/, without ".." or backslashes');

/** What a share picks. A key left out means "no filter on that"; the platform's own exclusions (drafts, team-only, received copies, originals) always apply. */
export const ShareSelect = z.strictObject({
  /** Folders or files under `memory/` (`decisions/`, `playbooks/release.md`). Left out: all of memory except what other teams delivered (`shared/`). */
  paths: z.array(SharePath).max(50).optional(),
  /** OKF `type` values (any of). Matching ignores upper and lower case. */
  types: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  /** Tags (any of). */
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  /** The lowest trust a concept may have to go out. Default: any. */
  minTrust: OkfTrustTier.default('unverified'),
  /** Leave out concepts whose `stale_after` date has passed. Default: true. */
  skipStale: z.boolean().default(true),
});
export type ShareSelect = z.infer<typeof ShareSelect>;

/** `full`: the digest carries a copy of each selected concept and a summary. `summary`: the summary only. */
export const ShareMode = z.enum(['full', 'summary']);
export type ShareMode = z.infer<typeof ShareMode>;

/** `review`: a person approves each digest before it goes. `auto`: it goes without a row, once a lead or admin has set it up. */
export const ShareApproval = z.enum(['review', 'auto']);
export type ShareApproval = z.infer<typeof ShareApproval>;

/** When a share runs: `manual` (a person presses Run now) or on a cron schedule (UTC, five fields). */
export const ShareWhen = z
  .union([z.literal('manual'), z.strictObject({ manual: z.literal(true) }), z.strictObject({ cron: CronExpression })])
  .superRefine((value, ctx) => {
    if (typeof value === 'object' && 'cron' in value) {
      try {
        parseCron(value.cron);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'not a cron expression', path: ['cron'] });
      }
    }
  });
export type ShareWhen = z.infer<typeof ShareWhen>;

/** The cron schedule of a `when`, or null for a manual share. */
export const shareCronOf = (when: ShareWhen): string | null => (typeof when === 'object' && 'cron' in when ? when.cron : null);

const TeamSlugText = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'a team slug');

/** The contents of `routines/shares/<slug>.yaml` (SPEC §12.3). Unknown keys are refused: a typo must not loosen what is shared. */
export const ShareDefinition = z.strictObject({
  name: z.string().trim().min(1).max(120),
  /** Destination team slugs. The loader checks that each exists and is not the sending team. */
  to: z.array(TeamSlugText).min(1).max(20),
  select: ShareSelect.default({ minTrust: 'unverified', skipStale: true }),
  /** Left out: `summary`, the form that shows the least. */
  mode: ShareMode.default('summary'),
  when: ShareWhen.default('manual'),
  approval: ShareApproval.default('review'),
  /** Who may approve a digest of this share. Left out: the team's leads (and workspace admins). */
  approvers: z.array(SharePrincipal).max(20).default(['role:lead']),
});
export type ShareDefinition = z.infer<typeof ShareDefinition>;

/** `active` loads and runs; `invalid` has a file the platform could not accept (the reason is on the share); `removed` is a share whose file was deleted. */
export const ShareStatus = z.enum(['active', 'invalid', 'removed']);
export type ShareStatus = z.infer<typeof ShareStatus>;

/** A destination's link: `requested` (named, nothing delivered until its lead accepts), `accepted`, `paused` or `revoked`. */
export const ShareLinkState = z.enum(['requested', 'accepted', 'paused', 'revoked']);
export type ShareLinkState = z.infer<typeof ShareLinkState>;

/** Why a link was ended by the sending side, when it was: the destination was taken out of the file (`removed`) or the destination's lead ended it (`by_team`). */
export const ShareLinkEnd = z.enum(['removed', 'by_team']);
export type ShareLinkEnd = z.infer<typeof ShareLinkEnd>;

/**
 * Why a concept that the share's filters matched stayed out. `received` (a digest another team delivered, never passed on), `original` (a Reference: the full
 * text of an email or document, which never leaves the team), `personal` (a note about a person), `draft`, `deprecated`, `team_only` (marked `share: never`),
 * `trust` (below `minTrust`), `stale`, `unreadable` (the file could not be read as a concept), `dlp` (the workspace's data rules did not let it go),
 * `too_large` (the digest was already at its size limit).
 */
export const ShareExclusionReason = z.enum(['received', 'original', 'personal', 'draft', 'deprecated', 'team_only', 'trust', 'stale', 'unreadable', 'dlp', 'too_large']);
export type ShareExclusionReason = z.infer<typeof ShareExclusionReason>;

/** The words for each reason, for an approver and the audit view. */
export const SHARE_EXCLUSION_WORDS: Readonly<Record<ShareExclusionReason, string>> = {
  received: 'it came from another team, and a received copy is never passed on',
  original: 'it holds an original (an email or a document), and originals never leave the team',
  personal: 'it is a note about a person',
  draft: 'it is still a draft',
  deprecated: 'it is marked deprecated',
  team_only: 'it is marked team only',
  trust: 'its trust is below what this share asks for',
  stale: 'it is out of date',
  unreadable: 'it could not be read as a memory concept',
  dlp: 'the workspace’s data rules do not let it leave the team',
  too_large: 'the digest was already as large as a digest may be',
};

/** Where a digest run is. `sent` is set by the delivery step (a later task); this task stops at `ready`. */
export const ShareRunState = z.enum(['building', 'empty', 'blocked', 'awaiting_approval', 'ready', 'denied', 'expired', 'failed', 'sent']);
export type ShareRunState = z.infer<typeof ShareRunState>;

export const ShareRunTrigger = z.enum(['schedule', 'manual']);
export type ShareRunTrigger = z.infer<typeof ShareRunTrigger>;

/** One concept as the preview and the run list it. */
export const ShareConceptRef = z.object({ path: z.string().min(1).max(500), title: z.string().max(500) });
export type ShareConceptRef = z.infer<typeof ShareConceptRef>;
export const ShareExcludedConcept = ShareConceptRef.extend({ reason: ShareExclusionReason });
export type ShareExcludedConcept = z.infer<typeof ShareExcludedConcept>;

/** What changed since the last digest that was sent: new concepts, changed concepts, and concepts the sender has retired (deprecated or no longer shared). */
export const ShareDiff = z.object({
  added: z.array(ShareConceptRef),
  changed: z.array(ShareConceptRef),
  retired: z.array(ShareConceptRef),
  unchanged: z.number().int().min(0),
});
export type ShareDiff = z.infer<typeof ShareDiff>;

export const ShareDestination = z.object({
  teamId: TeamId,
  slug: z.string(),
  name: z.string(),
  link: ShareLinkState,
});
export type ShareDestination = z.infer<typeof ShareDestination>;

/** The numbers behind "matches N concepts · M left out". */
export const ShareCounts = z.object({
  /** Concepts the share's filters (paths, types, tags) match. */
  matched: z.number().int().min(0),
  /** Of those, how many go out in this digest (new or changed). */
  included: z.number().int().min(0),
  /** Of those, how many were left out, with a reason each. */
  leftOut: z.number().int().min(0),
  /** Of those that pass, how many are unchanged since the last digest and so do not go again. */
  unchanged: z.number().int().min(0),
  /** Concepts the sender has retired since the last digest. */
  retired: z.number().int().min(0),
  /** Concepts whose private-looking details were covered up before they went. */
  redacted: z.number().int().min(0),
});
export type ShareCounts = z.infer<typeof ShareCounts>;

/** A share as the team page lists it. */
export const ShareView = z.object({
  id: ShareId,
  teamId: TeamId,
  slug: ShareSlug,
  name: z.string(),
  status: ShareStatus,
  /** For an `invalid` share, why the file was not accepted. */
  invalidReason: z.string().nullable(),
  mode: ShareMode,
  approval: ShareApproval,
  /** `review` unless a lead or admin set `auto` up: what the platform will really do. */
  approvalEffective: ShareApproval,
  cron: z.string().nullable(),
  nextRunAt: IsoDateTime.nullable(),
  destinations: z.array(ShareDestination),
  lastRun: z.object({ id: ShareRunId, state: ShareRunState, at: IsoDateTime }).nullable(),
  updatedAt: IsoDateTime,
});
export type ShareView = z.infer<typeof ShareView>;

/** What a share would send now, before anything is built. No text of any concept. */
export const SharePreview = z.object({
  shareId: ShareId,
  counts: ShareCounts,
  /** The sentence the page shows: "Matches 12 concepts · 3 left out". */
  headline: z.string(),
  included: z.array(ShareConceptRef),
  excluded: z.array(ShareExcludedConcept),
  diff: ShareDiff,
  destinations: z.array(ShareDestination),
});
export type SharePreview = z.infer<typeof SharePreview>;

/** One run of a share: a digest that was built (or could not be), and where it stands. */
export const ShareRun = z.object({
  id: ShareRunId,
  shareId: ShareId,
  teamId: TeamId,
  trigger: ShareRunTrigger,
  state: ShareRunState,
  /** A plain sentence about the state (why it is blocked, what it waits for). Null when there is nothing to add. */
  reason: z.string().nullable(),
  mode: ShareMode,
  /** The label of the digest's period, which is also its folder name in the destination's inbox. Null until built. */
  period: z.string().nullable(),
  /** A fingerprint of the digest's files; the same files always have the same one. Null until built. */
  digestSha: z.string().nullable(),
  bundleBytes: z.number().int().min(0),
  counts: ShareCounts.nullable(),
  included: z.array(ShareConceptRef),
  excluded: z.array(ShareExcludedConcept),
  diff: ShareDiff.nullable(),
  destinations: z.array(ShareDestination),
  approvalId: ApprovalId.nullable(),
  requestedBy: ActorId.nullable(),
  settledBy: ActorId.nullable(),
  createdAt: IsoDateTime,
  builtAt: IsoDateTime.nullable(),
  settledAt: IsoDateTime.nullable(),
  sentAt: IsoDateTime.nullable(),
});
export type ShareRun = z.infer<typeof ShareRun>;

export const ShareLink = z.object({
  id: ShareLinkId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  shareId: ShareId,
  destTeamId: TeamId,
  state: ShareLinkState,
  requestedAt: IsoDateTime,
  acceptedAt: IsoDateTime.nullable(),
});
export type ShareLink = z.infer<typeof ShareLink>;

/** The tool name of the accept row a destination team's leads see in Approvals (source `grant`): "Team X wants to share its memory with you". */
export const MEMORY_SHARE_ACCEPT_TOOL = 'memory.share.accept';

/** What the receiving team's lead does to a link that is open: pause it (nothing arrives until it is resumed), resume it, or end it. */
export const ShareLinkAction = z.enum(['pause', 'resume', 'revoke']);
export type ShareLinkAction = z.infer<typeof ShareLinkAction>;

/** One share another team sends to this team, as the receiving team sees it. The sender's team is named here because the receiving team must know who it hears from. */
export const ShareIncoming = z.object({
  id: ShareLinkId,
  shareId: ShareId,
  fromTeamId: TeamId,
  fromSlug: z.string(),
  fromName: z.string(),
  shareName: z.string(),
  mode: ShareMode,
  state: ShareLinkState,
  endedReason: ShareLinkEnd.nullable(),
  /** The Approvals row that asks this team's leads to accept, while the link is `requested`. */
  approvalId: ApprovalId.nullable(),
  requestedAt: IsoDateTime,
  acceptedAt: IsoDateTime.nullable(),
  /** When a digest last arrived, if one has. */
  lastDeliveredAt: IsoDateTime.nullable(),
  deliveries: z.number().int().min(0),
});
export type ShareIncoming = z.infer<typeof ShareIncoming>;

/** The tool name of the digest's approval row (source `grant`). */
export const MEMORY_DIGEST_SEND_TOOL = 'memory.digest.send';

/** The most concepts one digest carries, and the most bytes its files may add up to. A larger selection is cut and the rest say `too_large`. */
export const SHARE_MAX_CONCEPTS = 300;
export const SHARE_MAX_BUNDLE_BYTES = 6 * 1024 * 1024;

/** The sentence "Matches N concepts · M left out" (a plain count, singular where it is one). */
export function shareHeadline(matched: number, leftOut: number): string {
  return `Matches ${matched} ${matched === 1 ? 'concept' : 'concepts'} · ${leftOut} left out`;
}
