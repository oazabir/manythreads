import {
  CreateWorkshopSessionRequest,
  EndWorkshopSessionRequest,
  PostWorkshopMessageRequest,
  WorkshopSessionListResponse,
  WorkshopSessionResponse,
  createWorkshopSessionRoute,
  endWorkshopSessionRoute,
  getWorkshopSessionRoute,
  listWorkshopSessionsRoute,
  postWorkshopMessageRoute,
  type WorkshopAbout,
  type WorkshopMode,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the Workshop tab asks of the server (PLAN P7-05). A Workshop conversation is the person's own and the answer is written in the background: the tab sends a message, then reads the
 * conversation again until it is ready. The server words every refusal in plain text, so the tab shows `err.message` as it comes.
 */

export const startWorkshop = (slug: string, botSlug: string, mode: WorkshopMode, text?: string) =>
  call(createWorkshopSessionRoute, { request: CreateWorkshopSessionRequest, response: WorkshopSessionResponse }, CreateWorkshopSessionRequest.parse({ mode, ...(text ? { text } : {}) }), { slug, botSlug });

export const listWorkshop = (slug: string, botSlug: string) => call(listWorkshopSessionsRoute, { response: WorkshopSessionListResponse }, undefined, { slug, botSlug });

export const fetchWorkshop = (slug: string, botSlug: string, sessionId: string) => call(getWorkshopSessionRoute, { response: WorkshopSessionResponse }, undefined, { slug, botSlug, sessionId });

export const sayInWorkshop = (slug: string, botSlug: string, sessionId: string, text: string, about?: WorkshopAbout) =>
  call(postWorkshopMessageRoute, { request: PostWorkshopMessageRequest, response: WorkshopSessionResponse }, PostWorkshopMessageRequest.parse({ text, ...(about ? { about } : {}) }), { slug, botSlug, sessionId });

export const endWorkshop = (slug: string, botSlug: string, sessionId: string) =>
  call(endWorkshopSessionRoute, { request: EndWorkshopSessionRequest, response: WorkshopSessionResponse }, EndWorkshopSessionRequest.parse({}), { slug, botSlug, sessionId });
