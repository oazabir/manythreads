import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, TeamId } from '../ids.ts';

// The team memory inbox (SPEC §12.2, PLAN P8-14): anyone on a team drops a file, a note, a link or a message into it, and the platform turns it into
// memory. An item is one such drop. It is received, checked (a hold may keep it from any model), read into text, distilled into concepts, validated
// and committed to the team's `memory/` folder, and the dropper is told. The original stays in blob storage as provenance.

export const InboxItemId = z.uuid().brand<'InboxItemId'>();
export type InboxItemId = z.infer<typeof InboxItemId>;

/**
 * Where an item is on its way.
 *  `queued`       waiting its turn (or waiting for the Archivist's budget; `reason` says which);
 *  `extracting`   being read into text;
 *  `filing`       being distilled and committed;
 *  `filed`        done: the concepts are in memory;
 *  `held`         stored but not read by anything until a lead or admin releases or discards it (`holdReason` says why);
 *  `failed`       could not be read or filed (`reason` says why; Retry puts it back in the queue);
 *  `duplicate`    the same bytes were already filed or are waiting, so nothing was written (`duplicateOf` names the first);
 *  `needs_review` the pipeline finished but the result needs a person to look at it before anything is written;
 *  `discarded`    a lead or admin threw it away; the original is deleted.
 */
export const InboxState = z.enum(['queued', 'extracting', 'filing', 'filed', 'held', 'failed', 'duplicate', 'needs_review', 'discarded']);
export type InboxState = z.infer<typeof InboxState>;

/** How the item arrived: a person's file or note, a message sent to memory, an email, another team's share, or a bot. (`meeting` joins in phase 15.) */
export const InboxOrigin = z.enum(['person', 'message', 'email', 'share', 'bot']);
export type InboxOrigin = z.infer<typeof InboxOrigin>;

/** What the original is, as far as the extractor is concerned. `image`, `audio` and `video` are recognised so the person is told plainly when they cannot be read yet. */
export const InboxKind = z.enum(['markdown', 'text', 'csv', 'pdf', 'docx', 'pptx', 'xlsx', 'eml', 'html', 'image', 'audio', 'video', 'link', 'bundle', 'unknown']);
export type InboxKind = z.infer<typeof InboxKind>;

/** Why an item is held, in a few words the screen turns into a sentence. */
export const InboxHoldReason = z.enum(['review_all', 'unknown_sender', 'failed_sender_check', 'foreign_bundle', 'dlp', 'oversize']);
export type InboxHoldReason = z.infer<typeof InboxHoldReason>;

/** An email's sender check as the mail door saw it: `pass` (SPF and DKIM), `fail`, or `none` (no result). Only an `email` origin has one. */
export const InboxSenderCheck = z.enum(['pass', 'fail', 'none']);
export type InboxSenderCheck = z.infer<typeof InboxSenderCheck>;

/** The longest file name an item keeps. */
export const INBOX_NAME_MAX = 200;
/** The most text a New note takes (characters). */
export const INBOX_NOTE_MAX_CHARS = 200_000;
/** The default size cap of a drop (bytes); `TEAM.md` `memory.inbox.maxBytes` and the server's `MANYTHREADS_INBOX_MAX_BYTES` can lower it. */
export const INBOX_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** The hard ceiling for `maxBytes`, whatever TEAM.md says. */
export const INBOX_HARD_MAX_BYTES = 100 * 1024 * 1024;

export const InboxItem = z.object({
  id: InboxItemId,
  teamId: TeamId,
  origin: InboxOrigin,
  state: InboxState,
  kind: InboxKind,
  /** The file's name, the note's title or the message's author and channel: what the card calls the drop. */
  name: z.string().min(1).max(INBOX_NAME_MAX),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Who dropped it: null once that actor is gone. */
  droppedBy: ActorId.nullable(),
  droppedByName: z.string().nullable(),
  /** The dropper chose "team only": what is filed carries `share: never`, so a share digest never includes it. */
  teamOnly: z.boolean(),
  /** A plain sentence about the state: why it waits, why it failed, what needs review. Null when there is nothing to say. */
  reason: z.string().max(400).nullable(),
  holdReason: InboxHoldReason.nullable(),
  /** For a `duplicate`, the item that was there first. */
  duplicateOf: InboxItemId.nullable(),
  /** For an attachment of an email, the email's item. */
  parentId: InboxItemId.nullable(),
  /** The email's sender, for an `email` origin. */
  sender: z.string().max(320).nullable(),
  senderCheck: InboxSenderCheck.nullable(),
  /** When filed: the paths written (concepts and the reference) and the commit. */
  filedPaths: z.array(z.string()),
  commitSha: z.string().nullable(),
  /** Whether the original is still kept (it is deleted by a discard, or after `keepOriginals` days). */
  originalKept: z.boolean(),
  attempts: z.number().int().min(0),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  filedAt: IsoDateTime.nullable(),
});
export type InboxItem = z.infer<typeof InboxItem>;

/** How long originals are kept after filing: `forever`, or a number of days (after which the Reference keeps the text and says the original was removed). */
export const InboxKeepOriginals = z.union([z.literal('forever'), z.number().int().min(1).max(3650)]);
export type InboxKeepOriginals = z.infer<typeof InboxKeepOriginals>;

/** Which drops are held for a lead to release: `external` (the default: only what is outside the team's trust), `all`, or `none`. */
export const InboxReviewMode = z.enum(['external', 'all', 'none']);
export type InboxReviewMode = z.infer<typeof InboxReviewMode>;

/** What a team's `TEAM.md` says about its inbox, under `memory.inbox` in the frontmatter. Every key may be left out. */
export const TeamMemoryInboxConfig = z.strictObject({
  review: InboxReviewMode.default('external'),
  keepOriginals: InboxKeepOriginals.default('forever'),
  /** Senders (an address, or `@domain`) whose email is not held under `review: external`. */
  allowEmailFrom: z.array(z.string().trim().min(3).max(320)).max(200).default([]),
  maxBytes: z.number().int().min(1024).max(INBOX_HARD_MAX_BYTES).default(INBOX_DEFAULT_MAX_BYTES),
});
export type TeamMemoryInboxConfig = z.infer<typeof TeamMemoryInboxConfig>;
