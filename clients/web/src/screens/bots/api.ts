import {
  GetBotEvalsResponse,
  GetBotResponse,
  GetRepoBlobQuery,
  GetRepoBlobResponse,
  ListBotsResponse,
  RunEvalsRequest,
  RunEvalsResponse,
  botMdPath,
  getBotEvalsRoute,
  getBotRoute,
  getRepoBlobRoute,
  listBotsRoute,
  runEvalsRoute,
} from '@manythreads/shared';
import { call } from '../../api/client';
import { createProposal } from '../proposals/api';

/*
 * What the Bots screens ask of the server (PLAN P5-05). Two reads over the bots plugin — the roster and one bot — plus the definition
 * itself, which is a file of the team repo: read through `repo/blob`, saved as a proposal with the blob that was read (`baseBlobSha`). The repo
 * writer's own rules still decide who may apply it: a team lead edits a bot that exists, a workspace admin adds or removes one.
 */

export const fetchBots = (slug: string) => call(listBotsRoute, { response: ListBotsResponse }, undefined, { slug });

export const fetchBot = (slug: string, botSlug: string) => call(getBotRoute, { response: GetBotResponse }, undefined, { slug, botSlug });

/** The definition file as the loader reads it: the text and the blob a save must be based on. */
export type DefinitionFile = { content: string; blobSha: string; commitSha: string };

export async function readDefinition(slug: string, path: string): Promise<DefinitionFile> {
  const b = await call(getRepoBlobRoute, { request: GetRepoBlobQuery, response: GetRepoBlobResponse }, GetRepoBlobQuery.parse({ path }), { slug });
  return { content: b.encoding === 'utf8' ? b.content : new TextDecoder().decode(Uint8Array.from(atob(b.content), (c) => c.charCodeAt(0))), blobSha: b.blobSha, commitSha: b.commitSha };
}

/**
 * The whole file as a proposal (PLAN P7-01): bots/ is never committed directly. With `applyNow` a team lead or workspace admin proposes and applies in
 * one step (the commit is theirs, a proposal stays on record); without it the proposal waits for a lead or admin. `baseBlobSha` is the blob the page
 * read: a file someone else changed in the meantime is refused with 409 and nothing is overwritten. A BOT.md that does not load is refused with 422 and
 * the loader's own words.
 */
export async function proposeDefinition(
  slug: string,
  path: string,
  content: string,
  baseBlobSha: string | null,
  title: string,
  applyNow: boolean,
): Promise<{ proposalId: string; applied: boolean; noop: boolean }> {
  const res = await createProposal(slug, { path, op: 'put', content, baseBlobSha, title, ...(applyNow ? { applyNow: true } : {}) });
  return { proposalId: res.proposal.proposal.id, applied: res.proposal.proposal.status === 'applied', noop: false };
}

export { botMdPath };

/** Why there is no Talk button on a bot whose definition has no `conversation` trigger: the router answers a conversation only for that trigger. */

/** A bot's evals: the newest runs and whether the signed-in person may start one (PLAN P7-08). */
export const fetchEvals = (slug: string, botSlug: string) => call(getBotEvalsRoute, { response: GetBotEvalsResponse }, undefined, { slug, botSlug });

/** Start a run of the bot's scenario set. `static` is free; `model` costs tokens. The answer is the run, still `running`. */
export const startEvals = (slug: string, botSlug: string, mode: 'static' | 'model') =>
  call(runEvalsRoute, { request: RunEvalsRequest, response: RunEvalsResponse }, RunEvalsRequest.parse({ mode }), { slug, botSlug });
