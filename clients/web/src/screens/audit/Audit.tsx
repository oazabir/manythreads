import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditCategory, AuditEntry, AuditOutcome } from '@manythreads/shared';
import { exportAudit, fetchAudit, fetchAuditSigningKey, fetchTeams, fetchWorkspaceMembers, type AuditExportFile } from '../../api/endpoints';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { Alert, Notice, Time } from '../../components/ui';
import { ForbiddenBody } from '../../components/states';
import { CATEGORY_LABELS, NO_FILTERS, OUTCOME_LABELS, actionWords, actionsIn, exportFileName, outcomeWord, targetWords, toExportRequest, toQuery, verifyCommands, type AuditFilters } from './format';

const PAGE = 50;

/** Hands a text to the browser as a file to save. */
function saveText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Settings, Audit. Who did what, when, to what, and what was held back, for workspace owners and admins. The rows are made from the event log and
 * hold names, ids and short fixed phrases, never a message, a file's contents, a secret or a memory's text. The Export button saves a signed copy of
 * the rows that match the filters (docs/plugins/audit.md).
 */
export function Audit() {
  const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [error, setError] = useState<Error | null>(null);
  const [more, setMore] = useState(false);
  const run = useRef(0);

  const people = useQuery('audit-people', fetchWorkspaceMembers);
  const teams = useQuery('audit-teams', () => fetchTeams(true));

  const load = useCallback((f: AuditFilters) => {
    const mine = ++run.current;
    setState('loading');
    fetchAudit({ ...toQuery(f), limit: PAGE }).then(
      (res) => {
        if (run.current !== mine) return;
        setRows(res.entries);
        setNext(res.nextCursor);
        setState('ok');
      },
      (e: unknown) => {
        if (run.current !== mine) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setState('error');
      },
    );
  }, []);

  useEffect(() => {
    load(filters);
  }, [filters, load]);

  const loadMore = (): void => {
    if (!next || more) return;
    const mine = run.current;
    setMore(true);
    fetchAudit({ ...toQuery(filters), limit: PAGE, cursor: next }).then(
      (res) => {
        if (run.current !== mine) return;
        setRows((r) => [...r, ...res.entries]);
        setNext(res.nextCursor);
        setMore(false);
      },
      (e: unknown) => {
        setMore(false);
        setError(e instanceof Error ? e : new Error(String(e)));
        setState('error');
      },
    );
  };

  const set = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]): void =>
    setFilters((f) => {
      const n = { ...f, [key]: value };
      // an action belongs to one group: changing the group clears an action that is no longer in it
      if (key === 'category' && n.action && !actionsIn(n.category).some((a) => a.value === n.action)) n.action = '';
      return n;
    });
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  if (state === 'error' && isForbidden(error)) {
    return (
      <div className="audit-page" data-landmark="audit">
        <div className="inline-state"><ForbiddenBody /></div>
      </div>
    );
  }

  return (
    <div className="audit-page" data-landmark="audit">
      <h1 className="pane-title" data-landmark="title">Audit</h1>
      <p className="lede" data-landmark="lede">
        Who did what, when, and to what, across the workspace, including what the platform held back on purpose. Only workspace admins can see this page.
        Rows hold names and short reasons, never message text, file contents, secrets or memory text.
      </p>

      <section className="box audit-filters" aria-label="Filters" data-landmark="audit-filters">
        <div className="audit-filter-grid">
          <label className="audit-f">
            <span>Who</span>
            <select value={filters.actor} onChange={(e) => set('actor', e.target.value)}>
              <option value="">Anyone</option>
              {people.status === 'ok' ? people.data.members.map((m) => <option key={m.personId} value={m.personId}>{m.displayName}</option>) : null}
            </select>
          </label>
          <label className="audit-f">
            <span>Group</span>
            <select value={filters.category} onChange={(e) => set('category', e.target.value as '' | AuditCategory)}>
              <option value="">Everything</option>
              {(Object.keys(CATEGORY_LABELS) as AuditCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          </label>
          <label className="audit-f">
            <span>Did what</span>
            <select value={filters.action} onChange={(e) => set('action', e.target.value)}>
              <option value="">Anything</option>
              {actionsIn(filters.category).map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
          <label className="audit-f">
            <span>Team</span>
            <select value={filters.team} onChange={(e) => set('team', e.target.value)}>
              <option value="">Any team</option>
              {teams.status === 'ok' ? teams.data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>) : null}
            </select>
          </label>
          <label className="audit-f">
            <span>Outcome</span>
            <select value={filters.outcome} onChange={(e) => set('outcome', e.target.value as '' | AuditOutcome)}>
              <option value="">Any outcome</option>
              {(Object.keys(OUTCOME_LABELS) as AuditOutcome[]).map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
            </select>
          </label>
          <label className="audit-f">
            <span>From</span>
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set('from', e.target.value)} />
          </label>
          <label className="audit-f">
            <span>To</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set('to', e.target.value)} />
          </label>
        </div>
        <div className="audit-filter-actions">
          <button type="button" className="btn quiet" disabled={!filtered} onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>
          <span className="push" />
          <ExportButton filters={filters} />
        </div>
      </section>

      <section className="box audit-results" aria-label="Audit log" aria-busy={state === 'loading'} data-landmark="audit-results">
        {state === 'loading' && rows.length === 0 ? <p className="loading" aria-busy="true">Loading…</p> : null}
        {state === 'error' ? (
          <div className="inline-state">
            <Alert>{error?.message ?? 'The audit log could not be loaded.'}</Alert>
            <button type="button" className="btn" onClick={() => load(filters)}>Try again</button>
          </div>
        ) : null}
        {state === 'ok' && rows.length === 0 ? (
          <div className="audit-empty" data-testid="audit-empty">
            <p className="audit-empty-h">{filtered ? 'Nothing matches these filters' : 'Nothing has been recorded yet'}</p>
            <p className="fld-hint">
              {filtered ? 'Widen the dates or clear a filter to see more.' : 'Sign-ins, approvals, changes to people and teams, and anything the platform held back will show up here as they happen.'}
            </p>
          </div>
        ) : null}
        {rows.length > 0 ? (
          <table className="audit-table" data-testid="audit-table">
            <caption className="audit-sr">Audit log, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Did what</th>
                <th scope="col">To what</th>
                <th scope="col">Team</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => <Row key={e.id} e={e} />)}
            </tbody>
          </table>
        ) : null}
        {state === 'ok' && next ? (
          <div className="audit-more">
            <button type="button" className="btn" onClick={loadMore} disabled={more}>{more ? 'Loading…' : 'Show older'}</button>
          </div>
        ) : null}
        {state === 'ok' && rows.length > 0 && !next ? <p className="fld-hint audit-end">That is everything that matches.</p> : null}
      </section>
    </div>
  );
}

const isForbidden = (e: Error | null): boolean => isApiError(e) && e.status === 403;

function Row({ e }: { e: AuditEntry }) {
  return (
    <tr className="audit-row" data-action={e.action} data-outcome={e.outcome}>
      <td data-label="When"><Time iso={e.occurredAt} /></td>
      <td data-label="Who" data-vt-mask>
        <div className="audit-cell">
          <span className="audit-who">{e.actor.name}</span>
          {e.actor.kind !== 'person' ? <span className="audit-kind">{e.actor.kind === 'bot' ? 'bot' : 'system'}</span> : null}
        </div>
      </td>
      <td data-label="Did what">
        <div className="audit-cell">
          <span className="audit-what">{actionWords(e)}</span>
          {e.reason ? <span className="audit-reason" data-vt-mask>{e.reason}</span> : null}
        </div>
      </td>
      <td data-label="To what" data-vt-mask>{targetWords(e)}</td>
      <td data-label="Team" data-vt-mask>{e.team?.name ?? '—'}</td>
      <td data-label="Outcome">
        <div className="audit-cell">
          <span className={`audit-out ${e.outcome}`} title={e.outcome === 'withheld' ? 'The platform held something back on purpose' : undefined}>{outcomeWord(e.outcome)}</span>
        </div>
      </td>
    </tr>
  );
}

/** Saves a signed export of the rows that match the filters, then offers the signature and the public key that check it. */
function ExportButton({ filters }: { filters: AuditFilters }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ file: AuditExportFile; name: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (): void => {
    setBusy(true);
    setError(null);
    setDone(null);
    exportAudit(toExportRequest(filters)).then(
      (file) => {
        const name = exportFileName(new Date());
        saveText(name, file.text, 'application/x-ndjson');
        const manifest = JSON.parse(file.text.slice(0, file.text.indexOf('\n'))) as { truncated?: boolean };
        setDone({ file, name, truncated: manifest.truncated === true });
        setBusy(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : 'The export failed.');
        setBusy(false);
      },
    );
  };

  const saveKey = (): void => {
    fetchAuditSigningKey().then(
      (key) => saveText('audit-key.pem', key.publicKeyPem, 'application/x-pem-file'),
      (e: unknown) => setError(e instanceof Error ? e.message : 'The key could not be loaded.'),
    );
  };

  return (
    <div className="audit-export">
      <button type="button" className="btn primary" onClick={run} disabled={busy} data-testid="audit-export">{busy ? 'Exporting…' : 'Export'}</button>
      {error ? <Alert>{error}</Alert> : null}
      {done ? (
        <div className="audit-export-done" data-testid="audit-export-done">
          <Notice>
            Saved {done.name}. {done.truncated ? 'The file stopped at the row limit; narrow the dates and export again for the rest. ' : ''}
            The file is signed so nobody can change it without it showing.
          </Notice>
          <div className="audit-export-actions">
            <button type="button" className="btn" onClick={() => saveText(`${done.name}.sig`, `${done.file.signature}\n`, 'text/plain')}>Save signature</button>
            <button type="button" className="btn" onClick={saveKey}>Save public key</button>
          </div>
          <details className="audit-verify">
            <summary>How to check the file</summary>
            <p className="fld-hint">Put the three files in one folder and run these two commands. The second prints “Signature Verified Successfully” when the file is untouched.</p>
            <pre className="audit-code" tabIndex={0}>{verifyCommands(done.name).join('\n')}</pre>
          </details>
        </div>
      ) : null}
    </div>
  );
}
