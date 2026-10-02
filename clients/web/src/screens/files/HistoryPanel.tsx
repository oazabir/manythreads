import { Suspense, lazy, useEffect, useState } from 'react';
import { ago } from '../../channels/format';
import { Avatar } from '../../components/ui';
import { Dialog } from '../../components/Dialog';
import { ForbiddenBody } from '../../components/states';
import { isApiError } from '../../api/client';
import { usePanelSub } from '../../kernel/panel/sub';
import { FilesError } from './backend';
import { PullRequestDialog } from './dialogs';
import { READ_ONLY_COPY, baseName, isPage, type Commit, type FileDiff } from './model';
import { bumpFiles, useFilesVersion, useTeamFiles, type TeamFiles } from './store';
import { useFileRow } from './useFileRow';

const RenderedDiff = lazy(() => import('./RenderedDiff').then((m) => ({ default: m.RenderedDiff })));

const TIME = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** "Tue 14:02": the day and time a version was made, as the restore question names it. */
export function dayTime(iso: string): string {
  const part = (type: Intl.DateTimeFormatPartTypes): string => TIME.formatToParts(new Date(iso)).find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('hour')}:${part('minute')}`;
}

type Load<T> = { status: 'loading' } | { status: 'ok'; value: T } | { status: 'error'; message: string; status403?: boolean };

function useLoad<T>(key: string, run: () => Promise<T>, deps: readonly unknown[]): Load<T> {
  const [state, setState] = useState<{ key: string; value: Load<T> }>({ key: '', value: { status: 'loading' } });
  useEffect(() => {
    let live = true;
    run().then(
      (value) => live && setState({ key, value: { status: 'ok', value } }),
      (err: unknown) => live && setState({ key, value: { status: 'error', message: err instanceof Error ? err.message : 'Could not load.', ...(isApiError(err) && err.status === 403 ? { status403: true } : {}) } }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
  return state.key === key ? state.value : { status: 'loading' };
}

function DiffBlock({ diff, context }: { diff: FileDiff; context: boolean }) {
  if (diff.binary) return <p className="vw-note">This version is not text, so there is nothing to compare.</p>;
  if (diff.hunks.length === 0) return <p className="vw-note">No lines changed.</p>;
  return (
    <div className="diff" data-testid="text-diff" role="group" aria-label="Changes">
      {diff.hunks.map((h, i) => (
        <div key={i} className="hunk">
          {context ? <span className="hh">{h.header}</span> : null}
          {h.lines
            .filter((l) => context || l.type !== 'context')
            .map((l, j) => (
              <span key={j} className={l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : 'ctx'} data-line={l.type}>
                {l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}
                {l.text}
              </span>
            ))}
        </div>
      ))}
      {diff.truncated ? <p className="vw-note">The change is longer than what is shown here.</p> : null}
    </div>
  );
}

function CommitDetail({ files, path, commit, markdown }: { files: TeamFiles; path: string; commit: Commit; markdown: boolean }) {
  const [mode, setMode] = useState<'text' | 'rendered'>('text');
  const [context, setContext] = useState(false);
  const diff = useLoad(`${path}@${commit.sha}`, () => files.backend.diff(path, commit), [files]);
  const versions = useLoad(
    mode === 'rendered' ? `${path}@${commit.sha}:text` : '',
    async () => (mode === 'rendered' ? { before: await files.backend.version(path, commit.parentSha), after: await files.backend.version(path, commit.sha) } : { before: null, after: null }),
    [files, mode],
  );
  return (
    <div className="cdetail" data-testid="commit-detail">
      {mode === 'rendered' ? (
        versions.status === 'ok' ? (
          <Suspense fallback={<p className="loading" aria-busy="true">Loading…</p>}>
            <RenderedDiff before={versions.value.before} after={versions.value.after} />
          </Suspense>
        ) : versions.status === 'error' ? (
          <p className="vw-error" role="alert">{versions.message}</p>
        ) : (
          <p className="loading" aria-busy="true">Loading…</p>
        )
      ) : diff.status === 'ok' ? (
        <DiffBlock diff={diff.value} context={context} />
      ) : diff.status === 'error' ? (
        <p className="vw-error" role="alert">{diff.message}</p>
      ) : (
        <p className="loading" aria-busy="true">Loading…</p>
      )}
      <div className="cdetail-tools">
        {markdown ? (
          <div className="seg" role="group" aria-label="Show changes as">
            <button type="button" className={mode === 'text' ? 'on' : ''} aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Text</button>
            <button type="button" className={mode === 'rendered' ? 'on' : ''} aria-pressed={mode === 'rendered'} onClick={() => setMode('rendered')}>Rendered</button>
          </div>
        ) : null}
        {mode === 'text' ? (
          <button type="button" className="flinkish" aria-pressed={context} onClick={() => setContext((c) => !c)}>{context ? 'Hide context' : 'Show context'}</button>
        ) : null}
      </div>
    </div>
  );
}

function RestoreDialog({ files, path, commit, onClose, onDone }: { files: TeamFiles; path: string; commit: Commit; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = baseName(path);
  const when = dayTime(commit.committedAt);
  const go = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await files.backend.restore(path, commit, `Restore ${name} to ${when}`);
      bumpFiles();
      onDone();
    } catch (err) {
      setError(err instanceof FilesError || err instanceof Error ? err.message : 'That did not work.');
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Restore ${name}?`}
      onClose={onClose}
      testId="dialog-restore"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void go()} data-autofocus>Restore</button>
        </>
      }
    >
      <p className="dlg-text" data-testid="restore-question">
        Restore <code>{name}</code> to {when}? A new commit will be made.
      </p>
      {error ? <p className="dlg-error" role="alert">{error}</p> : null}
    </Dialog>
  );
}

/** The right-panel entry `history:<path>`: the commits that touched a file, what each changed, and Restore. */
export function HistoryPanel({ entry }: { entry: { type: string; id: string } }) {
  const files = useTeamFiles();
  const path = entry.id;
  const version = useFilesVersion();
  const rowState = useFileRow(files, path);
  usePanelSub(path);
  const list = useLoad(files ? `${files.slug}:${path}:${version}` : '', async () => (files ? files.backend.history(path) : []), [files, version]);
  const [picked, setPicked] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<Commit | null>(null);
  const [pr, setPr] = useState(false);
  const [done, setDone] = useState(false);

  if (!files || list.status === 'loading') return <div className="vw-loading" role="status" aria-busy="true">Loading…</div>;
  if (list.status === 'error') return list.status403 ? <div className="panel-empty"><ForbiddenBody /></div> : <p className="vw-error" role="alert">{list.message}</p>;
  const commits = list.value;
  if (commits.length === 0) {
    return (
      <div className="hist" data-testid="history">
        <p className="panel-empty-title">No history yet</p>
        <p className="panel-empty-body">This file has no commits.</p>
      </div>
    );
  }
  const selected = commits.find((c) => c.sha === picked) ?? commits[0] as Commit;
  const newest = selected.sha === commits[0]?.sha;
  const readOnly = rowState.status === 'ok' && rowState.row.readOnlyReason === 'change_by_pull_request';
  const missing = rowState.status === 'missing';
  const canRestore = !newest && selected.change !== 'deleted';

  return (
    <div className="hist" data-testid="history" data-path={path}>
      <div className="hist-list" role="list" aria-label="Commits">
        {commits.map((c) => {
          const on = c.sha === selected.sha;
          const author = c.author;
          return (
            <div key={c.sha} role="listitem" className={`commit ${on ? 'on' : ''}`} data-testid="commit-row" data-sha={c.sha} data-selected={on}>
              <button type="button" className="commit-head" aria-expanded={on} onClick={() => { setPicked(c.sha); setDone(false); }}>
                <span className="who2">
                  <Avatar name={author?.name ?? 'manythreads'} kind={author?.kind === 'bot' ? 'agent' : 'person'} />
                  <b>{author?.name ?? 'manythreads'}</b>
                  <span className="t2" data-vt-mask>{ago(c.committedAt)}</span>
                </span>
                <span className="msg2">{c.subject}</span>
                {c.coAuthors.length > 0 ? <span className="co">with {c.coAuthors.map((a) => a.name).join(', ')}</span> : null}
              </button>
              {on ? <CommitDetail files={files} path={path} commit={c} markdown={isPage(path) || /\.(md|markdown)$/i.test(path)} /> : null}
            </div>
          );
        })}
      </div>
      <div className="hist-foot">
        {done ? <p className="vw-saved" role="status">Restored. A new commit was made.</p> : null}
        {readOnly ? (
          <button type="button" className="btn s" data-testid="change-by-pr" onClick={() => setPr(true)}>{READ_ONLY_COPY}</button>
        ) : (
          <button type="button" className="btn primary s" data-testid="restore-version" disabled={!canRestore || missing} title={newest ? 'This is the current version.' : undefined} onClick={() => setRestoring(selected)}>
            Restore this version
          </button>
        )}
      </div>
      {restoring ? <RestoreDialog files={files} path={path} commit={restoring} onClose={() => setRestoring(null)} onDone={() => { setRestoring(null); setPicked(null); setDone(true); }} /> : null}
      {pr ? <PullRequestDialog path={path} onClose={() => setPr(false)} /> : null}
    </div>
  );
}
