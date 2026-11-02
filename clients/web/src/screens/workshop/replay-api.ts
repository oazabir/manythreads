import {
  CloseReassessmentRequest,
  CloseReassessmentResponse,
  FullReplayRequest,
  FullReplayResponse,
  ReassessmentListResponse,
  ReplayQuery,
  ReplayResponse,
  closeReassessmentRoute,
  fullReplayRoute,
  listReassessmentsRoute,
  replayBotRoute,
  type ReassessmentAnswer,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What replay and re-assessment ask of the server (PLAN P7-07). The free replay is a plain read. The full replay is asked twice: first with no confirmation (the answer is its cost), then
 * with the same number sent back as the person's confirmation. The server words every refusal in plain text, so the tab shows `err.message` as it comes.
 */

export const fetchReplay = (slug: string, botSlug: string, days: number) => call(replayBotRoute, { request: ReplayQuery, response: ReplayResponse }, ReplayQuery.parse({ days }), { slug, botSlug });

export const askFullReplay = (slug: string, botSlug: string, runId: string, confirm?: { tokens: number; token: string }) =>
  call(
    fullReplayRoute,
    { request: FullReplayRequest, response: FullReplayResponse },
    FullReplayRequest.parse(confirm === undefined ? {} : { confirm }),
    { slug, botSlug, runId },
  );

export const listReassessments = (slug: string, botSlug: string) => call(listReassessmentsRoute, { response: ReassessmentListResponse }, undefined, { slug, botSlug });

export const closeReassessment = (slug: string, botSlug: string, reassessmentId: string, answer: ReassessmentAnswer) =>
  call(closeReassessmentRoute, { request: CloseReassessmentRequest, response: CloseReassessmentResponse }, CloseReassessmentRequest.parse({ answer }), { slug, botSlug, reassessmentId });
