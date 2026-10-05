import { useCallback, useEffect, useMemo, useState } from 'react';
import { BotFrontmatter, parseBotMd, renderBotMd, splitBotMd, type BotFrontmatter as BotFrontmatterData, type BotSection } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { useShell } from '../../shell/context';
import { fetchBot, fetchBots, readDefinition, writeDefinition, type DefinitionFile } from './api';

/*
 * The Bots screens' state (PLAN P5-05): the roster for the current team, and — on a bot page — the definition being edited, held as
 * the parsed frontmatter and the body so each of the thirteen tabs edits one part of it and Save renders the whole file once.
 */

/**
 * Who may edit a bot on this page: the team's lead or a workspace admin (SPEC §3 as this workspace set it). The page only ever rewrites a bot
 * that already exists, so adding or removing one — an admin's alone — is not on offer here; the repo writer enforces the same rule again on save.
 */
export function useBotPerms(): { slug: string; canEdit: boolean } {
  const { team, teamSlug } = useShell();
  const session = useSession();
  const slug = team?.slug ?? teamSlug ?? '';
  const admin = session.role === 'owner' || session.role === 'admin';
  const lead = session.teams.find((t) => t.slug === slug)?.role === 'lead';
  return { slug, canEdit: admin || lead };
}

export function useBots() {
  const { slug } = useBotPerms();
  return { slug, q: useQuery(`bots:${slug}`, () => fetchBots(slug)) };
}

export function useBot(botSlug: string) {
  const { slug, canEdit } = useBotPerms();
  return { slug, canEdit, q: useQuery(`bot:${slug}:${botSlug}`, () => fetchBot(slug, botSlug)) };
}

/** The tabs of the bot page, in the order of SPEC §7.2 (the prototype's own order, `[proto §05]`). */
export const BOT_TABS: ReadonlyArray<{ id: string; label: string; section: BotSection }> = [
  { id: 'identity', label: 'Identity', section: 'Identity' },
  { id: 'behaviour', label: 'Behaviour', section: 'Behaviour' },
  { id: 'triggers', label: 'Triggers', section: 'Triggers' },
  { id: 'capabilities', label: 'Capabilities', section: 'Capabilities' },
  { id: 'knowledge', label: 'Knowledge', section: 'Knowledge' },
  { id: 'memory', label: 'Memory', section: 'Memory' },
  { id: 'model', label: 'Model', section: 'Model' },
  { id: 'guard', label: 'Guard', section: 'Guard' },
  { id: 'approvals', label: 'Approvals', section: 'Approvals' },
  { id: 'handover', label: 'Handover', section: 'Handover' },
  { id: 'placement', label: 'Placement & limits', section: 'Placement & limits' },
  { id: 'contract', label: 'Contract', section: 'Contract' },
  { id: 'evals', label: 'Evals', section: 'Evals' },
  { id: 'audit', label: 'Audit', section: 'Audit' },
];

/**
 * The definition being edited. Loads the file once, then keeps a draft: `frontmatter` is the parsed shape every tab writes into,
 * `body` is the prose after the fence, and `text()` renders the whole file the way the loader will read it.
 *
 * A file that does not parse at all (someone hand-edited it into a broken state) is not editable here: the page shows the red banner
 * and the raw file, and fixing it happens in Files — an editor that silently rewrote a definition it could not read would lose the
 * author's words.
 */
export type DefinitionDraft = {
  status: 'loading' | 'ready' | 'unreadable' | 'error';
  /** The frontmatter as loaded (unmodified), for the diff line and for a reset. */
  original: BotFrontmatterData | null;
  frontmatter: BotFrontmatterData | null;
  body: string;
  /** The text as loaded, so the page can tell whether anything changed. */
  originalText: string;
  dirty: boolean;
  /** Why the file does not parse (`fieldPath`, `message`), when it does not. */
  unreadable: { fieldPath: string | null; message: string } | null;
  error: string | null;
  /** The blob the draft was read from; a save sends it, so a concurrent edit is refused rather than overwritten. */
  baseBlobSha: string | null;
  patch: (change: (fm: BotFrontmatterData) => BotFrontmatterData) => void;
  setBody: (body: string) => void;
  reset: () => void;
  /** The whole file, exactly as it will be committed. */
  text: () => string;
  /** The body as loaded, for the "edited" marker on the Behaviour tab. */
  originalBody: string;
};

export function useDefinition(slug: string, path: string, revision: number): DefinitionDraft & { reload: () => void } {
  const q = useQuery<DefinitionFile>(`bot-md:${slug}:${path}:${revision}`, () => readDefinition(slug, path));
  const [draft, setDraft] = useState<{ frontmatter: BotFrontmatterData; body: string; baseBlobSha: string | null } | null>(null);

  const loaded = q.status === 'ok' ? q.data : null;
  const parsed = useMemo(() => (loaded ? parseBotMd(loaded.content) : null), [loaded]);
  const split = useMemo(() => (loaded ? splitBotMd(loaded.content) : null), [loaded]);

  // The draft is seeded from the file and replaced only when a different blob is loaded (a save, a manual reload). It is state, not
  // derived, so a tab's edit survives a re-render — a `useMemo` that only ever built it from the file would drop every keystroke.
  useEffect(() => {
    if (!loaded) return;
    if (!parsed?.ok || !split?.ok) return setDraft(null);
    setDraft((d) => (d && d.baseBlobSha === loaded.blobSha ? d : { frontmatter: parsed.frontmatter, body: split.body, baseBlobSha: loaded.blobSha }));
  }, [loaded, parsed, split]);

  const patch = useCallback((change: (fm: BotFrontmatterData) => BotFrontmatterData) => {
    setDraft((d) => {
      if (!d) return d;
      const next = change(d.frontmatter);
      // The schema is the authority: a change that would not load is not kept, so no tab can write a file the loader refuses.
      const checked = BotFrontmatter.safeParse(next);
      return checked.success ? { ...d, frontmatter: checked.data } : d;
    });
  }, []);
  const setBody = useCallback((body: string) => setDraft((d) => (d ? { ...d, body } : d)), []);
  // Discard restores the loaded file, not an empty draft: the page still describes the bot after a reset.
  const reset = useCallback(() => {
    setDraft((d) => (d && parsed?.ok && split?.ok ? { frontmatter: parsed.frontmatter, body: split.body, baseBlobSha: loaded?.blobSha ?? d.baseBlobSha } : d));
  }, [parsed, split, loaded]);

  const render = (fm: BotFrontmatterData, body: string): string => renderBotMd(fm, body);
  const text = useCallback(() => (draft ? render(draft.frontmatter, draft.body) : (loaded?.content ?? '')), [draft, loaded]);

  const originalText = loaded?.content ?? '';
  const originalBody = split?.ok ? split.body : '';
  // "Changed" is judged on the canonical rendering, not the file's bytes: a definition the loader reformatted would otherwise look
  // edited the moment it is opened (and Save would commit a pure reformat).
  const originalRender = parsed?.ok ? render(parsed.frontmatter, originalBody) : null;
  const status: DefinitionDraft['status'] = q.status === 'loading' ? 'loading' : q.status === 'error' ? 'error' : parsed?.ok ? 'ready' : 'unreadable';

  return {
    status,
    original: parsed?.ok ? parsed.frontmatter : null,
    frontmatter: draft?.frontmatter ?? null,
    body: draft?.body ?? '',
    originalBody,
    originalText,
    dirty: draft !== null && originalRender !== null && render(draft.frontmatter, draft.body) !== originalRender,
    unreadable: parsed && !parsed.ok ? parsed.failure : null,
    error: q.status === 'error' ? (isApiError(q.error) ? q.error.message : 'Could not read the definition.') : null,
    baseBlobSha: draft?.baseBlobSha ?? null,
    patch,
    setBody,
    reset,
    text,
    reload: q.reload,
  };
}

/** The commit message a save makes: the file is the bot, so it says which bot and what changed in one line. */
export const saveMessage = (slug: string, name: string): string => `Update ${slug} (${name})`;

/** A save's failure as the page words it (403 offers a pull request, 409 offers a reload, 404 means the file is gone). */
export type SaveFailure = { kind: 'forbidden' | 'conflict' | 'missing' | 'other'; message: string };

export function saveFailureOf(err: unknown): SaveFailure {
  if (isApiError(err)) {
    if (err.status === 403 || err.code === 'forbidden') return { kind: 'forbidden', message: 'You cannot change this definition directly. Changes to bots/ go by pull request, or ask a workspace admin.' };
    if (err.status === 409 || err.code === 'conflict') return { kind: 'conflict', message: 'Someone changed this definition while you were editing. Reload it to see their version; nothing was overwritten.' };
    if (err.status === 404) return { kind: 'missing', message: 'This definition no longer exists in the team repo.' };
    return { kind: 'other', message: err.message };
  }
  return { kind: 'other', message: err instanceof Error ? err.message : 'Could not save the definition.' };
}

export { writeDefinition };