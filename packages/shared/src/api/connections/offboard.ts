import { z } from 'zod';
import { OffboardPreview, OffboardResult } from '../../entities/connector-health.ts';
import { PersonId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Removing a person's connections when they leave (PLAN Bundle D, P16-11, plugin `connections`). Happens by itself when a person is suspended, and by an admin's button on
// Members. Their own connections are switched off at once and removed (the providers are asked to forget them) by a job; a team or workspace connection they set up moves
// to the team's longest-serving lead, else to the admin who pressed the button. Reactivating the person restores nothing. docs/plugins/connections.md "Offboarding".

export const OffboardPathParams = z.object({ personId: PersonId });
export type OffboardPathParams = z.infer<typeof OffboardPathParams>;

export const OffboardPreviewResponse = z.object({ preview: OffboardPreview });
export type OffboardPreviewResponse = z.infer<typeof OffboardPreviewResponse>;
export const offboardPreviewRoute = { method: 'GET', path: '/api/admin/people/:personId/offboard-connections' } as const satisfies ApiRoute;

export const OffboardConnectionsRequest = z.strictObject({});
export const OffboardConnectionsResponse = z.object({ result: OffboardResult });
export type OffboardConnectionsResponse = z.infer<typeof OffboardConnectionsResponse>;
/** Answers 202: the job runs behind it. */
export const offboardConnectionsRoute = { method: 'POST', path: '/api/admin/people/:personId/offboard-connections' } as const satisfies ApiRoute;
