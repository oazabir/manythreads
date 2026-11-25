import { z } from 'zod';
import { ChannelId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

/*
 * Incidents (P35-07). `/incident <title>` opens one from any channel of the team; `/incident resolve <summary>` in the incident's channel closes it and
 * drafts the post-mortem page.
 */
export const OpenIncidentParams = z.object({ slug: TeamSlug });
export const OpenIncidentRequest = z.strictObject({
  title: z.string().trim().min(1).max(200),
  /** The channel the command was typed in: a line there points to the incident's channel. */
  fromChannelId: ChannelId.optional(),
});
export type OpenIncidentRequest = z.infer<typeof OpenIncidentRequest>;
/** An incident is open until someone resolves it (the CHECK of `incidents.status`). */
export const IncidentStatus = z.enum(['open', 'resolved']);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

export const Incident = z.object({
  id: z.uuid(),
  channelId: ChannelId,
  channelName: z.string(),
  title: z.string(),
  status: IncidentStatus,
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
  postmortemPath: z.string().nullable(),
});
export type Incident = z.infer<typeof Incident>;
export const IncidentResponse = z.object({ incident: Incident });
export type IncidentResponse = z.infer<typeof IncidentResponse>;
export const openIncidentRoute = { method: 'POST', path: '/api/teams/:slug/incidents' } as const;

export const ResolveIncidentParams = z.object({ channelId: ChannelId });
export const ResolveIncidentRequest = z.strictObject({ summary: z.string().trim().max(2000).optional() });
export type ResolveIncidentRequest = z.infer<typeof ResolveIncidentRequest>;
export const resolveIncidentRoute = { method: 'POST', path: '/api/channels/:channelId/incident/resolve' } as const;
