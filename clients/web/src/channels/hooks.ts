import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { channelStore, type Snapshot } from './store';
import type { Timeline } from './timeline';
import { fetchRoster } from '../api/endpoints';
import { fetchBots } from '../screens/bots/api';
import { useQuery } from '../app/useQuery';
import { useSession } from '../app/session';
import { personHandles, type RosterMember } from '@manythreads/shared';

export function useTimeline(key: string): Timeline {
  return useSyncExternalStore(channelStore.subscribe, () => channelStore.get(key));
}

export function useUnread(): Snapshot {
  return useSyncExternalStore(channelStore.subscribe, channelStore.snapshot);
}

export type Person = { personId: string; actorId: string; name: string; email: string; role: RosterMember['role']; /** `preset:<id>`, `photo:<hash>` or null (initials). */ avatar: string | null };
export type People = {
  loaded: boolean;
  /** The roster of this team has answered (or failed): until then `me` is unknown, not absent. False without a team (a guest has no roster). */
  settled: boolean;
  list: Person[];
  byActor(actorId: string): Person | undefined;
  byPerson(personId: string): Person | undefined;
  /** The picture a bot of this team has (by its actor id, the author of its messages); undefined for an actor that is not a known bot. */
  botAvatar(actorId: string): string | null | undefined;
  /** The same, by the bot's slug in this team. */
  botAvatarBySlug(slug: string): string | null | undefined;
  /** The signed-in person on this roster (their actor id decides which messages are theirs). */
  me: Person | undefined;
  /** Lead of the team or a workspace admin: may remove other people's messages. */
  canModerate: boolean;
};

export const PeopleContext = createContext<People | null>(null);

const NOBODY: People = { loaded: false, settled: false, list: [], byActor: () => undefined, byPerson: () => undefined, botAvatar: () => undefined, botAvatarBySlug: () => undefined, me: undefined, canModerate: false };

/** The team's people as the shell loaded them (outside the shell: nobody). */
export function usePeople(): People {
  return useContext(PeopleContext) ?? NOBODY;
}

/** Loads the team's roster once for the shell: names, avatars, the @ picker and "mine". A person who cannot read the roster (a guest) sees names as "Someone". */
export function useLoadPeople(teamSlug: string | null): People {
  const session = useSession();
  // `useQuery` keeps the last answer while a new key loads, so the answer says which team it is for
  const q = useQuery<{ slug: string | null; members: RosterMember[] }>(`people:${teamSlug ?? ''}`, () =>
    teamSlug ? fetchRoster(teamSlug).then((r) => ({ slug: teamSlug, members: r.members })) : Promise.resolve({ slug: null, members: [] }),
  );
  // the team's bots, only for their pictures; a roster that cannot be read (a guest) simply leaves the initials
  const botsQ = useQuery<{ slug: string | null; bots: { slug: string; actorId: string | null; avatar: string | null }[] }>(`people-bots:${teamSlug ?? ''}`, () =>
    teamSlug
      ? fetchBots(teamSlug).then((r) => ({ slug: teamSlug, bots: r.bots.map((b) => ({ slug: b.slug, actorId: b.actorId ?? null, avatar: b.avatar })) })).catch(() => ({ slug: teamSlug, bots: [] }))
      : Promise.resolve({ slug: null, bots: [] }),
  );
  const botList = botsQ.status === 'ok' && botsQ.data.slug === teamSlug ? botsQ.data.bots : undefined;
  const members = q.status === 'ok' ? q.data.members : undefined;
  const settled = q.status === 'error' || (q.status === 'ok' && teamSlug !== null && q.data.slug === teamSlug);
  const value = useMemo<People>(() => {
    // the signed-in person's own choice is the session's (it changes at once when they pick one); everyone else's is the roster's
    const list: Person[] = (members ?? []).map((m) => ({ personId: m.personId, actorId: m.actorId, name: m.displayName, email: m.email, role: m.role, avatar: m.personId === session.person.id ? session.person.avatar : m.avatar }));
    const byActor = new Map(list.map((p) => [p.actorId, p]));
    const botByActor = new Map((botList ?? []).filter((b) => b.actorId !== null).map((b) => [b.actorId as string, b.avatar]));
    const botBySlug = new Map((botList ?? []).map((b) => [b.slug, b.avatar]));
    const byPerson = new Map(list.map((p) => [p.personId, p]));
    const me = byPerson.get(session.person.id);
    const admin = session.role === 'owner' || session.role === 'admin';
    return { loaded: members !== undefined, settled, list, byActor: (id) => byActor.get(id), byPerson: (id) => byPerson.get(id), botAvatar: (id) => botByActor.get(id), botAvatarBySlug: (s) => botBySlug.get(s), me, canModerate: admin || me?.role === 'lead' };
  }, [members, botList, settled, session.person.id, session.person.avatar, session.role]);
  useEffect(() => {
    channelStore.setSelf(value.me?.actorId ?? null);
  }, [value.me?.actorId]);
  return value;
}

/** The handle to insert for a person in the @ picker: their first name when it is unique on the list, else the full-name handle. */
export function handleFor(person: Person, all: readonly Person[]): string {
  const h = personHandles({ displayName: person.name, email: person.email });
  if (h.first && all.filter((p) => personHandles({ displayName: p.name, email: p.email }).first === h.first).length === 1) return h.first;
  return h.exact[1] ?? h.exact[0] ?? h.first ?? person.name;
}

function typingText(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

export function useTyping(key: string): string | null {
  const people = usePeople();
  const entries = useSyncExternalStore(channelStore.subscribe, () => channelStore.typingIn(key));
  const now = Date.now();
  const names = entries.filter((e) => e.until > now).map((e) => people.byPerson(e.personId)?.name ?? 'Someone');
  return typingText(names);
}

