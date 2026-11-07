import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { PersonalShareCheckResponse, PersonalShareDestination } from '@manythreads/shared';
import { Dialog } from '../../components/Dialog';
import { FilesError } from './backend';
import { baseName, bytesLabel, isTextual, joinPath, nameProblem, parentOf, type FileRow } from './model';
import { ProposeDialog } from '../proposals/ProposeDialog';
import { useProposalPerms } from '../proposals/store';
import { bumpFiles, useFileSpaces, type TeamFiles } from './store';
import { spaceHref } from './spaces';

/*
 * The dialogs of the Files screen: new page, new folder, rename, move, delete. Each one asks, does one thing through the store, tells every
 * screen that files changed, and says what a refusal means in words (a conflict, a path that changes by proposal, a name that is taken).
 */

const messageOf = (err: unknown): string => (err instanceof FilesError ? err.message : err instanceof Error && err.message ? err.message : 'That did not work. Try again.');

function useAsk() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      bumpFiles();
      return true;
    } catch (err) {
      setError(messageOf(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Form({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    onSubmit();
  };
  return <form className="dlg-form" onSubmit={submit}>{children}</form>;
}

function DialogError({ message }: { message: string | null }) {
  return message ? <p className="dlg-error" role="alert">{message}</p> : null;
}

/** A new page (Markdown) or file in the folder that is open. A name without an extension becomes a page. */
export function NewFileDialog({ files, folder, onClose, onDone }: { files: TeamFiles; folder: string; onClose: () => void; onDone: (path: string) => void }) {
  const [name, setName] = useState('');
  const ask = useAsk();
  const problem = name === '' ? null : nameProblem(name);
  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    const bad = nameProblem(trimmed);
    if (bad) return;
    const file = /\.[A-Za-z0-9]{1,8}$/.test(trimmed) ? trimmed : `${trimmed}.md`;
    const path = joinPath(folder, file);
    const title = file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const text = /\.(md|markdown)$/i.test(file) ? `# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n\n` : '';
    if (await ask.run(() => files.backend.create(path, text))) onDone(path);
  };
  return (
    <Dialog
      title={files.space === 'personal' ? 'New note' : 'New page'}
      onClose={onClose}
      testId="dialog-new-file"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={ask.busy || name.trim() === '' || problem !== null} onClick={() => void submit()}>Create</button>
        </>
      }
    >
      <Form onSubmit={() => void submit()}>
        <label className="dlg-label" htmlFor="new-file-name">Name</label>
        <input id="new-file-name" className="dlg-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="release-notes.md" autoComplete="off" spellCheck={false} data-autofocus />
        <p className="dlg-hint">
          {files.space === 'personal' ? <>In <span className="mono">{folder}/</span>. A name without an extension becomes a Markdown note.</> : folder === '' ? 'In the top folder of the team repo.' : <>In <span className="mono">{folder}/</span>. A name without an extension becomes a Markdown page.</>}
        </p>
        {problem ? <p className="dlg-error" role="alert">{problem}</p> : <DialogError message={ask.error} />}
      </Form>
    </Dialog>
  );
}

export function NewFolderDialog({ files, folder, onClose, onDone }: { files: TeamFiles; folder: string; onClose: () => void; onDone: (path: string) => void }) {
  const [name, setName] = useState('');
  const ask = useAsk();
  const problem = name === '' ? null : nameProblem(name);
  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (nameProblem(trimmed)) return;
    const path = joinPath(folder, trimmed);
    if (await ask.run(() => files.backend.createFolder(path))) onDone(path);
  };
  return (
    <Dialog
      title="New folder"
      onClose={onClose}
      testId="dialog-new-folder"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={ask.busy || name.trim() === '' || problem !== null} onClick={() => void submit()}>Create</button>
        </>
      }
    >
      <Form onSubmit={() => void submit()}>
        <label className="dlg-label" htmlFor="new-folder-name">Name</label>
        <input id="new-folder-name" className="dlg-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus />
        <p className="dlg-hint">{files.space === 'personal' ? <>Made inside <span className="mono">{folder === '' ? 'Personal' : `${folder}/`}</span>.</> : 'Git keeps no empty folder, so the folder starts with a placeholder file that the tree hides.'}</p>
        {problem ? <p className="dlg-error" role="alert">{problem}</p> : <DialogError message={ask.error} />}
      </Form>
    </Dialog>
  );
}

export function RenameDialog({ files, row, onClose, onDone }: { files: TeamFiles; row: FileRow; onClose: () => void; onDone: (to: string) => void }) {
  const [name, setName] = useState(row.name);
  const ask = useAsk();
  const problem = nameProblem(name);
  const same = name.trim() === row.name;
  const submit = async (): Promise<void> => {
    if (problem || same) return;
    const to = joinPath(parentOf(row.path), name.trim());
    if (await ask.run(() => files.backend.move(row, to))) onDone(to);
  };
  return (
    <Dialog
      title={`Rename ${row.name}`}
      onClose={onClose}
      testId="dialog-rename"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={ask.busy || problem !== null || same} onClick={() => void submit()}>Rename</button>
        </>
      }
    >
      <Form onSubmit={() => void submit()}>
        <label className="dlg-label" htmlFor="rename-name">New name</label>
        <input id="rename-name" className="dlg-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus />
        <p className="dlg-hint">{files.space === 'personal' ? 'The file keeps its versions.' : 'One commit. The old name stays in History.'}</p>
        {problem && name !== row.name ? <p className="dlg-error" role="alert">{problem}</p> : <DialogError message={ask.error} />}
      </Form>
    </Dialog>
  );
}

/**
 * Moves rows one after the other into a folder (the Move dialog and a drop on a folder both use it). It stops at the first refusal and says which file it
 * was, so nothing is half-explained; what was moved before stays moved. Every screen is told that files changed.
 */
export async function moveRows(files: TeamFiles, rows: readonly FileRow[], target: string): Promise<{ moved: string[]; error: string | null }> {
  const moved: string[] = [];
  let error: string | null = null;
  for (const row of rows) {
    try {
      await files.backend.move(row, joinPath(target, row.name));
      moved.push(joinPath(target, row.name));
    } catch (err) {
      error = rows.length > 1 ? `${row.name}: ${messageOf(err)}` : messageOf(err);
      break;
    }
  }
  if (moved.length > 0) bumpFiles();
  return { moved, error };
}

export function MoveDialog({ files, rows, folders, onClose, onDone }: { files: TeamFiles; rows: readonly FileRow[]; folders: string[]; onClose: () => void; onDone: (to: string[]) => void }) {
  const personal = files.space === 'personal';
  const first = rows[0] as FileRow;
  const same = rows.every((r) => parentOf(r.path) === parentOf(first.path));
  const [folder, setFolder] = useState(same ? parentOf(first.path) : '');
  const ask = useAsk();
  const target = folder.trim().replace(/^\/+|\/+$/g, '');
  const noop = rows.every((r) => joinPath(target, r.name) === r.path);
  const problem = personal && target === '' ? 'Choose a folder: files in Personal live inside one.' : !personal && target.startsWith('channels') ? 'Attachments live under channels/. Files in git cannot go there.' : null;
  const title = rows.length === 1 ? `Move ${first.name}` : `Move ${rows.length} files`;
  const submit = async (): Promise<void> => {
    if (problem || noop) return;
    await ask.run(async () => {
      const r = await moveRows(files, rows, target);
      if (r.error) throw new FilesError('other', r.error);
      onDone(r.moved);
    });
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      testId="dialog-move"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={ask.busy || problem !== null || noop} onClick={() => void submit()}>Move</button>
        </>
      }
    >
      <Form onSubmit={() => void submit()}>
        <label className="dlg-label" htmlFor="move-folder">Move to folder</label>
        <input id="move-folder" className="dlg-input mono" list="move-folders" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={personal ? 'Notes/2026' : 'pages/reports'} autoComplete="off" spellCheck={false} data-autofocus />
        <datalist id="move-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
        <p className="dlg-hint">{personal ? 'A folder that does not exist yet is created.' : 'Leave it empty for the top folder. A folder that does not exist yet is created.'}</p>
        {problem && folder !== '' ? <p className="dlg-error" role="alert">{problem}</p> : <DialogError message={ask.error} />}
      </Form>
    </Dialog>
  );
}

export function DeleteDialog({ files, rows, onClose, onDone }: { files: TeamFiles; rows: readonly FileRow[]; onClose: () => void; onDone: () => void }) {
  const ask = useAsk();
  const first = rows[0] as FileRow;
  const personal = files.space === 'personal';
  const attachment = first.store === 'attachments';
  const folder = first.kind === 'folder';
  const go = async (): Promise<void> => {
    const ok = await ask.run(async () => {
      for (const row of rows) await files.backend.remove(row);
    });
    if (ok) onDone();
  };
  return (
    <Dialog
      title={rows.length > 1 ? `Delete ${rows.length} files?` : `Delete ${baseName(first.path)}?`}
      onClose={onClose}
      testId="dialog-delete"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger" disabled={ask.busy} onClick={() => void go()} data-autofocus>Delete</button>
        </>
      }
    >
      <p className="dlg-text">
        {folder
          ? 'The folder is removed. Only an empty folder can be removed.'
          : personal
            ? `${rows.length > 1 ? 'The files are' : 'The file is'} removed with every earlier version, and the space is freed at once. This cannot be undone.`
            : attachment
              ? 'The attachment is removed from its channel for everyone. This cannot be undone.'
              : 'A new commit removes it. Every earlier version stays in History.'}
      </p>
      <DialogError message={ask.error} />
    </Dialog>
  );
}

const OUTCOME_COPY: Record<PersonalShareCheckResponse['outcome'], string> = {
  allow: "Nothing in this file is held back by your workspace's data rules.",
  redact: "Your workspace's data rules will replace parts of this file before it is sent",
  require_approval: "Your workspace's data rules do not let this file be sent as it is",
  block: "Your workspace's data rules do not allow this file to be sent",
};

/** Sending a copy of a Personal file to a team: into the team's files (text, a commit by you) or into the team's memory inbox. Nothing leaves before the person presses the button. */
export function ShareDialog({ files, row, onClose }: { files: TeamFiles; row: FileRow; onClose: () => void }) {
  const spaces = useFileSpaces();
  const personal = files.personal;
  const canCopy = isTextual(row) && (row.size ?? 0) <= 1_048_576;
  const [destination, setDestination] = useState<PersonalShareDestination>(canCopy ? 'team_files' : 'team_inbox');
  const [teamSlug, setTeamSlug] = useState(spaces.teams[0]?.slug ?? '');
  const [path, setPath] = useState(`pages/${row.name}`);
  const [check, setCheck] = useState<{ key: string; value: PersonalShareCheckResponse | 'error' } | null>(null);
  const [done, setDone] = useState<{ text: string; href: string | null } | null>(null);
  const ask = useAsk();
  const key = `${destination}\0${teamSlug}`;

  useEffect(() => {
    if (!personal || !teamSlug) return;
    let live = true;
    personal.shareCheck(row, destination, teamSlug).then(
      (value) => live && setCheck({ key, value }),
      () => live && setCheck({ key, value: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [personal, row, destination, teamSlug, key]);

  const verdict = check?.key === key ? check.value : null;
  const blocked = verdict !== null && verdict !== 'error' && (verdict.outcome === 'block' || verdict.outcome === 'require_approval');
  const pathProblem = destination === 'team_files' ? (/^\/|\/$|\.\.|\/\//.test(path.trim()) || path.trim() === '' ? 'Give a path such as pages/notes.md.' : null) : null;
  const teamName = spaces.teams.find((t) => t.slug === teamSlug)?.teamName ?? teamSlug;

  const send = async (): Promise<void> => {
    if (!personal || blocked || pathProblem) return;
    await ask.run(async () => {
      if (destination === 'team_files') {
        const res = await personal.copyToTeam(row, teamSlug, path.trim());
        setDone({ text: res.redacted ? `Copied to ${res.path} in ${teamName}. Parts of it were replaced by your workspace's data rules.` : `Copied to ${res.path} in ${teamName}.`, href: spaceHref(teamSlug, { open: res.path }) });
      } else {
        await personal.sendToInbox(row, teamSlug);
        setDone({ text: `Sent to the inbox of ${teamName}. It is read there before it is filed.`, href: null });
      }
    });
  };

  return (
    <Dialog
      title={`Send ${row.name} to a team`}
      onClose={onClose}
      testId="dialog-share"
      footer={
        done ? (
          <button type="button" className="btn primary" onClick={onClose} data-autofocus>Done</button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" data-testid="share-send" disabled={ask.busy || blocked || pathProblem !== null || teamSlug === ''} onClick={() => void send()}>
              {destination === 'team_files' ? 'Copy' : 'Send'}
            </button>
          </>
        )
      }
    >
      {done ? (
        <p className="dlg-text" role="status" data-testid="share-done">
          {done.text}
          {done.href ? <> <a className="flinkish" href={done.href}>Open it</a></> : null}
        </p>
      ) : (
        <Form onSubmit={() => void send()}>
          <fieldset className="dlg-choices">
            <legend className="dlg-label">Where it goes</legend>
            <label className="dlg-choice">
              <input type="radio" name="share-destination" value="team_files" checked={destination === 'team_files'} disabled={!canCopy} onChange={() => setDestination('team_files')} data-testid="share-to-files" />
              <span>
                <b>The team's files</b>
                <span className="dlg-hint">{canCopy ? "A copy as a page in the team's files, saved as you." : `Only text files up to 1 MB can be copied here. This one is ${bytesLabel(row.size ?? 0)}.`}</span>
              </span>
            </label>
            <label className="dlg-choice">
              <input type="radio" name="share-destination" value="team_inbox" checked={destination === 'team_inbox'} onChange={() => setDestination('team_inbox')} data-testid="share-to-inbox" />
              <span>
                <b>The team's inbox</b>
                <span className="dlg-hint">The team's memory reads it and files what is useful.</span>
              </span>
            </label>
          </fieldset>
          <label className="dlg-label" htmlFor="share-team">Team</label>
          <select id="share-team" className="dlg-input" value={teamSlug} onChange={(e) => setTeamSlug(e.target.value)} data-testid="share-team">
            {spaces.teams.map((t) => <option key={t.slug} value={t.slug}>{t.teamName}</option>)}
          </select>
          {destination === 'team_files' ? (
            <>
              <label className="dlg-label" htmlFor="share-path">Path in the team's files</label>
              <input id="share-path" className="dlg-input mono" value={path} onChange={(e) => setPath(e.target.value)} autoComplete="off" spellCheck={false} data-testid="share-path" />
              {pathProblem ? <p className="dlg-error" role="alert">{pathProblem}</p> : null}
            </>
          ) : null}
          {verdict === null ? <p className="dlg-hint" aria-busy="true">Checking your workspace's data rules…</p> : null}
          {verdict === 'error' ? <p className="dlg-hint">The data rules could not be checked just now. They are checked again when you send.</p> : null}
          {verdict !== null && verdict !== 'error' ? (
            <p className={verdict.outcome === 'allow' ? 'dlg-hint' : 'dlg-error'} role={verdict.outcome === 'allow' ? 'status' : 'alert'} data-testid="share-verdict" data-outcome={verdict.outcome}>
              {OUTCOME_COPY[verdict.outcome]}
              {verdict.outcome !== 'allow' && verdict.rules.length > 0 ? ` (${verdict.rules.join(', ')}).` : verdict.outcome !== 'allow' ? '.' : ''}
            </p>
          ) : null}
          <DialogError message={ask.error} />
        </Form>
      )}
    </Dialog>
  );
}

/** The one way to change bots/, skills/, routines/ and TEAM.md from Files (PLAN P7-01): a proposal that a team lead or workspace admin applies. */
export function ProposeChangeDialog({ path, onClose, initialText, title }: { path: string; onClose: () => void; initialText?: string; title?: string }) {
  const { slug, canApply } = useProposalPerms();
  return <ProposeDialog slug={slug} path={path} mode="edit" canApply={canApply} onClose={() => { bumpFiles(); onClose(); }} {...(initialText !== undefined ? { initialText } : {})} {...(title ? { initialTitle: title } : {})} />;
}
