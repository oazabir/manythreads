import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { channelStore, type Snapshot } from './store';
import type { Timeline } from './timeline';
import { fetchRoster } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { useSession } from '../app/session';
import { personHandles, type RosterMember } from '@manythreads/shared';

export function useTimeline(key: string): Timeline {
  return useSyncExternalStore(channelStore.subscribe, () => channelStore.get(key));
}

export function useUnread(): Snapshot {
  return useSyncExternalStore(channelStore.subscribe, channelStore.snapshot);
}

export type Person = { personId: string; actorId: string; name: string; email: string; role: RosterMember['role'] };
export type People = {
  loaded: boolean;
  list: Person[];
  byActor(actorId: string): Person | undefined;
  byPerson(personId: string): Person | undefined;
  /** The signed-in person on this roster (their actor id decides which messages are theirs). */
  me: Person | undefined;
  /** Lead of the team or a workspace admin: may remove other people's messages. */
  canModerate: boolean;
};

export const PeopleContext = createContext<People | null>(null);

const NOBODY: People = { loaded: false, list: [], byActor: () => undefined, byPerson: () => undefined, me: undefined, canModerate: false };

/** The team's people as the shell loaded them (outside the shell: nobody). */
export function usePeople(): People {
  return useContext(PeopleContext) ?? NOBODY;
}

/** Loads the team's roster once for the shell: names, avatars, the @ picker and "mine". A person who cannot read the roster (a guest) sees names as "Someone". */
export function useLoadPeople(teamSlug: string | null): People {
  const session = useSession();
  const q = useQuery(`people:${teamSlug ?? ''}`, () => (teamSlug ? fetchRoster(teamSlug) : Promise.resolve({ members: [] })));
  const members = q.status === 'ok' ? q.data.members : undefined;
  const value = useMemo<People>(() => {
    const list: Person[] = (members ?? []).map((m) => ({ personId: m.personId, actorId: m.actorId, name: m.displayName, email: m.email, role: m.role }));
    const byActor = new Map(list.map((p) => [p.actorId, p]));
    const byPerson = new Map(list.map((p) => [p.personId, p]));
    const me = byPerson.get(session.person.id);
    const admin = session.role === 'owner' || session.role === 'admin';
    return { loaded: members !== undefined, list, byActor: (id) => byActor.get(id), byPerson: (id) => byPerson.get(id), me, canModerate: admin || me?.role === 'lead' };
  }, [members, session.person.id, session.role]);
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

