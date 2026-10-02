import { useMemo, useSyncExternalStore } from 'react';
import { useSession } from '../../app/session';
import { usePeople } from '../../channels/hooks';
import { useShell } from '../../shell/context';
import { createBackend, type FilesBackend, type Perms } from './backend';
import type { Actor } from './model';

/*
 * What the Files screen, the preview panel and the History panel share: a counter that moves after every change (they reload what they show),
 * and the store for the team in the URL.
 */
let version = 0;
const subs = new Set<() => void>();
export const bumpFiles = (): void => {
  version += 1;
  for (const s of [...subs]) s();
};
const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb);
  return () => subs.delete(cb);
};
/** Changes whenever a file or folder was added, changed, moved or removed from this page. */
export const useFilesVersion = (): number => useSyncExternalStore(subscribe, () => version, () => 0);

export type TeamFiles = { slug: string; teamName: string; backend: FilesBackend; perms: Perms };

/** The Files store of the current team, or null before the team is known. */
export function useTeamFiles(): TeamFiles | null {
  const { team, teamSlug } = useShell();
  const session = useSession();
  const slug = team?.slug ?? teamSlug ?? '';
  const role = session.teams.find((t) => t.slug === slug)?.role;
  const admin = session.role === 'owner' || session.role === 'admin';
  const leadsTeam = role === 'lead' || admin;
  const personId = session.person.id;
  const personName = session.person.name;
  const people = usePeople();
  return useMemo(() => {
    if (!slug) return null;
    // an actor the roster does not know is a bot (or someone who left): drawn as a bot, never as a person it cannot name
    const who = (id: string | null): Actor | null => {
      if (id === null) return null;
      const p = people.byActor(id);
      return p ? { id, name: p.name, kind: 'person' } : { id, name: 'A bot', kind: 'bot' };
    };
    const perms: Perms = { leadsTeam, personId, personName, who };
    return { slug, teamName: team?.name ?? slug, perms, backend: createBackend(slug, perms) };
  }, [slug, team?.name, leadsTeam, personId, personName, people]);
}
