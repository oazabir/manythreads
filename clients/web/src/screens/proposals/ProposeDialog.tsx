import { lineDiff, PROPOSAL_MAX_CHARS, type ProposalDetail } from '@manythreads/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { createProposal, readCurrent } from './api';
import { ProposalChecks, ProposalDiff } from './parts';

/*
 * "Propose a change" (PLAN P7-01): the one way to change bots/, TEAM.md, skills/ and routines/ from the web app. It edits the whole file, shows the lines
 * that would change, and sends them as a proposal. A team lead or workspace admin sees the same lines and applies them; one of them may also
 * propose and apply in one step, which still leaves a proposal on record. The Bots editor and the Files screen both open this dialog.
 */

export type ProposeMode = 'edit' | 'new' | 'delete';

const defaultTitle = (mode: ProposeMode, path: string): string => (mode === 'delete' ? `Remove ${path}` : mode === 'new' ? `Add ${path}` : `Change ${path}`);

export function ProposeDialog({
  slug,
  path,
  mode,
  canApply,
  onClose,
  onDone,
  initialText,
  initialTitle,
}: {
  slug: string;
  path: string;
  mode: ProposeMode;
  canApply: boolean;
  onClose: () => void;
  onDone?: (result: ProposalDetail) => void;
  /** Start the text with this (a version restored from History) instead of the file as it is. */
  initialText?: string;
  initialTitle?: string;
}) {
  const [target, setTarget] = useState(path);
  const [base, setBase] = useState<{ content: string; blobSha: string } | null | 'loading'>(mode === 'new' ? null : 'loading');
  const [text, setText] = useState('');
  const [title, setTitle] = useState(initialTitle ?? defaultTitle(mode, path));
  const [titleEdited, setTitleEdited] = useState(initialTitle !== undefined);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<ProposalDetail | null>(null);

  useEffect(() => {
    if (mode === 'new') return;
    let live = true;
    readCurrent(slug, path).then(
      (b) => {
        if (!live) return;
        setBase(b);
        setText(initialText ?? b?.content ?? '');
      },
      (err: unknown) => {
        if (!live) return;
        setBase(null);
        setError(err instanceof Error ? err.message : 'The file could not be read.');
      },
    );
    return () => {
      live = false;
    };
  }, [slug, path, mode, initialText]);

  const before = base === 'loading' || base === null ? null : base.content;
  const preview = useMemo(() => (mode === 'delete' ? lineDiff(before, null) : lineDiff(before, text)), [mode, before, text]);
  const changed = mode === 'delete' ? before !== null : text !== (before ?? '');
  const tooLong = text.length > PROPOSAL_MAX_CHARS;
  const ready = base !== 'loading' && !busy && changed && !tooLong && (mode !== 'new' || target.trim() !== '');

  const send = async (applyNow: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const finalPath = mode === 'new' ? target.trim() : path;
      const res = await createProposal(slug, {
        path: finalPath,
        op: mode === 'delete' ? 'delete' : 'put',
        ...(mode === 'delete' ? {} : { content: text }),
        baseBlobSha: base === 'loading' || base === null ? null : base.blobSha,
        title: (titleEdited ? title : defaultTitle(mode, finalPath)).trim() || defaultTitle(mode, finalPath),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(applyNow ? { applyNow: true } : {}),
      });
      setSent(res.proposal);
      onDone?.(res.proposal);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    const applied = sent.proposal.status === 'applied';
    return (
      <Dialog
        title={applied ? 'Change applied' : 'Proposal sent'}
        onClose={onClose}
        testId="dialog-propose-done"
        footer={
          <>
            <Link className="btn" to={`/t/${slug}/proposals/${sent.proposal.id}`} data-testid="propose-open" onClick={onClose}>Open the proposal</Link>
            <button type="button" className="btn primary" onClick={onClose}>Done</button>
          </>
        }
      >
        <p className="dlg-text" data-testid="propose-done-text">
          {applied
            ? 'The change is saved to the team repo. It is on record as a proposal that you applied yourself.'
            : 'A team lead or workspace admin can now see exactly which lines change and apply them. Nothing changes until then.'}
        </p>
        <ProposalChecks checks={sent.proposal.checks} />
      </Dialog>
    );
  }

  const heading = mode === 'delete' ? 'Propose removing this file' : mode === 'new' ? 'Propose a new file' : 'Propose a change';
  return (
    <Dialog
      title={heading}
      onClose={onClose}
      testId="dialog-propose"
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className={`btn ${canApply ? '' : 'primary'}`} data-testid="propose-save" disabled={!ready} onClick={() => void send(false)}>Save as proposal</button>
          {canApply ? (
            <button type="button" className="btn primary" data-testid="propose-apply" disabled={!ready} onClick={() => void send(true)}>Propose and apply</button>
          ) : null}
        </>
      }
    >
      <div className="dlg-form">
      <p className="dlg-text">
        Changes to <span className="mono">bots/</span>, <span className="mono">TEAM.md</span>, <span className="mono">skills/</span> and <span className="mono">routines/</span> go
        through a proposal: a team lead or workspace admin looks at the lines that change, then applies them.
        {canApply ? ' You can also propose and apply in one step; it is still kept on record.' : ''}
      </p>
      {mode === 'new' ? (
        <label className="dlg-label pp-field">
          File path
          <input className="dlg-input mono" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="propose-path" spellCheck={false} />
        </label>
      ) : (
        <p className="dlg-text"><span className="mono" data-testid="propose-target">{path}</span></p>
      )}
      <label className="dlg-label pp-field">
        What this change is
        <input
          className="dlg-input"
          value={title}
          maxLength={200}
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleEdited(true);
          }}
          data-testid="propose-title"
        />
      </label>
      {mode !== 'delete' ? (
        <label className="dlg-label pp-field">
          {base === 'loading' ? 'Loading the file…' : 'The whole file'}
          <textarea
            className="dlg-input mono pp-text"
            rows={12}
            value={text}
            disabled={base === 'loading'}
            onChange={(e) => setText(e.target.value)}
            data-testid="propose-text"
            spellCheck={false}
          />
        </label>
      ) : null}
      <label className="dlg-label pp-field">
        A note for whoever applies it (optional)
        <input className="dlg-input" value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} data-testid="propose-note" />
      </label>
      {tooLong ? <p className="dlg-error" role="alert">This file is longer than a proposal can carry ({PROPOSAL_MAX_CHARS.toLocaleString('en-GB')} characters).</p> : null}
      {changed && base !== 'loading' ? (
        <div className="pp-preview" data-testid="propose-preview">
          <p className="pp-count">{preview.additions} {preview.additions === 1 ? 'line' : 'lines'} added, {preview.deletions} removed</p>
          <ProposalDiff diff={preview.hunks.map((h) => [h.header, ...h.lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`)].join('\n')).join('\n')} />
        </div>
      ) : base !== 'loading' ? (
        <p className="vw-note" data-testid="propose-unchanged">Nothing is different yet.</p>
      ) : null}
      {error ? <p className="dlg-error" role="alert" data-testid="propose-error">{error}</p> : null}
      </div>
    </Dialog>
  );
}
