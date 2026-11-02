import {
  AnswerSetupRequest,
  CancelSetupRequest,
  CreateSetupSessionRequest,
  SetupSessionResponse,
  answerSetupRoute,
  cancelSetupRoute,
  createSetupSessionRoute,
  getSetupSessionRoute,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the "Add a bot" screen asks of the server (PLAN P7-04). A setup conversation is the person's own and it runs in the background: the screen starts it, then reads it again
 * until the helper has questions or a proposal. The server words every refusal in plain text, so the screen shows `err.message` as it comes.
 */

export const startSetup = (slug: string, brief: string, name?: string) =>
  call(createSetupSessionRoute, { request: CreateSetupSessionRequest, response: SetupSessionResponse }, CreateSetupSessionRequest.parse({ brief, ...(name ? { name } : {}) }), { slug });

export const fetchSetup = (slug: string, sessionId: string) => call(getSetupSessionRoute, { response: SetupSessionResponse }, undefined, { slug, sessionId });

export const answerSetup = (slug: string, sessionId: string, answers: Array<{ questionId: string; text: string }>) =>
  call(answerSetupRoute, { request: AnswerSetupRequest, response: SetupSessionResponse }, AnswerSetupRequest.parse({ answers }), { slug, sessionId });

export const cancelSetup = (slug: string, sessionId: string) =>
  call(cancelSetupRoute, { request: CancelSetupRequest, response: SetupSessionResponse }, CancelSetupRequest.parse({}), { slug, sessionId });
