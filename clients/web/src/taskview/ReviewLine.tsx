import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ThreadPullRequest } from '@manythreads/shared';
import { fetchThreadPullRequests } from '../screens/boards/api';

/**
 * P35-02: in a thread whose card has a pull request waiting for a person, one line above the composer: "Pull request #24 waits for review" and a
 * Review link that opens the card on its board, where the files, the checks and the decisions are. A database read only (the thread never asks GitHub);
 * read again when the thread's runs change, so the line comes when the Committer records the request and goes when it is merged or sent back.
 */
export function ReviewLine({ rootId, revision }: { rootId: string; revision: string }) {
  const [items, setItems] = useState<readonly ThreadPullRequest[]>([]);
  useEffect(() => {
    let live = true;
    fetchThreadPullRequests(rootId).then(
      (r) => live && setItems(r.items),
      () => live && setItems([]),
    );
    return () => {
      live = false;
    };
  }, [rootId, revision]);
  if (items.length === 0) return null;
  return (
    <div className="pr-line-list" data-testid="thread-review-line">
      {items.map((p) => (
        <p key={p.taskId} className="pr-line">
          <span>
            Pull request #{p.number} waits for review{p.testedSha ? <> · tested at <span className="mono">{p.testedSha.slice(0, 7)}</span></> : null}
          </span>
          <Link
            className="btn s"
            to={`/t/${encodeURIComponent(p.teamSlug)}/boards?${p.boardId ? `board=${p.boardId}&` : ''}card=${p.taskId}`}
            data-testid="thread-review-open"
            aria-label={`Review pull request #${p.number}: ${p.title}`}
          >
            Review
          </Link>
        </p>
      ))}
    </div>
  );
}
