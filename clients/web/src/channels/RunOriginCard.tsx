import { useEffect, useId, useRef, useState } from 'react';
import type { RunOrigin } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { CaretIcon } from '../shell/icons';
import { fetchRunOrigin } from '../webhooks/providerApi';
import { PROVIDER_LABELS, clockOf, originSummary, safeHref } from '../webhooks/providerModel';

/**
 * The card under a bot's post that says what started the run when a work app did: "What started this run · Zendesk · <title>", closed until it is opened, and a link back (PLAN Bundle D,
 * P16-10, decision D21). It asks `GET /api/runs/:runId/origin` once for each run and draws nothing on a 404 (the run was not started by an app, or the reader cannot see its channel).
 * What the app sent (the title, the name, the link) is shown as plain text; the link opens only when it is a web address.
 */

const answers = new Map<string, Promise<RunOrigin | null>>();

/** Asks once for each run, however many posts of the same run are on the screen; a 404 is an answer ("nothing to show"), any other failure is asked again next time. */
function originOf(runId: string): Promise<RunOrigin | null> {
  const known = answers.get(runId);
  if (known) return known;
  const asked = fetchRunOrigin(runId).then(
    (r) => r.origin,
    (err: unknown) => {
      if (isApiError(err) && err.status === 404) return null;
      answers.delete(runId);
      return null;
    },
  );
  answers.set(runId, asked);
  return asked;
}
/** For tests: forget what was asked. */
export const forgetRunOrigins = (): void => answers.clear();

export function RunOriginCard({ runId }: { runId: string }) {
  const [origin, setOrigin] = useState<RunOrigin | null>(null);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const head = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    setOrigin(null);
    void originOf(runId).then((o) => {
      if (live) setOrigin(o);
    });
    return () => {
      live = false;
    };
  }, [runId]);
  if (origin === null) return null;

  const href = safeHref(origin.url);
  const app = PROVIDER_LABELS[origin.provider].replace(/ \(.*\)$/, '');
  return (
    <div
      className="wh-origin"
      data-testid="run-origin"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          // focus may be on the link inside the body, which goes away: keep it on the card
          head.current?.focus();
        }
      }}
    >
      <button ref={head} type="button" className="wh-origin-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)} data-testid="run-origin-toggle">
        <span className="wh-origin-line">{originSummary(origin)}</span>
        <span className="wh-origin-caret"><CaretIcon open={open} /></span>
      </button>
      {open ? (
        <div className="wh-origin-body" id={bodyId} data-testid="run-origin-body">
          <p className="wh-origin-row">
            <span className="wh-origin-key">App</span> {app} · {origin.endpointName}
          </p>
          <p className="wh-origin-row">
            <span className="wh-origin-key">Event</span> {origin.kind}
          </p>
          {origin.title ? (
            <p className="wh-origin-row">
              <span className="wh-origin-key">Title</span> {origin.title}
            </p>
          ) : null}
          {origin.actorLabel ? (
            <p className="wh-origin-row">
              <span className="wh-origin-key">By</span> {origin.actorLabel}
            </p>
          ) : null}
          {href ? (
            <p className="wh-origin-row">
              <a href={href} target="_blank" rel="noopener noreferrer" data-testid="run-origin-link">Open in {app}</a>
            </p>
          ) : null}
          <p className="wh-origin-fine">
            Verified by its signature · received {clockOf(origin.receivedAt)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
