import { useMemo, useSyncExternalStore } from 'react';
import { useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { usePeople } from '../../channels/hooks';
import { useShell } from '../../shell/context';
import { fetchBots } from '../bots/api';
import { createBackend, type FilesBackend, type Perms } from './backend';
import type { Actor } from './model';
import { createPersonal, type PersonalOps } from './personalBackend';
import { PERSONAL, adminViewKey, parsePanelId } from './spaces';

/*
 * What the Files screen, the preview panel and the History panel share: a counter that moves after every change (they reload what they show),
 * and the stores: Personal (the signed-in person's own files) and one for each team they can read. Each store is one backend with the rights of
 * the signed-in person in that space.
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

/**
 * One space of the Files screen. `slug` is the team's slug, or `~me` for Personal (see `spaces.ts`); `teamName` is what the breadcrumb calls the space.
 * The name stays `TeamFiles` because the viewers, dialogs and panels were written for a team and read the same fields.
 */
export type TeamFiles = {
  slug: string;
  teamName: string;
  backend: FilesBackend;
  perms: Perms;
  space: 'team' | 'personal';
  /** Only a Personal store has these (the allowance, sending a file to a team). */
  personal?: PersonalOps;
};

export type FileSpaces = {
  /** The signed-in person's own space; null for a guest, who has none. */
  personal: TeamFiles | null;
  /** The teams the person can read, in the order the session lists them. */
  teams: TeamFiles[];
  /** Any of them by key (`~me` or a team slug). */
  get: (key: string) => TeamFiles | null;
};

const botsCache = new Map<string, { at: number; load: Promise<{ slug: string | null; list: Array<{ actorId: string | null; name: string; avatar: string | null }> }> }>();
/** A team's bots, asked once a minute however many components draw "By" (the screen, the panels and the viewer each build a store). */
function botsOf(slug: string) {
  const hit = botsCache.get(slug);
  if (hit && Date.now() - hit.at < 60_000) return hit.load;
  const load = fetchBots(slug)
    .then((r) => ({ slug, list: r.bots.map((b) => ({ actorId: b.actorId ?? null, name: b.name, avatar: b.avatar })) }))
    .catch(() => ({ slug, list: [] }));
  botsCache.set(slug, { at: Date.now(), load });
  return load;
}

/** Who an actor id is: a person of the roster, a bot of the team (with its picture), or "A bot" for an actor neither list knows. */
function useWho(teamSlug: string | null): (id: string | null) => Actor | null {
  const people = usePeople();
  const bots = useQuery(`files-bots:${teamSlug ?? ''}`, () => (teamSlug ? botsOf(teamSlug) : Promise.resolve({ slug: null as string | null, list: [] as Array<{ actorId: string | null; name: string; avatar: string | null }> })));
  const botList = bots.status === 'ok' ? bots.data.list : null;
  return useMemo(() => {
    const byActor = new Map((botList ?? []).filter((b) => b.actorId !== null).map((b) => [b.actorId as string, b]));
    return (id: string | null): Actor | null => {
      if (id === null) return null;
      const p = people.byActor(id);
      if (p) return { id, name: p.name, kind: 'person', avatar: p.avatar ?? null, personId: p.personId };
      const b = byActor.get(id);
      return b ? { id, name: b.name, kind: 'bot', avatar: b.avatar } : { id, name: 'A bot', kind: 'bot' };
    };
  }, [people, botList]);
}

/** The stores of the screen: Personal (not for a guest) and every team in the session, plus the team in the URL when the session does not list it. */
export function useFileSpaces(): FileSpaces {
  const { team, teamSlug, guest } = useShell();
  const session = useSession();
  const slug = team?.slug ?? teamSlug ?? '';
  const isAdmin = session.role === 'owner' || session.role === 'admin';
  const personId = session.person.id;
  const personName = session.person.name;
  const who = useWho(slug || null);
  const sessionTeams = session.teams;
  const shellTeamName = team?.name ?? slug;
  return useMemo(() => {
    const perms = (leadsTeam: boolean): Perms => ({ leadsTeam, isAdmin, personId, personName, who });
    const teams: TeamFiles[] = [];
    const add = (s: string, name: string, role: string | undefined): void => {
      if (!s || teams.some((t) => t.slug === s)) return;
      const p = perms(role === 'lead' || isAdmin);
      teams.push({ slug: s, teamName: name, perms: p, backend: createBackend(s, p), space: 'team' });
    };
    // the team in the URL comes first when the person is in it; the others keep the session's order
    for (const t of sessionTeams) add(t.slug, t.name, t.role);
    if (slug && !teams.some((t) => t.slug === slug)) add(slug, shellTeamName, undefined);
    let personal: TeamFiles | null = null;
    if (!guest) {
      const p = perms(false);
      const backend = createPersonal(p);
      personal = { slug: PERSONAL, teamName: 'Personal', perms: p, backend, space: 'personal', personal: backend.personal };
    }
    const all = new Map<string, TeamFiles>([...teams, ...(personal ? [personal] : [])].map((s) => [s.slug, s]));
    return { personal, teams, get: (key) => all.get(key) ?? null };
  }, [sessionTeams, slug, shellTeamName, isAdmin, personId, personName, who, guest]);
}

/** The Files store of the current team, or null before the team is known. */
export function useTeamFiles(): TeamFiles | null {
  const { team, teamSlug } = useShell();
  const spaces = useFileSpaces();
  return spaces.get(team?.slug ?? teamSlug ?? '');
}

/**
 * An admin's read-only view of one person's Personal space (during an audited open). The store lists through
 * `GET /api/people/:personId/files/tree`; every row says `admin_view`, so no action that changes anything is offered.
 */
export function useAdminFiles(personId: string | null): TeamFiles | null {
  const session = useSession();
  const who = useWho(null);
  const adminId = session.person.id;
  const adminName = session.person.name;
  return useMemo(() => {
    if (!personId) return null;
    const perms: Perms = { leadsTeam: false, isAdmin: true, personId: adminId, personName: adminName, who };
    const backend = createPersonal(perms, { personId });
    return { slug: adminViewKey(personId), teamName: 'Personal', perms, backend, space: 'personal', personal: backend.personal };
  }, [personId, adminId, adminName, who]);
}

/**
 * The store and path a right-panel entry names: `~me/<path>` is a Personal file, anything else a file of the current team (a repo path or an
 * attachment's file id).
 */
export function usePanelFiles(entryId: string): { files: TeamFiles | null; id: string } {
  const spaces = useFileSpaces();
  const { team, teamSlug } = useShell();
  const parsed = parsePanelId(entryId);
  return { files: parsed.space === 'personal' ? spaces.personal : spaces.get(team?.slug ?? teamSlug ?? ''), id: parsed.path };
}
