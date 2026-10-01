import { z } from 'zod';
import { ChannelMessagePostedEvent } from './channel.message.posted.ts';
import { WorkspaceTeamCreatedEvent } from './workspace.team.created.ts';
import { WorkspaceTeamRenamedEvent } from './workspace.team.renamed.ts';
import { WorkspaceTeamArchivedEvent } from './workspace.team.archived.ts';
import { WorkspaceTeamUnarchivedEvent } from './workspace.team.unarchived.ts';
import { WorkspaceInvitationCreatedEvent } from './workspace.invitation.created.ts';
import { WorkspaceInvitationAcceptedEvent } from './workspace.invitation.accepted.ts';
import { TeamTemplateAppliedEvent } from './team.template.applied.ts';
import { TeamMemberAddedEvent } from './team.member.added.ts';
import { TeamMemberRemovedEvent } from './team.member.removed.ts';
import { TeamRoleChangedEvent } from './team.role.changed.ts';
import { TeamTagCreatedEvent } from './team.tag.created.ts';
import { TeamTagDeletedEvent } from './team.tag.deleted.ts';
import { TeamTagAssignedEvent } from './team.tag.assigned.ts';
import { TeamTagRemovedEvent } from './team.tag.removed.ts';
import { KernelCapabilityDeniedEvent } from './kernel.capability.denied.ts';
import { KernelTestPingedEvent } from './kernel.test.pinged.ts';
import { KernelTestPingedEventV2, upcastKernelTestPingedV1ToV2 } from './kernel.test.pinged.v2.ts';

/** type -> schemaVersion -> schema. A breaking change adds a new version beside the old one (B.4). */
export const eventRegistry = {
  'channel.message.posted': { 1: ChannelMessagePostedEvent },
  'workspace.team.created': { 1: WorkspaceTeamCreatedEvent },
  'workspace.team.renamed': { 1: WorkspaceTeamRenamedEvent },
  'workspace.team.archived': { 1: WorkspaceTeamArchivedEvent },
  'workspace.team.unarchived': { 1: WorkspaceTeamUnarchivedEvent },
  'workspace.invitation.created': { 1: WorkspaceInvitationCreatedEvent },
  'workspace.invitation.accepted': { 1: WorkspaceInvitationAcceptedEvent },
  'team.template.applied': { 1: TeamTemplateAppliedEvent },
  'team.member.added': { 1: TeamMemberAddedEvent },
  'team.member.removed': { 1: TeamMemberRemovedEvent },
  'team.role.changed': { 1: TeamRoleChangedEvent },
  'team.tag.created': { 1: TeamTagCreatedEvent },
  'team.tag.deleted': { 1: TeamTagDeletedEvent },
  'team.tag.assigned': { 1: TeamTagAssignedEvent },
  'team.tag.removed': { 1: TeamTagRemovedEvent },
  'kernel.capability.denied': { 1: KernelCapabilityDeniedEvent },
  'kernel.test.pinged': { 1: KernelTestPingedEvent, 2: KernelTestPingedEventV2 },
} as const;

export type EventType = keyof typeof eventRegistry;

/** Every stored shape, any version. */
export type AnyEvent =
  | z.infer<typeof WorkspaceTeamCreatedEvent>
  | z.infer<typeof WorkspaceTeamRenamedEvent>
  | z.infer<typeof WorkspaceTeamArchivedEvent>
  | z.infer<typeof WorkspaceTeamUnarchivedEvent>
  | z.infer<typeof WorkspaceInvitationCreatedEvent>
  | z.infer<typeof WorkspaceInvitationAcceptedEvent>
  | z.infer<typeof TeamTemplateAppliedEvent>
  | z.infer<typeof TeamMemberAddedEvent>
  | z.infer<typeof TeamMemberRemovedEvent>
  | z.infer<typeof TeamRoleChangedEvent>
  | z.infer<typeof TeamTagCreatedEvent>
  | z.infer<typeof TeamTagDeletedEvent>
  | z.infer<typeof TeamTagAssignedEvent>
  | z.infer<typeof TeamTagRemovedEvent>
  | z.infer<typeof ChannelMessagePostedEvent>
  | z.infer<typeof KernelCapabilityDeniedEvent>
  | z.infer<typeof KernelTestPingedEvent>
  | z.infer<typeof KernelTestPingedEventV2>;

/** The newest version of every event: what `upcast` returns and emitters write. */
export type LatestEvent =
  | z.infer<typeof WorkspaceTeamCreatedEvent>
  | z.infer<typeof WorkspaceTeamRenamedEvent>
  | z.infer<typeof WorkspaceTeamArchivedEvent>
  | z.infer<typeof WorkspaceTeamUnarchivedEvent>
  | z.infer<typeof WorkspaceInvitationCreatedEvent>
  | z.infer<typeof WorkspaceInvitationAcceptedEvent>
  | z.infer<typeof TeamTemplateAppliedEvent>
  | z.infer<typeof TeamMemberAddedEvent>
  | z.infer<typeof TeamMemberRemovedEvent>
  | z.infer<typeof TeamRoleChangedEvent>
  | z.infer<typeof TeamTagCreatedEvent>
  | z.infer<typeof TeamTagDeletedEvent>
  | z.infer<typeof TeamTagAssignedEvent>
  | z.infer<typeof TeamTagRemovedEvent>
  | z.infer<typeof ChannelMessagePostedEvent>
  | z.infer<typeof KernelCapabilityDeniedEvent>
  | z.infer<typeof KernelTestPingedEventV2>;

type Upcaster = (event: AnyEvent) => AnyEvent;

/** type -> fromVersion -> function producing fromVersion + 1. */
const upcasters: Readonly<Record<string, Readonly<Record<number, Upcaster>>>> = {
  'kernel.test.pinged': {
    // The registry guarantees the input was validated as v1 before this runs.
    1: (event) => upcastKernelTestPingedV1ToV2(event as z.infer<typeof KernelTestPingedEvent>),
  },
};

const schemasByType: Readonly<Record<string, Readonly<Record<number, z.ZodType>>>> = eventRegistry;

const Envelope = z.looseObject({ type: z.string(), schemaVersion: z.number().int() });

const fail = (path: string, message: string): never => {
  throw new z.ZodError([{ code: 'custom', path: [path], message, input: undefined }]);
};

export const latestVersion = (type: EventType): number => {
  const versions = Object.keys(eventRegistry[type]).map(Number);
  return Math.max(...versions);
};

/** Validate `raw` against the schema for its own type + schemaVersion. Throws a ZodError naming the field. */
export const parseEvent = (raw: unknown): AnyEvent => {
  const { type, schemaVersion } = Envelope.parse(raw);
  const versions = Object.hasOwn(schemasByType, type) ? schemasByType[type] : undefined;
  if (!versions) return fail('type', `unknown event type "${type}"`);
  const schema = Object.hasOwn(versions, schemaVersion) ? versions[schemaVersion] : undefined;
  if (!schema) return fail('schemaVersion', `unknown schemaVersion ${schemaVersion} for event type "${type}"`);
  // Safe by construction: every registered schema infers to a member of AnyEvent.
  return schema.parse(raw) as AnyEvent;
};

/** Parse, then upcast step by step to the newest registered version. */
export const upcast = (raw: unknown): LatestEvent => {
  let event = parseEvent(raw);
  const type = event.type;
  const latest = latestVersion(type);
  while (event.schemaVersion < latest) {
    const step = upcasters[type]?.[event.schemaVersion];
    if (!step) return fail('schemaVersion', `no upcaster from v${event.schemaVersion} for "${type}"`);
    event = parseEvent(step(event));
  }
  return event as LatestEvent;
};
