import { useState, type FormEvent, type ReactNode } from 'react';
import { Dialog } from '../../components/Dialog';
import { FilesError } from './backend';
import { baseName, joinPath, nameProblem, parentOf, type FileRow } from './model';
import { bumpFiles, type TeamFiles } from './store';

/*
 * The dialogs of the Files screen: new page, new folder, rename, move, delete. Each one asks, does one thing through the store, tells every
 * screen that files changed, and says what a refusal means in words (a conflict, a pull-request-only path, a name that is taken).
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
      title="New page"
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
        <p className="dlg-hint">{folder === '' ? 'In the top folder of the team repo.' : <>In <span className="mono">{folder}/</span>. A name without an extension becomes a Markdown page.</>}</p>
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
        <p className="dlg-hint">Git keeps no empty folder, so the folder starts with a placeholder file that the tree hides.</p>
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
        <p className="dlg-hint">One commit. The old name stays in History.</p>
        {problem && name !== row.name ? <p className="dlg-error" role="alert">{problem}</p> : <DialogError message={ask.error} />}
      </Form>
    </Dialog>
  );
}

export function MoveDialog({ files, row, folders, onClose, onDone }: { files: TeamFiles; row: FileRow; folders: string[]; onClose: () => void; onDone: (to: string) => void }) {
  const [folder, setFolder] = useState(parentOf(row.path));
  const ask = useAsk();
  const target = folder.trim().replace(/^\/+|\/+$/g, '');
  const to = joinPath(target, row.name);
  const problem = target.startsWith('channels') ? 'Attachments live under channels/. Files in git cannot go there.' : null;
  const same = to === row.path;
  const submit = async (): Promise<void> => {
    if (problem || same) return;
    if (await ask.run(() => files.backend.move(row, to))) onDone(to);
  };
  return (
    <Dialog
      title={`Move ${row.name}`}
      onClose={onClose}
      testId="dialog-move"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={ask.busy || problem !== null || same} onClick={() => void submit()}>Move</button>
        </>
      }
    >
      <Form onSubmit={() => void submit()}>
        <label className="dlg-label" htmlFor="move-folder">Move to folder</label>
        <input id="move-folder" className="dlg-input mono" list="move-folders" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="pages/reports" autoComplete="off" spellCheck={false} data-autofocus />
        <datalist id="move-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
        <p className="dlg-hint">Leave it empty for the top folder. A folder that does not exist yet is created.</p>
        {problem ? <p className="dlg-error" role="alert">{problem}</p> : <DialogError message={ask.error} />}
      </Form>
    </Dialog>
  );
}

export function DeleteDialog({ files, row, onClose, onDone }: { files: TeamFiles; row: FileRow; onClose: () => void; onDone: () => void }) {
  const ask = useAsk();
  const attachment = row.store === 'attachments';
  const go = async (): Promise<void> => {
    if (await ask.run(() => files.backend.remove(row))) onDone();
  };
  return (
    <Dialog
      title={`Delete ${baseName(row.path)}?`}
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
        {attachment
          ? 'The attachment is removed from its channel for everyone. This cannot be undone.'
          : 'A new commit removes it. Every earlier version stays in History.'}
      </p>
      <DialogError message={ask.error} />
    </Dialog>
  );
}

/** The one thing a person who does not lead the team can do with bots/, skills/, routines/ and TEAM.md. */
export function PullRequestDialog({ path, onClose }: { path: string; onClose: () => void }) {
  return (
    <Dialog
      title="Change by pull request"
      onClose={onClose}
      testId="dialog-pull-request"
      footer={<button type="button" className="btn primary" onClick={onClose}>Close</button>}
    >
      <p className="dlg-text">
        <span className="mono">{path}</span> is changed by a pull request to the team repo, not from this screen. It takes effect when the request is merged.
        Team leads and workspace admins can change it here.
      </p>
    </Dialog>
  );
}
