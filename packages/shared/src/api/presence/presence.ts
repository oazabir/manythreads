import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import {
  CustomStatus,
  CustomStatusInput,
  DndSchedule,
  DndSettings,
  DndState,
  OutOfOffice,
  OutOfOfficeInput,
  PresenceCard,
  TimeZone,
  WorkingHours,
} from '../../entities/presence.ts';

// Status and Do not disturb routes of the presence plugin (PLAN P14-01). The heartbeat routes (`POST/GET /api/presence`) are in
// api/channels/ephemeral.ts; the plugin that owns them is this one.

/** Everyone the caller may see a card for: members see the workspace, a guest only themself. Offline people with nothing to show are left out. */
export const ListPresenceCardsResponse = z.object({ people: z.array(PresenceCard) });
export type ListPresenceCardsResponse = z.infer<typeof ListPresenceCardsResponse>;
export const listPresenceCardsRoute = { method: 'GET', path: '/api/presence/people' } as const;

/** The caller's own settings, every part of them. */
export const MyPresence = z.object({
  status: CustomStatus.nullable(),
  timeZone: z.string().nullable(),
  workingHours: WorkingHours.nullable(),
  outOfOffice: OutOfOffice.nullable(),
  /**
   * The person's last out-of-office period while it is on or for two weeks after they came back (`recentAway`): when it started and whether they are back. The
   * Summary panel offers "Since I was away" from it (P18-05). Null otherwise; optional on the wire for an older server.
   */
  away: z.object({ since: IsoDateTime, back: z.boolean() }).nullable().default(null),
  dnd: DndSettings,
  dndState: DndState,
});
export type MyPresence = z.infer<typeof MyPresence>;
export const getMyPresenceRoute = { method: 'GET', path: '/api/presence/me' } as const;

/** Change some of the public parts; a field left out stays as it is, `null` clears it. */
export const UpdateMyPresenceRequest = z.strictObject({
  status: CustomStatusInput.nullable().optional(),
  timeZone: TimeZone.nullable().optional(),
  workingHours: WorkingHours.nullable().optional(),
  outOfOffice: OutOfOfficeInput.nullable().optional(),
});
export type UpdateMyPresenceRequest = z.infer<typeof UpdateMyPresenceRequest>;
export const updateMyPresenceRoute = { method: 'PATCH', path: '/api/presence/me' } as const;

/**
 * Change Do not disturb: `enabled` switches it on or off by hand, `pauseMinutes` pauses notifications for that long from now (`null` ends a
 * pause), `schedule` replaces the weekly schedule. A field left out stays as it is.
 */
export const UpdateDndRequest = z.strictObject({
  enabled: z.boolean().optional(),
  pauseMinutes: z.number().int().min(1).max(7 * 24 * 60).nullable().optional(),
  schedule: DndSchedule.optional(),
});
export type UpdateDndRequest = z.infer<typeof UpdateDndRequest>;
export const updateDndRoute = { method: 'PUT', path: '/api/presence/dnd' } as const;
