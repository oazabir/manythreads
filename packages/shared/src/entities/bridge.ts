import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BridgeAccountId, BridgeLinkId, ChannelId, PersonId, TeamId } from '../ids.ts';

// Chat bridges (PLAN Bundle D, P16-09, plugin `bridges`, docs/plugins/bridges.md): Telegram, WhatsApp, Slack and Microsoft Teams joined to manythreads. Enums match the
// SQL CHECKs in plugins/bridges/migrations/0001 exactly (packages/kernel/test/schema-enums.test.ts compares both).

export const BridgeProvider = z.enum(['telegram', 'whatsapp', 'slack', 'teams']);
export type BridgeProvider = z.infer<typeof BridgeProvider>;

/** `off`: nothing comes in or goes out. `on`: running. `attention`: the chat app refused us (a wrong token, a removed bot); the account says why. */
export const BridgeStatus = z.enum(['off', 'on', 'attention']);
export type BridgeStatus = z.infer<typeof BridgeStatus>;

/** The credentials an account keeps sealed. Never returned by any route; the admin page only learns which are set. */
export const BridgeSecretName = z.enum(['bot_token', 'app_secret', 'signing_secret', 'inbound_secret']);
export type BridgeSecretName = z.infer<typeof BridgeSecretName>;

/** What a link code is for: a person proving a chat user is theirs, or a lead joining a channel to a chat. */
export const BridgeCodePurpose = z.enum(['identity', 'channel']);
export type BridgeCodePurpose = z.infer<typeof BridgeCodePurpose>;

export const BridgeMessageDirection = z.enum(['in', 'out']);
export type BridgeMessageDirection = z.infer<typeof BridgeMessageDirection>;
/** `received`: an inbound message handled. `pending`, `waiting`, `sent`, `dead`: the life of an outbound one (`waiting`: WhatsApp's 24-hour window is closed). */
export const BridgeMessageStatus = z.enum(['received', 'pending', 'waiting', 'sent', 'dead']);
export type BridgeMessageStatus = z.infer<typeof BridgeMessageStatus>;

/** Why an inbound message was not posted. */
export const BridgeRefusalReason = z.enum(['unverified', 'disabled', 'bad_signature']);
export type BridgeRefusalReason = z.infer<typeof BridgeRefusalReason>;

/** The most text one message carries across a bridge (characters); a longer one is cut. */
export const BRIDGE_MAX_TEXT = 4000;
/** A link code works this long (minutes) and once. Eight digits. */
export const BRIDGE_CODE_MINUTES = 10;
export const BRIDGE_CODE_DIGITS = 8;
/** A person may ask for this many codes in ten minutes; a chat gets this many wrong codes in 15 minutes before it is locked out. */
export const BRIDGE_CODES_PER_PERSON = 5;
export const BRIDGE_WRONG_CODES_PER_CHAT = 5;
/** A chat that is not linked is told to link at most once per this many minutes. */
export const BRIDGE_UNLINKED_REPLY_MINUTES = 60;
/** WhatsApp answers only within this many hours of the person's last message. */
export const BRIDGE_WHATSAPP_WINDOW_HOURS = 24;

/** The `Message.meta.via` key: a message that came across a bridge says from where. Only the bridges plugin sets it. */
export const MessageVia = z.strictObject({ provider: BridgeProvider });
export type MessageVia = z.infer<typeof MessageVia>;

/** One chat app account as an admin sees it. No credential is part of it; `secretsSet` only names which are stored. */
export const BridgeAccount = z.object({
  id: BridgeAccountId,
  provider: BridgeProvider,
  status: BridgeStatus,
  displayName: z.string().min(1).max(120),
  /** The public name people type to reach it (`@kahf_bot`, a phone number). */
  handle: z.string().max(200).nullable(),
  secretsSet: z.array(BridgeSecretName),
  /** Where the chat app is told to send events: `/hooks/bridges/<provider>/<accountId>`. */
  callbackPath: z.string().max(200),
  lastInboundAt: IsoDateTime.nullable(),
  lastOutboundAt: IsoDateTime.nullable(),
  inboundCount: z.number().int().min(0),
  outboundCount: z.number().int().min(0),
  /** Messages dropped because the sender was not linked; a count, never the text. */
  droppedCount: z.number().int().min(0),
  lastError: z.string().max(400).nullable(),
  linkedPeople: z.number().int().min(0),
  linkedChannels: z.number().int().min(0),
});
export type BridgeAccount = z.infer<typeof BridgeAccount>;

/** What a signed-in member sees of an account that is on: enough to link, nothing else. */
export const BridgeAvailable = z.object({
  accountId: BridgeAccountId,
  provider: BridgeProvider,
  displayName: z.string().max(120),
  handle: z.string().max(200).nullable(),
});
export type BridgeAvailable = z.infer<typeof BridgeAvailable>;

/** A person's link to a chat user. */
export const BridgeIdentity = z.object({
  accountId: BridgeAccountId,
  provider: BridgeProvider,
  personId: PersonId,
  externalLabel: z.string().max(120).nullable(),
  verifiedAt: IsoDateTime,
});
export type BridgeIdentity = z.infer<typeof BridgeIdentity>;

/** A public channel joined to an outside chat. */
export const BridgeLink = z.object({
  id: BridgeLinkId,
  accountId: BridgeAccountId,
  provider: BridgeProvider,
  teamId: TeamId,
  channelId: ChannelId,
  externalLabel: z.string().max(120).nullable(),
  createdAt: IsoDateTime,
});
export type BridgeLink = z.infer<typeof BridgeLink>;
