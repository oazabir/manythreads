/*
 * The "New" menu at the top of the sidebar (P38-07): everything a person can start from one place. This file holds the list, its order and who sees what, with
 * no screen code in it, so the order and the permission rules can be tested without a browser.
 *
 * Why this order: the most likely thing is talking to someone (a bot, then a person, then a new channel or a call), then making a file, then the planning
 * things people do now and then (an appointment, an action item, a card, a document for Knowledge), and last the set-up things that happen rarely (a board,
 * a job, a routine, a bot, a project). A thin line separates the three groups; there are no headings, so the top of the list is the first thing read.
 *
 * Who sees what follows the screens' own checks: a guest has nothing to create here (they work in the channels shared with them); an item that belongs to a team
 * needs a team that is not archived; a lead of the team or a workspace admin sees the ones the team screens keep for leads (new channel, new board, new job,
 * new project), exactly as those screens show their own buttons.
 */

/** The address parameter that asks a screen to start its own "new" journey once: `?new=file`. The screen reads it, opens its dialog or box, and removes it. */
export const NEW_PARAM = 'new';

export type NewId =
  | 'chat'
  | 'person'
  | 'channel'
  | 'meeting'
  | 'file-personal'
  | 'file-team'
  | 'appointment'
  | 'action'
  | 'card'
  | 'knowledge'
  | 'folder'
  | 'board'
  | 'job'
  | 'routine'
  | 'bot'
  | 'project'
  | 'knowledge-base';

export type NewIconName = 'chat' | 'person' | 'channel' | 'meeting' | 'file' | 'team-file' | 'appointment' | 'action' | 'card' | 'knowledge' | 'folder' | 'board' | 'job' | 'routine' | 'bot' | 'project' | 'base';

/** What the person is: the menu needs nothing else to decide. `team` is the team the screen is showing (null when they are on none). */
export type NewWho = {
  guest: boolean;
  /** A workspace owner or admin. */
  admin: boolean;
  team: { slug: string; name: string; lead: boolean; archived: boolean } | null;
};

/** Where a row leads: a page that starts its own journey (`to` carries the one-shot parameter), or a dialog the menu opens where the person is. */
export type NewAction = { kind: 'go'; to: string } | { kind: 'dialog'; dialog: 'channel' | 'meeting' };

export type NewItem = {
  id: NewId;
  label: string;
  /** One line under the label: what it makes and where it goes. */
  hint: string;
  icon: NewIconName;
  action: NewAction;
  /** 1 most likely, 2 now and then, 3 set-up. A line is drawn where the tier changes. */
  tier: 1 | 2 | 3;
};

type Needs = 'person' | 'team' | 'lead';

type Def = {
  id: NewId;
  needs: Needs;
  tier: NewItem['tier'];
  icon: NewIconName;
  label: string | ((team: NonNullable<NewWho['team']>) => string);
  hint: string | ((team: NonNullable<NewWho['team']>) => string);
  action: (slug: string) => NewAction;
};

const teamPath = (slug: string, rest: string): string => `/t/${encodeURIComponent(slug)}/${rest}`;
const asked = (path: string, kind: string): string => `${path}?${NEW_PARAM}=${kind}`;

/** The whole list, most likely first. The order of this array is the order of the menu. */
const DEFS: readonly Def[] = [
  { id: 'chat', needs: 'team', tier: 1, icon: 'chat', label: 'New chat with a bot', hint: 'Ask Brain or another bot in a private chat', action: (s) => ({ kind: 'go', to: asked(teamPath(s, 'chat'), 'chat') }) },
  { id: 'person', needs: 'team', tier: 1, icon: 'person', label: 'Message a person', hint: 'Pick one or more people from the team', action: (s) => ({ kind: 'go', to: asked(teamPath(s, 'dms'), 'person') }) },
  { id: 'channel', needs: 'lead', tier: 1, icon: 'channel', label: 'New channel', hint: 'A shared place for a topic', action: () => ({ kind: 'dialog', dialog: 'channel' }) },
  { id: 'meeting', needs: 'team', tier: 1, icon: 'meeting', label: 'New meeting', hint: 'Start an audio or video call with its own chat', action: () => ({ kind: 'dialog', dialog: 'meeting' }) },
  { id: 'file-personal', needs: 'person', tier: 1, icon: 'file', label: 'New personal file', hint: 'A note in your Personal files, only you can open it', action: () => ({ kind: 'go', to: asked('/files', 'file') }) },
  { id: 'file-team', needs: 'team', tier: 1, icon: 'team-file', label: 'New team file', hint: (t) => `A page in ${t.name}’s files`, action: (s) => ({ kind: 'go', to: asked(teamPath(s, 'files'), 'file') }) },
  { id: 'appointment', needs: 'team', tier: 2, icon: 'appointment', label: 'Schedule a meeting', hint: 'Put an appointment on the team schedule', action: (s) => ({ kind: 'go', to: asked(teamPath(s, 'schedule'), 'appointment') }) },
  { id: 'action', needs: 'person', tier: 2, icon: 'action', label: 'New action item', hint: 'Something to do, on your own list', action: () => ({ kind: 'go', to: asked('/account/action-items', 'action') }) },
  { id: 'card', needs: 'team', tier: 2, icon: 'card', label: 'New card', hint: 'A task on a board', action: (s) => ({ kind: 'go', to: asked(teamPath(s, 'boards'), 'card') }) },
  { id: 'knowledge', needs: 'person', tier: 2, icon: 'knowledge', label: 'Add to knowledge', hint: 'Upload a document you or Brain can search', action: () => ({ kind: 'go', to: asked('/knowledge', 'upload') }) },
  { id: 'folder', needs: 'team', tier: 2, icon: 'folder', label: 'New folder', hint: (t) => `In ${t.name}’s files`, action: (s) => ({ kind: 'go', to: asked(teamPath(s, 'files'), 'folder') }) },
  { id: 'board', needs: 'lead', tier: 3, icon: 'board', label: 'New board', hint: 'A saved view over the team’s cards', action: (s) => ({ kind: 'go', to: asked(teamPath(s, 'boards'), 'board') }) },
  { id: 'job', needs: 'lead', tier: 3, icon: 'job', label: 'New job', hint: 'A bot that runs on a schedule', action: (s) => ({ kind: 'go', to: asked(teamPath(s, 'jobs'), 'job') }) },
  { id: 'routine', needs: 'person', tier: 3, icon: 'routine', label: 'New routine', hint: 'A bot that does something for you on a schedule', action: () => ({ kind: 'go', to: asked('/account/routines', 'routine') }) },
  // `Add a bot` is its own page (a helper that proposes the bot, which an approver applies); the roster offers it to everyone but a guest, so the menu does too
  { id: 'bot', needs: 'team', tier: 3, icon: 'bot', label: 'New bot', hint: 'Describe what you need and a helper sets it up', action: (s) => ({ kind: 'go', to: teamPath(s, 'bots/new') }) },
  { id: 'project', needs: 'lead', tier: 3, icon: 'project', label: 'New project', hint: 'Connect a git repository the team’s bots work on', action: (s) => ({ kind: 'go', to: asked(teamPath(s, 'projects'), 'project') }) },
  { id: 'knowledge-base', needs: 'person', tier: 3, icon: 'base', label: 'New knowledge base', hint: 'A named set of documents for Knowledge', action: () => ({ kind: 'go', to: asked('/knowledge', 'base') }) },
];

/** The ids in menu order (what the order test pins down). */
export const NEW_ORDER: readonly NewId[] = DEFS.map((d) => d.id);

/** Whether the person may use a row that has this need. */
function allowed(needs: Needs, who: NewWho): boolean {
  if (who.guest) return false;
  if (needs === 'person') return true;
  const team = who.team;
  if (!team || team.archived) return false;
  return needs === 'team' || who.admin || team.lead;
}

/** The rows this person is offered, in menu order; none for a guest. */
export function newMenuFor(who: NewWho): NewItem[] {
  const out: NewItem[] = [];
  for (const d of DEFS) {
    if (!allowed(d.needs, who)) continue;
    // a row of "person" need works without a team; the ones that name the team's words only exist with one
    const team = who.team;
    const named = (v: string | ((t: NonNullable<NewWho['team']>) => string)): string => (typeof v === 'string' ? v : team ? v(team) : '');
    out.push({
      id: d.id,
      label: named(d.label),
      hint: named(d.hint),
      icon: d.icon,
      tier: d.tier,
      action: d.action(team?.slug ?? ''),
    });
  }
  return out;
}

/** The tier a separator is drawn before: the first row of each tier after the first one shown. */
export function startsTier(items: readonly NewItem[], index: number): boolean {
  const here = items[index];
  const before = items[index - 1];
  return Boolean(here && before && before.tier !== here.tier);
}
