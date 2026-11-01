import { useEffect, useRef, useState } from 'react';
import { IMPORT_SOURCES, type ImportReport, type ImportRun, type ImportSource } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { cancelImport, deleteImport, dryRunImport, fetchImports, fetchTeams, startImport, uploadImportArchive } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { Alert, Notice } from '../../components/ui';
import { SOURCE_ACCEPT, SOURCE_HELP, SOURCE_NAMES, STATUS_WORDS, actionsFor, channelOutcomeWords, formatSize, isActive, progressFraction, progressWords, skippedLine, tooBigWarning } from './format';

const failure = (e: unknown): string => (isApiError(e) ? e.message : 'Something went wrong. Try again.');

/**
 * Settings, Import. A workspace admin brings the history of another chat product in: pick Slack or Mattermost and a team, upload the export, read the
 * dry run (it writes nothing), then start the import and read the report at the end. The page keeps asking the server while a run is being worked on.
 */
export function ImportScreen() {
  const runs = useQuery('imports', fetchImports);
  const teams = useQuery('import-teams', () => fetchTeams());
  const active = runs.status === 'ok' && runs.data.items.some((r) => isActive(r.status));
  const reloadRef = useRef(runs.reload);
  reloadRef.current = runs.reload;
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => reloadRef.current(), 2000);
    return () => clearInterval(timer);
  }, [active]);

  return (
    <div className="imp-page" data-landmark="import">
      <h1 className="pane-title" data-landmark="title">Import</h1>
      <p className="lede" data-landmark="lede">
        Bring the history of Slack or Mattermost here: channels, messages, threads and reactions, each with the time it was written. People are matched by
        email address. Someone who has no account here yet keeps their messages under their name with "(imported)", and takes them over the day they
        sign in with the same email address. Nothing is written until you have read a dry run and pressed Start.
      </p>

      <Uploader teams={teams.status === 'ok' ? teams.data.teams.map((t) => ({ slug: t.slug, name: t.name })) : []} onUploaded={runs.reload} />

      <QueryView q={runs}>
        {({ items }) =>
          items.length === 0 ? (
            <p className="fld-hint" data-testid="import-empty">No import yet.</p>
          ) : (
            items.map((run) => <RunCard key={run.id} run={run} onChange={runs.reload} />)
          )
        }
      </QueryView>
    </div>
  );
}

function Uploader({ teams, onUploaded }: { teams: { slug: string; name: string }[]; onUploaded: () => void }) {
  const [source, setSource] = useState<ImportSource>('slack');
  const [team, setTeam] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fraction, setFraction] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const chosen = team || teams[0]?.slug || '';
  const warning = file ? tooBigWarning(file.size) : null;

  const submit = (): void => {
    if (!file || !chosen) return;
    setError(null);
    setFraction(0);
    const controller = new AbortController();
    abort.current = controller;
    uploadImportArchive({ source, team: chosen, file }, setFraction, controller.signal).then(
      () => {
        setFraction(null);
        setFile(null);
        onUploaded();
      },
      (e: unknown) => {
        setFraction(null);
        setError(failure(e));
      },
    );
  };

  return (
    <section className="box" aria-labelledby="imp-upload" data-landmark="import-upload">
      <h2 className="box-h" id="imp-upload">Upload an export</h2>
      <form
        className="imp-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="fld">
          <label htmlFor="imp-source">Where from</label>
          <select id="imp-source" data-testid="import-source" value={source} disabled={fraction !== null} onChange={(e) => { setSource(e.target.value as ImportSource); setFile(null); }}>
            {IMPORT_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_NAMES[s]}</option>)}
          </select>
          <div className="fld-hint">{SOURCE_HELP[source]}</div>
        </div>
        <div className="fld">
          <label htmlFor="imp-team">Into which team</label>
          <select id="imp-team" data-testid="import-team" value={chosen} disabled={fraction !== null} onChange={(e) => setTeam(e.target.value)}>
            {teams.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
          </select>
          <div className="fld-hint">The channels are made in this team. A private channel gets only the people the export lists for it who are also on this team.</div>
        </div>
        <div className="fld">
          <label htmlFor="imp-file">Export file</label>
          <input id="imp-file" data-testid="import-file" type="file" accept={SOURCE_ACCEPT[source]} disabled={fraction !== null} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {file ? <div className="fld-hint" data-vt-mask>{file.name}, {formatSize(file.size)}</div> : null}
          {warning ? <div className="fld-hint">{warning}</div> : null}
        </div>
        {error ? <Alert>{error}</Alert> : null}
        {fraction !== null ? (
          <div className="imp-bar" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
            <span style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
        ) : null}
        <div className="imp-actions">
          <button type="submit" className="btn primary" data-testid="import-upload" disabled={!file || !chosen || fraction !== null}>
            {fraction !== null ? `Uploading ${Math.round(fraction * 100)} %` : 'Upload'}
          </button>
          {fraction !== null ? <button type="button" className="btn" onClick={() => abort.current?.abort()}>Stop uploading</button> : null}
        </div>
      </form>
    </section>
  );
}

function RunCard({ run, onChange }: { run: ImportRun; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const can = actionsFor(run.status);
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setConfirming(false);
      onChange();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  const report = run.result ?? run.dryRun;
  const fraction = progressFraction(run);

  return (
    <section className="box imp-run" aria-labelledby={`imp-${run.id}`} data-testid={`import-run-${run.id}`} data-status={run.status} data-landmark="import-run">
      <h2 className="box-h" id={`imp-${run.id}`}>
        {SOURCE_NAMES[run.source]} export <span className="imp-status" data-status={run.status}>{STATUS_WORDS[run.status]}</span>
      </h2>
      <div className="imp-meta d" data-vt-mask>
        {run.fileName}, {formatSize(run.size)}, into {run.teamSlug || 'a team'}, uploaded {new Date(run.createdAt).toLocaleString()}
      </div>
      {isActive(run.status) ? (
        <div className="imp-working">
          <div className="imp-bar" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}>
            <span style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }} />
          </div>
          <p className="fld-hint" data-testid="import-progress">{progressWords(run)}{run.cancelRequested ? ' Stopping after the current batch.' : ''}</p>
        </div>
      ) : null}
      {run.error ? <Alert>{run.error}</Alert> : null}
      {run.status === 'done' ? <Notice>The import is finished. Read the report below.</Notice> : null}
      {run.status === 'cancelled' ? <Notice tone="warn">The import was cancelled. What it had written stays; the report says how much.</Notice> : null}
      {report ? <Report report={report} heading={run.result ? 'What happened' : 'What an import would do'} /> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="imp-actions">
        {can.start && !confirming ? (
          <button type="button" className="btn primary" data-testid="import-start" disabled={busy} onClick={() => setConfirming(true)}>Start the import</button>
        ) : null}
        {can.start && confirming ? (
          <>
            <span className="imp-confirm">This writes channels and messages into the workspace. Start now?</span>
            <button type="button" className="btn primary" data-testid="import-start-confirm" disabled={busy} onClick={() => void act(() => startImport(run.id))}>Yes, start</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>Not yet</button>
          </>
        ) : null}
        {can.dryRun ? (
          <button type="button" className={`btn${run.status === 'uploaded' ? ' primary' : ''}`} data-testid="import-dry-run" disabled={busy} onClick={() => void act(() => dryRunImport(run.id))}>
            {run.status === 'uploaded' ? 'Read it (dry run)' : 'Do the dry run again'}
          </button>
        ) : null}
        {can.cancel ? <button type="button" className="btn" data-testid="import-cancel" disabled={busy || run.cancelRequested} onClick={() => void act(() => cancelImport(run.id))}>Cancel</button> : null}
        {can.remove ? <button type="button" className="btn" data-testid="import-delete" disabled={busy} onClick={() => void act(() => deleteImport(run.id))}>Remove from this list</button> : null}
      </div>
    </section>
  );
}

function Report({ report, heading }: { report: ImportReport; heading: string }) {
  return (
    <div className="imp-report" data-testid="import-report" data-vt-mask>
      <h3 className="imp-h">{heading}</h3>
      <ul className="imp-lines">
        {report.lines.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
      {report.skipped.length > 0 ? (
        <>
          <h3 className="imp-h">Left out or changed</h3>
          <ul className="imp-lines">
            {report.skipped.map((s) => <li key={s.reason}>{skippedLine(s.reason, s.count)}</li>)}
          </ul>
        </>
      ) : null}
      {report.channelLines.length > 0 ? (
        <>
          <h3 className="imp-h">Channels</h3>
          <div className="imp-table" role="table" aria-label="Channels of the archive">
            {report.channelLines.map((c, i) => (
              <div className="imp-row" role="row" key={i}>
                <span role="cell" className="imp-name">{c.kind === 'direct' ? 'Direct conversation' : `#${c.name}`}</span>
                <span role="cell" className="imp-kind">{c.kind}</span>
                <span role="cell" className="imp-count">{c.messages.toLocaleString('en-US')} messages</span>
                <span role="cell" className="imp-out">
                  {channelOutcomeWords(c)}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
