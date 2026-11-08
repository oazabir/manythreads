import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { KNOWLEDGE_MAX_PERSONAL_BASES, type KnowledgeHit, type PersonalKnowledgeBase } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { Dialog } from '../../components/Dialog';
import { Time } from '../../components/ui';
import { message } from '../memory/inboxWords';
import { ConnectorSourceForm, ConnectorSourceLine } from './ConnectorSourceForm';
import { firstReadPending, useFirstReadRefresh } from './useFirstRead';
import { createPersonalBase, deletePersonalBase, deletePersonalDocument, deletePersonalSource, fetchPersonalBase, fetchPersonalBases, searchPersonalBase, uploadPersonalDocument } from './api';
import { ACCEPTED_FILES, KIND_LABEL, countLine, searchModeSentence, sizeLabel, fallbackSlug, slugFromName, stateSentence, uploadSentence } from './words';

type Notice = { tone: 'ok' | 'bad'; text: string } | null;

/**
 * Your own knowledge bases: a base is a set of documents you upload (Markdown, text, CSV and PDF files) that you or Brain can search. Only you can open them;
 * a bot reads one only in a private conversation with you, and only if you have said it may (Account, Bots). Nothing here goes to a team.
 */
export function PersonalKnowledge() {
  const list = useQuery('personal-knowledge', fetchPersonalBases);
  const [params, setParams] = useSearchParams();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  if (list.status === 'loading') return <div className="view-empty" aria-busy="true" />;
  if (list.status === 'error') return <p className="mi-error" role="alert" data-testid="personal-knowledge-error">Your knowledge bases could not be loaded: {list.error.message}</p>;
  const bases = list.data.bases;
  const wanted = params.get('base');
  const selected = bases.find((b) => b.slug === wanted) ?? bases[0] ?? null;
  const full = bases.length >= KNOWLEDGE_MAX_PERSONAL_BASES;
  const named = name.trim() !== '';

  const create = async (): Promise<void> => {
    if (!named || busy || full) return;
    // a name with no Latin letters or digits (Arabic, Chinese) has no readable address, so the base is given a neutral one; its name stays as typed
    const slug = slugFromName(name) ?? fallbackSlug();
    setBusy(true);
    setNotice(null);
    try {
      const { base } = await createPersonalBase({ slug, name: name.trim() });
      setName('');
      setNotice({ tone: 'ok', text: `${base.name} was created. Upload a document to fill it.` });
      list.reload();
      setParams({ base: base.slug });
    } catch (e) {
      setNotice({ tone: 'bad', text: message(e, 'The knowledge base could not be created.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kn-personal" data-testid="personal-knowledge">
      <form
        className="kn-new"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="kn-field">
          <label className="mi-label" htmlFor="kn-new-name">New knowledge base</label>
          <input id="kn-new-name" className="mi-input" type="text" value={name} maxLength={120} placeholder="Reading list" onChange={(e) => setName(e.target.value)} autoComplete="off" disabled={full} data-testid="personal-knowledge-name" />
        </div>
        <button type="submit" className="btn s primary" disabled={!named || busy || full} data-testid="personal-knowledge-create">{busy ? 'Creating…' : 'Create'}</button>
        <span className="faint kn-note" data-testid="personal-knowledge-count">{countLine(bases.length, 'base', 'bases')} of {String(KNOWLEDGE_MAX_PERSONAL_BASES)}{full ? '. Delete one to make another.' : ''}</span>
      </form>
      {notice ? <p className={`kn-note ${notice.tone}`} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="personal-knowledge-notice">{notice.text}</p> : null}

      {bases.length === 0 ? (
        <p className="mi-empty faint" data-testid="personal-knowledge-empty">You have no knowledge bases yet. Name one above, then upload the files you want to be able to search.</p>
      ) : (
        <div className="kn-body">
          <ul className="kn-bases" aria-label="Your knowledge bases" data-testid="personal-knowledge-list">
            {bases.map((b) => (
              <li key={b.slug} className="kn-base-item">
                <button type="button" className={`kn-base-row ${selected?.slug === b.slug ? 'on' : ''}`} aria-current={selected?.slug === b.slug ? 'true' : undefined} onClick={() => setParams({ base: b.slug })} data-testid="personal-knowledge-row" data-base={b.slug}>
                  <span className="kn-base-name">{b.name}</span>
                  <span className="kn-base-meta">{countLine(b.documentCount, 'document', 'documents')}</span>
                </button>
              </li>
            ))}
          </ul>
          {selected ? (
            <BasePanel
              key={selected.slug}
              summary={selected}
              onChanged={list.reload}
              onRemoved={(line) => {
                setNotice({ tone: 'ok', text: line });
                setParams({});
                list.reload();
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function BasePanel({ summary, onChanged, onRemoved }: { summary: PersonalKnowledgeBase; onChanged: () => void; onRemoved: (line: string) => void }) {
  const base = summary.slug;
  const q = useQuery(`personal-knowledge:${base}`, () => fetchPersonalBase(base));
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [question, setQuestion] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  useFirstReadRefresh(q.status === 'ok' && firstReadPending(q.data.sources), q.reload);

  if (q.status === 'loading') return <div className="kn-detail" aria-busy="true"><p className="faint">Loading what is in this base…</p></div>;
  if (q.status === 'error') {
    return (
      <div className="kn-detail">
        <p className="kn-note bad" role="alert" data-testid="personal-base-error">The base could not be loaded: {q.error.message}</p>
        <button type="button" className="btn s" onClick={q.reload}>Try again</button>
      </div>
    );
  }
  const { base: info, documents } = q.data;
  const connectorSources = q.data.sources.filter((src) => src.kind === 'connector');

  const upload = (file: File): void => {
    setBusy('upload');
    setProgress(0);
    setNotice(null);
    uploadPersonalDocument(base, file, setProgress).then(
      (res) => {
        setBusy(null);
        setNotice({ tone: res.outcome === 'failed' ? 'bad' : 'ok', text: uploadSentence(res.outcome, res.document) });
        q.reload();
        onChanged();
      },
      (e: unknown) => {
        setBusy(null);
        setNotice({ tone: 'bad', text: message(e, 'The file could not be uploaded.') });
      },
    );
  };

  const removeDoc = (id: string, name: string): void => {
    setBusy('remove');
    setNotice(null);
    deletePersonalDocument(base, id).then(
      () => {
        setBusy(null);
        setNotice({ tone: 'ok', text: `${name} was removed.` });
        q.reload();
        onChanged();
      },
      (e: unknown) => {
        setBusy(null);
        setNotice({ tone: 'bad', text: message(e, 'The document could not be removed.') });
      },
    );
  };

  const removeSource = (id: string, name: string): void => {
    setBusy('remove-source');
    setNotice(null);
    deletePersonalSource(base, id).then(
      (res) => {
        setBusy(null);
        setNotice({ tone: 'ok', text: `${name} was removed with its ${countLine(res.documents, 'document', 'documents')}.` });
        q.reload();
        onChanged();
      },
      (e: unknown) => {
        setBusy(null);
        setNotice({ tone: 'bad', text: message(e, 'The source could not be removed.') });
      },
    );
  };

  const removeBase = (): void => {
    setBusy('delete');
    deletePersonalBase(base).then(
      (res) => onRemoved(`${info.name} was deleted with its ${countLine(res.documents, 'document', 'documents')}.`),
      (e: unknown) => {
        setBusy(null);
        setConfirming(false);
        setNotice({ tone: 'bad', text: message(e, 'The knowledge base could not be deleted.') });
      },
    );
  };

  const ask = (): void => {
    if (question.trim().length < 2) return;
    setBusy('ask');
    searchPersonalBase(base, question.trim()).then(
      (res) => {
        setBusy(null);
        setHits(res.hits);
      },
      (e: unknown) => {
        setBusy(null);
        setNotice({ tone: 'bad', text: message(e, 'The search did not work. Try again.') });
      },
    );
  };

  return (
    <div className="kn-detail" data-testid="personal-base" data-base={base} aria-busy={busy !== null || undefined}>
      <div className="kn-detail-head">
        <h2 className="kn-title" data-testid="personal-base-title">{info.name}</h2>
        <div className="kn-actions">
          <input ref={picker} type="file" hidden accept={ACCEPTED_FILES} aria-label={`Choose a file for ${info.name}`} data-testid="personal-base-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
          <button type="button" className="btn s primary" disabled={busy !== null} onClick={() => picker.current?.click()} data-testid="personal-base-upload">
            {busy === 'upload' ? `Uploading… ${String(Math.round(progress * 100))}%` : 'Upload a file'}
          </button>
          <button type="button" className="btn s danger" disabled={busy !== null} onClick={() => setConfirming(true)} data-testid="personal-base-delete">Delete base</button>
        </div>
      </div>
      <p className="kn-state" data-state={info.state} data-testid="personal-base-state">
        {stateSentence(info.state)}
        <span className="faint">
          {' '}· {countLine(info.documentCount, 'document', 'documents')} · {countLine(info.chunkCount, 'passage', 'passages')}
          {info.lastIndexedAt ? <> · last read <Time iso={info.lastIndexedAt} /></> : null}
        </span>
      </p>
      <p className="faint kn-note" data-testid="personal-base-mode" data-mode={q.data.searchMode}>
        {searchModeSentence(q.data.searchMode)} Only you can open this base. Web pages cannot be added to a personal base yet.
      </p>
      {notice ? <p className={`kn-note ${notice.tone}`} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="personal-base-notice">{notice.text}</p> : null}

      <div className="kn-sources" data-testid="personal-base-sources">
        {connectorSources.length > 0 ? (
          <ul className="kn-source-list" aria-label={`Connected apps read into ${info.name}`}>
            {connectorSources.map((src) => (
              <li key={src.id} className="kn-source-item">
                <ConnectorSourceLine source={src} />
                <button type="button" className="btn s" disabled={busy !== null} onClick={() => removeSource(src.id, src.label ?? 'The source')} aria-label={`Remove ${src.label ?? 'this source'}`} data-testid="personal-base-source-remove">Remove</button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="kn-actions">
          <ConnectorSourceForm
            team={null}
            base={base}
            disabled={busy !== null}
            onAdded={(line) => {
              setNotice({ tone: 'ok', text: line });
              q.reload();
              onChanged();
            }}
          />
        </div>
      </div>

      {documents.length === 0 ? (
        <p className="mi-empty faint" data-testid="personal-base-empty">No documents yet. Upload a Markdown, text, CSV or PDF file.</p>
      ) : (
        <ul className="kn-docs" aria-label={`Documents in ${info.name}`} data-testid="personal-base-docs">
          {documents.map((d) => (
            <li key={d.id} className="kn-doc" data-testid="personal-base-doc" data-status={d.status} data-name={d.name}>
              <div className="kn-doc-main">
                <div className="kn-doc-name">{d.name}</div>
                <div className="kn-doc-meta">
                  {KIND_LABEL[d.kind]} · {sizeLabel(d.size)} · version {d.version} · {d.status === 'indexed' ? 'Searchable' : 'Could not be read'}
                </div>
                {d.reason ? <div className={`kn-doc-meta${d.status === 'failed' ? ' bad' : ''}`}>{d.reason}</div> : null}
              </div>
              <button type="button" className="btn s" disabled={busy !== null} onClick={() => removeDoc(d.id, d.name)} aria-label={`Remove ${d.name}`} data-testid="personal-base-doc-remove">Remove</button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="kn-ask"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
        role="search"
        aria-label={`Search ${info.name}`}
      >
        <label className="mi-label" htmlFor="kn-ask-q">Try a question</label>
        <input id="kn-ask-q" className="mi-input" type="search" placeholder="Try a question, for example how long do refunds take?" value={question} onChange={(e) => setQuestion(e.target.value)} data-testid="personal-base-question" />
        <button type="submit" className="btn s" disabled={busy !== null || question.trim().length < 2} data-testid="personal-base-search">{busy === 'ask' ? 'Searching…' : 'Search'}</button>
      </form>
      {hits !== null ? (
        hits.length === 0 ? (
          <p className="faint kn-note" data-testid="personal-base-nohits">Nothing in this base answers that.</p>
        ) : (
          <ul className="kn-hits" aria-label="Search results" data-testid="personal-base-hits">
            {hits.map((h) => (
              <li key={h.chunkId} className="kn-hit" data-testid="personal-base-hit">
                <div className="kn-hit-name">{h.documentName} <span className="faint">version {h.version}{h.section ? ` · ${h.section}` : ''}{h.sourceChanged ? ' · the document has changed since' : ''}</span></div>
                <p className="kn-hit-text" data-vt-mask>{h.text}</p>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {confirming ? (
        <Dialog
          title="Delete this knowledge base?"
          onClose={() => setConfirming(false)}
          testId="personal-base-delete-dialog"
          footer={
            <>
              <button type="button" className="btn" disabled={busy !== null} onClick={() => setConfirming(false)}>Keep it</button>
              <button type="button" className="btn danger" disabled={busy !== null} onClick={removeBase} data-testid="personal-base-delete-confirm">{busy === 'delete' ? 'Deleting…' : 'Delete it'}</button>
            </>
          }
        >
          <p className="mi-help">“{info.name}” is deleted with its {countLine(info.documentCount, 'document', 'documents')} and the original files. Bots will no longer find anything in it.</p>
        </Dialog>
      ) : null}
    </div>
  );
}
