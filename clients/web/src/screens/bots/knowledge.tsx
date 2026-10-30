import { useRef, useState } from 'react';
import { Link } from 'react-router';
import type { KnowledgeDocument, KnowledgeHit } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { Time } from '../../components/ui';
import { askKnowledgeBase, createKnowledgeBase, deleteKnowledgeDocument, fetchKnowledgeBase, resyncKnowledgeBase, uploadKnowledgeDocument } from './api';
import { Mono } from './parts';

/*
 * What a knowledge base holds, shown under the base's line in the bot page's Knowledge tab (PLAN P8-33): its documents (name, kind, size, a short
 * code of the file's content, version, and whether it can be searched or why not), Upload, Re-read, and a box to try a question. A passage is a short
 * piece of a document that can be found on its own. A team lead or workspace admin writes; everyone else on the team reads.
 */

const KIND_LABEL: Record<KnowledgeDocument['kind'], string> = { markdown: 'Markdown', text: 'Text', csv: 'CSV', pdf: 'PDF' };

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const problemOf = (err: unknown): string => (isApiError(err) ? err.message : err instanceof Error ? err.message : 'Something went wrong. Try again.');

type Notice = { tone: 'ok' | 'bad'; text: string } | null;

export function KnowledgeBasePanel({ team, base, canEdit }: { team: string; base: string; canEdit: boolean }) {
  const q = useQuery(`knowledge:${team}:${base}`, () => fetchKnowledgeBase(team, base));
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [question, setQuestion] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  if (q.status === 'loading') return <p className="b-notset" data-testid="knowledge-loading">Loading what is in this base…</p>;
  if (q.status === 'error') {
    if (isApiError(q.error) && q.error.status === 404) {
      return (
        <div className="b-kb" data-testid="knowledge-missing">
          <p className="b-notset">This knowledge base does not exist yet, so the bot finds nothing in it.</p>
          {canEdit ? (
            <button
              type="button"
              className="btn s"
              disabled={busy !== null}
              onClick={() => {
                setBusy('create');
                createKnowledgeBase(team, { slug: base }).then(() => { setBusy(null); q.reload(); }, (e: unknown) => { setBusy(null); setNotice({ tone: 'bad', text: problemOf(e) }); });
              }}
            >
              Create it
            </button>
          ) : null}
          {notice ? <p className="b-kb-note bad" role="alert">{notice.text}</p> : null}
        </div>
      );
    }
    return (
      <div className="b-kb">
        <p className="b-kb-note bad" role="alert">The base could not be loaded: {problemOf(q.error)}</p>
        <button type="button" className="btn s" onClick={q.reload}>Try again</button>
      </div>
    );
  }

  const { base: info, documents } = q.data;
  const writer = q.data.canWrite;
  const state = info.state === 'ready' ? 'Ready: every document can be searched' : info.state === 'attention' ? 'Needs attention: some documents could not be read' : 'Empty: add a document to start';

  const upload = (file: File): void => {
    setBusy('upload');
    setProgress(0);
    setNotice(null);
    uploadKnowledgeDocument(team, base, file, setProgress).then(
      (res) => {
        setBusy(null);
        const d = res.document;
        const text =
          res.outcome === 'added' ? `${d.name} was added (${String(d.chunkCount)} passages).`
          : res.outcome === 'updated' ? `${d.name} changed and is now at version ${String(d.version)}.`
          : res.outcome === 'unchanged' ? `${d.name} has the same content as before, so nothing changed.`
          : `${d.name} could not be read. ${d.reason ?? ''}`;
        setNotice({ tone: res.outcome === 'failed' ? 'bad' : 'ok', text });
        q.reload();
      },
      (e: unknown) => { setBusy(null); setNotice({ tone: 'bad', text: problemOf(e) }); },
    );
  };

  return (
    <div className="b-kb" data-testid="knowledge-base" data-base={base}>
      <p className="b-kb-state" data-state={info.state} data-testid="knowledge-state">
        {state}
        <span className="b-kb-sub">
          {' '}· {info.documentCount} {info.documentCount === 1 ? 'document' : 'documents'} · {info.chunkCount} passages
          {info.lastIndexedAt ? <> · last read <Time iso={info.lastIndexedAt} /></> : null}
        </span>
      </p>
      <p className="b-kb-sub">Searched by the words in a question. Meaning-based search needs an embedding model, which this workspace has not been given. Converted copies are in <Mono>{info.repoFolder}</Mono>.</p>

      {documents.length === 0 ? <p className="b-notset" data-testid="knowledge-empty">No documents yet. Upload a Markdown, text, CSV or PDF file.</p> : null}
      <ul className="b-kb-docs">
        {documents.map((d) => (
          <li key={d.id} className="b-kb-doc" data-testid="knowledge-doc" data-status={d.status}>
            <div className="b-kb-name">{d.name}</div>
            <div className="b-kb-meta">
              {KIND_LABEL[d.kind]} · {formatSize(d.size)} · <Mono>{d.shortHash}</Mono> · version {d.version} ·{' '}
              <span className={`b-kb-status ${d.status}`}>{d.status === 'indexed' ? 'Searchable' : 'Could not be read'}</span>
            </div>
            {d.repoPath ? <div className="b-kb-sub"><Link to={`/t/${team}/files?open=${encodeURIComponent(d.repoPath)}`} data-testid="knowledge-open-file">Open the converted text in Files</Link></div> : null}
            {d.reason ? <div className={`b-kb-reason${d.status === 'failed' ? ' bad' : ''}`}>{d.reason}</div> : null}
            {writer ? (
              <button type="button" className="btn s" aria-label={`Remove ${d.name}`} disabled={busy !== null} onClick={() => {
                setBusy('remove');
                deleteKnowledgeDocument(team, base, d.id).then(() => { setBusy(null); setNotice({ tone: 'ok', text: `${d.name} was removed.` }); q.reload(); }, (e: unknown) => { setBusy(null); setNotice({ tone: 'bad', text: problemOf(e) }); });
              }}>Remove</button>
            ) : null}
          </li>
        ))}
      </ul>

      {writer ? (
        <div className="b-kb-actions">
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".md,.markdown,.txt,.csv,.pdf,text/markdown,text/plain,text/csv,application/pdf"
            data-testid="knowledge-file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }}
          />
          <button type="button" className="btn s" disabled={busy !== null} data-testid="knowledge-upload" onClick={() => fileInput.current?.click()}>
            {busy === 'upload' ? `Uploading… ${String(Math.round(progress * 100))}%` : 'Upload a file'}
          </button>
          <button type="button" className="btn s" disabled={busy !== null} data-testid="knowledge-resync" onClick={() => {
            setBusy('resync');
            setNotice(null);
            resyncKnowledgeBase(team, base).then(
              (res) => {
                setBusy(null);
                const r = res.result;
                setNotice({ tone: r.failed > 0 ? 'bad' : 'ok', text: `Read again: ${String(r.checked)} checked, ${String(r.updated)} changed, ${String(r.added)} new, ${String(r.removed)} removed, ${String(r.failed)} could not be read.` });
                q.reload();
              },
              (e: unknown) => { setBusy(null); setNotice({ tone: 'bad', text: problemOf(e) }); },
            );
          }}>{busy === 'resync' ? 'Reading again…' : 'Read again'}</button>
        </div>
      ) : (
        <p className="b-kb-sub">Only a team lead or a workspace admin can add or remove documents.</p>
      )}
      {notice ? <p className={`b-kb-note ${notice.tone}`} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="knowledge-notice">{notice.text}</p> : null}

      <form className="b-add-row" onSubmit={(e) => {
        e.preventDefault();
        if (question.trim().length < 2) return;
        setBusy('ask');
        askKnowledgeBase(team, base, question.trim()).then((res) => { setBusy(null); setHits(res.hits); }, (err: unknown) => { setBusy(null); setNotice({ tone: 'bad', text: problemOf(err) }); });
      }}>
        <input aria-label="Try a question" placeholder="Try a question, e.g. how long do refunds take?" value={question} onChange={(e) => setQuestion(e.target.value)} data-testid="knowledge-question" />
        <button type="submit" className="btn s" disabled={busy !== null || question.trim().length < 2}>Search</button>
      </form>
      {hits !== null ? (
        hits.length === 0 ? <p className="b-notset" data-testid="knowledge-nohits">Nothing in this base answers that. A bot told to answer only from the base would say so.</p> : (
          <ul className="b-kb-hits" data-testid="knowledge-hits">
            {hits.map((h) => (
              <li key={h.chunkId} className="b-kb-hit">
                <div className="b-kb-name">{h.documentName} <span className="b-kb-sub">version {h.version}{h.section ? ` · ${h.section}` : ''}</span></div>
                <div className="b-kb-text">{h.text}</div>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
