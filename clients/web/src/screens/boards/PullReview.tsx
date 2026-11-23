import { useEffect, useState } from 'react';
import { parseUnifiedDiff, type PullRequestChecksResponse, type PullRequestDiffResponse, type PullRequestFile, type Task } from '@manythreads/shared';
import { Alert } from '../../components/ui';
import { SkeletonRows } from '../../components/Skeleton';
import { refusalText } from './board';
import { approvePullRequest, fetchPullRequestChecks, fetchPullRequestDiff, mergePullRequest, requestPullRequestChanges } from './api';

/*
 * P35-02: review a bot's pull request on its card, without leaving for GitHub or GitLab. The server reads the request with the project's token and
 * answers only what is drawn here: the files with their hunks, the checks of the head, whether the request is still at the tested commit. The
 * decisions (approve, ask for changes, merge) are a lead's; the server says so when someone else tries, and that answer is shown as it is.
 * Patch text is the provider's: drawn as text, never as markup.
 */

type Props = { slug: string; task: Task; onChanged: () => void };

const STATUS_WORD: Record<PullRequestFile['status'], string> = {
  added: 'added',
  deleted: 'deleted',
  modified: 'changed',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
};
const CHECK_WORD = { passing: 'passed', failing: 'failed', pending: 'running', skipped: 'skipped' } as const;
const SUMMARY_WORD = { passing: 'All checks passed', failing: 'A check failed', pending: 'Checks are still running', none: 'No checks reported' } as const;

function FileDiff({ file }: { file: PullRequestFile }) {
  if (file.binary) return <p className="pr-note">A binary file: its content is not shown.</p>;
  if (file.patch === null) return <p className="pr-note">{file.truncated ? 'Too large to show here: open the pull request for this file.' : 'No lines changed.'}</p>;
  const hunks = parseUnifiedDiff(file.patch);
  if (hunks.length === 0) return <p className="pr-note">No lines changed.</p>;
  return (
    <div className="diff" role="group" aria-label={`Changes in ${file.path}`}>
      {hunks.map((h, i) => (
        <div key={i} className="hunk">
          <span className="hh">{h.header}</span>
          {h.lines.map((l, j) => (
            <span key={j} className={l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : 'ctx'} data-line={l.type}>
              {l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}
              {l.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PullReview({ slug, task, onChanged }: Props) {
  const pr = task.pullRequest;
  const open = pr?.state === 'open' && task.state === 'waiting_on_person';
  const [pages, setPages] = useState<PullRequestDiffResponse[]>([]);
  const [checks, setChecks] = useState<PullRequestChecksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [readProblem, setReadProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setReadProblem(null);
    Promise.all([fetchPullRequestDiff(slug, task.id, 1), fetchPullRequestChecks(slug, task.id)]).then(
      ([d, c]) => {
        if (!live) return;
        setPages([d]);
        setChecks(c);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setReadProblem(refusalText(err));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [slug, task.id, open, reload, task.testedSha]);

  // a decision that moved the card on (changes sent to the Coder, a merge) keeps its answer in sight after the Review itself goes
  if (!pr || !open)
    return said ? (
      <p className="pr-said" role="status" data-testid="pull-review-said">
        {said}
      </p>
    ) : null;
  const first = pages[0];
  const files = pages.flatMap((p) => p.files);
  const next = pages.at(-1)?.nextPage ?? null;
  const head = task.testedSha ?? '';
  const moved = first !== undefined && !first.atRecordedHead;
  const failing = checks?.summary === 'failing';
  const mergeBlock = moved ? 'The pull request moved after it was tested, so it cannot be merged from here.' : failing ? 'A check failed, so it cannot be merged from here.' : null;
  const added = files.reduce((n, f) => n + f.additions, 0);
  const removed = files.reduce((n, f) => n + f.deletions, 0);

  const decide = async (label: string, fn: () => Promise<string>): Promise<void> => {
    setBusy(label);
    setProblem(null);
    setSaid(null);
    try {
      setSaid(await fn());
      onChanged();
    } catch (err) {
      setProblem(refusalText(err));
    } finally {
      setBusy(null);
    }
  };

  const more = async (): Promise<void> => {
    if (next === null) return;
    setBusy('more');
    try {
      const page = await fetchPullRequestDiff(slug, task.id, next);
      setPages((p) => [...p, page]);
    } catch (err) {
      setProblem(refusalText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="pr-review" data-testid="pull-review" aria-labelledby="pr-review-title">
      <div className="pr-head">
        <h4 id="pr-review-title" className="pr-title">
          Review pull request #{pr.number}
        </h4>
        <button type="button" className="linkish" onClick={() => setReload((n) => n + 1)} disabled={loading} data-testid="pull-review-reload">
          Reload
        </button>
      </div>
      <dl className="pr-facts">
        <dt>Tested commit</dt>
        <dd className="mono">{head.slice(0, 12) || '—'}</dd>
        {task.testSiteUrl ? (
          <>
            <dt>Test site</dt>
            <dd>
              <a href={task.testSiteUrl} target="_blank" rel="noopener noreferrer" data-testid="pull-review-test-site">
                {task.testSiteUrl.replace(/^https:\/\//, '').replace(/\/$/, '')}
              </a>
            </dd>
          </>
        ) : null}
        {first ? (
          <>
            <dt>Change</dt>
            <dd data-testid="pull-review-size">
              {files.length}
              {next !== null ? '+' : ''} file{files.length === 1 ? '' : 's'} · <span className="pr-plus">+{added}</span> <span className="pr-minus">−{removed}</span>
            </dd>
          </>
        ) : null}
      </dl>

      {loading ? <SkeletonRows rows={3} label="Reading the pull request" /> : null}
      {readProblem ? <Alert>{readProblem}</Alert> : null}
      {moved && first ? (
        <p className="pr-warn" role="note" data-testid="pull-review-moved">
          The pull request is now at {first.headSha?.slice(0, 12) ?? 'another commit'}, not at the tested commit. What is shown is not what was tested.
        </p>
      ) : null}

      {checks ? (
        <div className="pr-checks" data-testid="pull-review-checks" data-summary={checks.summary}>
          <p className={`pr-summary ${checks.summary}`}>{SUMMARY_WORD[checks.summary]}</p>
          {checks.unreadable ? <p className="pr-note">{checks.unreadable}</p> : null}
          {checks.checks.length > 0 ? (
            <ul className="pr-check-list">
              {checks.checks.map((c, i) => (
                <li key={`${c.name}-${i}`} data-state={c.state}>
                  <span className={`pr-chip ${c.state}`}>{CHECK_WORD[c.state]}</span>{' '}
                  {c.link ? (
                    <a href={c.link} target="_blank" rel="noopener noreferrer">
                      {c.name}
                    </a>
                  ) : (
                    c.name
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {files.length > 0 ? (
        <ul className="pr-files" data-testid="pull-review-files">
          {files.map((f) => (
            <li key={`${f.previousPath ?? ''}>${f.path}`}>
              <details className="pr-file" data-status={f.status}>
                <summary>
                  <span className="pr-path mono">{f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}</span>
                  <span className="pr-badge">{f.binary ? 'binary' : STATUS_WORD[f.status]}</span>
                  {f.truncated ? <span className="pr-badge">too large to show</span> : null}
                  <span className="pr-count">
                    <span className="pr-plus">+{f.additions}</span> <span className="pr-minus">−{f.deletions}</span>
                  </span>
                </summary>
                <FileDiff file={f} />
              </details>
            </li>
          ))}
        </ul>
      ) : null}
      {next !== null ? (
        <button type="button" className="btn s" onClick={() => void more()} disabled={busy !== null} data-testid="pull-review-more">
          Show more files
        </button>
      ) : null}

      {problem ? <Alert>{problem}</Alert> : null}
      {said ? (
        <p className="pr-said" role="status" data-testid="pull-review-said">
          {said}
        </p>
      ) : null}

      {asking ? (
        <div className="pr-ask">
          <label className="bd-field">
            <span>What should change? The Coder gets this as its next instruction.</span>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={800} rows={4} data-testid="pull-review-comment" />
          </label>
          <div className="pr-actions">
            <button
              type="button"
              className="btn s primary"
              disabled={busy !== null || comment.trim() === ''}
              data-testid="pull-review-send-changes"
              onClick={() =>
                void decide('changes', async () => {
                  const r = await requestPullRequestChanges(slug, task.id, { headSha: head, comment: comment.trim() });
                  setAsking(false);
                  setComment('');
                  return `Sent to ${r.handedTo ?? 'the Coder'}: the same card goes round again and the pull request is updated.`;
                })
              }
            >
              Send to the Coder
            </button>
            <button type="button" className="btn s" disabled={busy !== null} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : confirmMerge ? (
        <div className="pr-actions" role="group" aria-label="Confirm the merge">
          <span className="pr-confirm">Merge #{pr.number} at {head.slice(0, 12)} into the main branch?</span>
          <button
            type="button"
            className="btn s primary"
            disabled={busy !== null}
            data-testid="pull-review-merge-now"
            onClick={() =>
              void decide('merge', async () => {
                const r = await mergePullRequest(slug, task.id, { headSha: head });
                setConfirmMerge(false);
                return `Merged${r.mergeSha ? ` (merge commit ${r.mergeSha.slice(0, 12)})` : ''}. The card is done.`;
              })
            }
          >
            Merge now
          </button>
          <button type="button" className="btn s" disabled={busy !== null} onClick={() => setConfirmMerge(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="pr-actions">
          <button
            type="button"
            className="btn s"
            disabled={busy !== null || loading || moved || head === ''}
            data-testid="pull-review-approve"
            onClick={() =>
              void decide('approve', async () => {
                const r = await approvePullRequest(slug, task.id, { headSha: head });
                return r.asComment ? 'Approved. The provider took it as a comment, because the bot account opened the pull request.' : 'Approved.';
              })
            }
          >
            Approve
          </button>
          <button type="button" className="btn s" disabled={busy !== null || loading || moved || head === ''} onClick={() => setAsking(true)} data-testid="pull-review-request-changes">
            Request changes
          </button>
          <button
            type="button"
            className="btn s primary"
            disabled={busy !== null || loading || mergeBlock !== null || head === ''}
            title={mergeBlock ?? undefined}
            onClick={() => setConfirmMerge(true)}
            data-testid="pull-review-merge"
          >
            Merge
          </button>
        </div>
      )}
      {mergeBlock && !loading ? <p className="pr-note">{mergeBlock}</p> : null}
    </section>
  );
}
