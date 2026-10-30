import { ChannelNameInput, ChannelPurpose, type CreateChannelRequest, type TeamSummary } from '@manythreads/shared';
import { isApiError } from '../api/client';

/*
 * The rules behind the "New channel" dialog in the sidebar, kept apart from the screen so they can be tested without a browser. The server
 * decides who may add a channel (the channels plugin: a lead of the team or a workspace admin, in a team that is not archived); the client
 * only mirrors that so it does not offer a button that always answers "not allowed".
 */

/** Whether the sidebar offers "New channel": a lead of the team or a workspace admin, and the team is not archived. A guest has no team here. */
export function canCreateChannel(team: Pick<TeamSummary, 'myRole' | 'archivedAt'> | null, workspaceAdmin: boolean): boolean {
  if (!team || team.archivedAt) return false;
  return workspaceAdmin || team.myRole === 'lead';
}

/** What the person typed, as the server wants it: no `#`, no spaces at the ends, lowercase, runs of spaces and underscores turned into one dash. */
export function normalizeChannelName(typed: string): string {
  return typed
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

export const NAME_RULE = 'Use lowercase letters, numbers and dashes, starting with a letter or a number, up to 63 characters.';

/** A sentence for a name the server would refuse, or null when the name is fine (an empty name is not an error yet, the button just waits). */
export function nameProblem(typed: string): string | null {
  const name = normalizeChannelName(typed);
  if (name === '') return null;
  return ChannelNameInput.safeParse(name).success ? null : NAME_RULE;
}

/** The longest topic the server keeps. */
export const TOPIC_MAX = 250;

export type NewChannelForm = { name: string; topic: string; isPrivate: boolean };

/** The request for the form, or the sentence that says what is wrong with it. */
export function buildRequest(form: NewChannelForm): { ok: true; request: CreateChannelRequest } | { ok: false; problem: string } {
  const name = normalizeChannelName(form.name);
  if (name === '') return { ok: false, problem: 'Give the channel a name.' };
  if (!ChannelNameInput.safeParse(name).success) return { ok: false, problem: NAME_RULE };
  const topic = form.topic.trim();
  if (topic !== '' && !ChannelPurpose.safeParse(topic).success) return { ok: false, problem: `The topic can be at most ${TOPIC_MAX} characters.` };
  return { ok: true, request: { name, ...(topic !== '' ? { purpose: topic } : {}), ...(form.isPrivate ? { private: true } : {}) } };
}

/**
 * A plain sentence for a refused creation. The server answers from a closed set of errors: 409 (the name is taken, or the team is archived),
 * 400 (the name or topic is not valid), 403 (the person may not add channels here), 404 (no such team), 429 (too many tries).
 */
export function createErrorText(err: unknown, name: string): string {
  if (!isApiError(err)) return 'Could not create the channel. Try again.';
  switch (err.status) {
    case 409:
      return /team is archived/i.test(err.message) ? 'This team is archived, so it cannot get new channels.' : `A channel named #${name} already exists in this team. Pick another name.`;
    case 400:
    case 422:
      return NAME_RULE;
    case 403:
      return 'Only a team lead or a workspace admin can add channels.';
    case 404:
      return 'This team no longer exists.';
    case 429:
      return 'Too many tries. Wait a moment and try again.';
    default:
      return err.code === 'network' ? 'Could not reach the server. Check the connection and try again.' : 'Could not create the channel. Try again.';
  }
}
