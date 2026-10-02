import type { z } from 'zod';
import { UnreadSummary } from '../../entities/read-state.ts';

export const GetUnreadSummaryResponse = UnreadSummary;
export type GetUnreadSummaryResponse = z.infer<typeof GetUnreadSummaryResponse>;
export const getUnreadSummaryRoute = { method: 'GET', path: '/api/read-state/summary' } as const;
