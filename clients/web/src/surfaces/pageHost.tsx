import { useContext, useMemo, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { fetchChannel } from '../api/endpoints';
import { onPersonChange } from '../app/caches';
import { usePeople, type People } from '../channels/hooks';
import { usePanel } from '../kernel/panel';
import { fetchApprovals } from '../screens/approvals/api';
import { fetchTask } from '../screens/boards/api';
import { STATE_LABEL } from '../screens/boards/board';
import { ShellContext } from '../shell/context';
import { channelPath } from '../shell/nav';
import type { SurfaceHost } from './host';

/*
 * What the app lends a bot's screen inside a message (PLAN P9-05): the person, channel, card and approval parts show what their id means to the person looking,
 * and open it. Every answer comes from a request the viewer's own session makes (the roster the shell already holds, `GET /api/channels/:id`, the board's task
 * route, the team's approvals lists), never from what the bot can see; a refusal or a miss leaves the part drawing the bot's label, and opening nothing. Links
 * are built here from the id, so nothing the bot wrote becomes an address. Answers are kept for the page (and dropped when the signed-in person changes), so a
 * screen with many chips asks once per id.
 */

type Answer<T> = { state: 'loading' } | { state: 'ok'; value: T | null };

/** A small cache of lookups by key: the first read starts the request (after the render), and a finished one tells the screens to draw again. */
export class Lookups {
  private readonly held = new Map<string, Answer<unknown>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  /** Bumped by `clear`: an answer to a request made before it belongs to the person who was signed in then, and is dropped. */
  private generation = 0;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): number => this.version;

  /** The answer for `key`, or null while it is not known (yet, or at all). `load` resolves to null for "not for this viewer". */
  get<T>(key: string, load: () => Promise<T | null>): T | null {
    const had = this.held.get(key) as Answer<T> | undefined;
    if (had) return had.state === 'ok' ? had.value : null;
    this.held.set(key, { state: 'loading' });
    const generation = this.generation;
    // the request starts after this render: a render never sets state
    queueMicrotask(() => {
      if (generation !== this.generation) return;
      load().then(
        (value) => this.settle(generation, key, value),
        () => this.settle(generation, key, null),
      );
    });
    return null;
  }

  private settle(generation: number, key: string, value: unknown): void {
    // asked before a clear (the person changed): never shown to whoever is signed in now, even when the same key was asked again since
    if (generation !== this.generation || !this.held.has(key)) return;
    this.held.set(key, { state: 'ok', value });
    this.version += 1;
    for (const l of [...this.listeners]) l();
  }

  clear(): void {
    this.generation += 1;
    this.held.clear();
    this.version += 1;
    for (const l of [...this.listeners]) l();
  }
}

export const surfaceLookups = new Lookups();
onPersonChange(() => surfaceLookups.clear());

type ChannelInfo = { name: string; teamId: string | null };
const APPROVAL_STATUS = { pending: 'waiting', approved: 'approved', denied: 'declined', expired: 'expired' } as const;

/** The person behind an id a bot wrote: a person id or an actor id, as the roster has them. */
export function personOf(people: People, id: string): { personId: string; name: string } | null {
  const p = people.byPerson(id) ?? people.byActor(id);
  return p ? { personId: p.personId, name: p.name } : null;
}

/** The kinds of EntityCard this page can look up: a card on a board. */
export const CARD_KINDS: ReadonlySet<string> = new Set(['task', 'card']);

/** Builds the host from the page's own pieces; kept apart from the hook so a test can give it fakes. */
export function buildPageHost(deps: {
  people: People;
  teamSlug: string | null;
  slugOf: (teamId: string | null) => string | null;
  lookups: Lookups;
  go: (to: string) => void;
  openMember: (personId: string) => void;
  loadChannel: (id: string) => Promise<ChannelInfo | null>;
  loadCard: (slug: string, id: string) => Promise<{ label: string; summary?: string } | null>;
  loadApprovals: (slug: string) => Promise<Map<string, 'waiting' | 'approved' | 'declined' | 'expired'>>;
}): SurfaceHost {
  const { people, teamSlug, lookups } = deps;
  const channel = (id: string): ChannelInfo | null => lookups.get(`channel:${id}`, () => deps.loadChannel(id));
  const approvals = (slug: string): Map<string, 'waiting' | 'approved' | 'declined' | 'expired'> | null => lookups.get(`approvals:${slug}`, () => deps.loadApprovals(slug));
  return {
    personName: (id) => personOf(people, id)?.name ?? null,
    openPerson: (id) => {
      const p = personOf(people, id);
      if (p) deps.openMember(p.personId);
    },
    channelName: (id) => channel(id)?.name ?? null,
    openChannel: (id) => {
      const c = channel(id);
      const slug = c ? (deps.slugOf(c.teamId) ?? teamSlug) : null;
      if (c && slug) deps.go(channelPath(slug, c.name));
    },
    entity: (entityType, id) => {
      if (!CARD_KINDS.has(entityType) || !teamSlug) return null;
      return lookups.get(`card:${teamSlug}:${id}`, () => deps.loadCard(teamSlug, id));
    },
    openEntity: (entityType, id) => {
      if (CARD_KINDS.has(entityType) && teamSlug) deps.go(`/t/${encodeURIComponent(teamSlug)}/boards?card=${encodeURIComponent(id)}`);
    },
    approvalStatus: (id) => (teamSlug ? (approvals(teamSlug)?.get(id) ?? null) : null),
    openApproval: (id) => {
      if (teamSlug) deps.go(`/t/${encodeURIComponent(teamSlug)}/approvals?approval=${encodeURIComponent(id)}`);
    },
  };
}

/** A UUID: the only ids the routes below take (anything else a bot wrote is not looked up). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_TEAMS: readonly { id: string; slug: string }[] = [];

/** The host for a bot's screen in a message, as the person looking. */
export function usePageSurfaceHost(): SurfaceHost {
  const people = usePeople();
  // outside the app's shell (no team in sight) nothing is looked up by team
  const shell = useContext(ShellContext);
  const teams = shell?.teams ?? NO_TEAMS;
  const navigate = useNavigate();
  const panel = usePanel();
  // a finished lookup draws the screen again
  const version = useSyncExternalStore(surfaceLookups.subscribe, surfaceLookups.snapshot, surfaceLookups.snapshot);
  const teamSlug = !shell || shell.guest ? null : (shell.team?.slug ?? null);
  return useMemo(() => {
    // a new host for each finished lookup, so the parts draw again with what it found
    void version;
    return buildPageHost({
      people,
      teamSlug,
      slugOf: (teamId) => (teamId ? (teams.find((t) => t.id === teamId)?.slug ?? null) : null),
      lookups: surfaceLookups,
      go: (to) => void navigate(to),
      openMember: (personId) => panel.push({ type: 'member', id: personId }),
      loadChannel: async (id) => {
        if (!UUID.test(id)) return null;
        const r = await fetchChannel(id);
        // a direct message has no name to show or open by
        return r.channel.kind === 'channel' ? { name: r.channel.name.replace(/^#/, ''), teamId: r.channel.teamId } : null;
      },
      loadCard: async (slug, id) => {
        if (!UUID.test(id)) return null;
        const { task } = await fetchTask(slug, id);
        return { label: task.title, summary: STATE_LABEL[task.state] };
      },
      loadApprovals: async (slug) => {
        const [waiting, decided] = await Promise.all([fetchApprovals(slug, 'pending'), fetchApprovals(slug, 'decided')]);
        return new Map([...waiting.items, ...decided.items].map((a) => [a.id as string, APPROVAL_STATUS[a.status]]));
      },
    });
  }, [people, teamSlug, teams, navigate, panel, version]);
}
