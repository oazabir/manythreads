import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Approval, RunHead, ThreadFileItem, ThreadTodo, TodoItem } from '@manythreads/shared';
import { fileContentUrl } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { isApiError } from '../api/client';
import { Lightbox } from '../channels/MessageImages';
import { fileKind, fileSize } from '../channels/format';
import { isPreviewableImage } from '../channels/images';
import { nowLine, runEnded } from '../channels/run-card/words';
import { STATUS_WORD, todoTitle } from '../channels/todo-card/words';
import { CaretIcon, CheckIcon, CloseIcon, ItemBlockedIcon, ItemWaitingIcon } from '../shell/icons';
import { fetchThreadFiles } from './api';
import { attachmentKey, earlierLabel, listStage, OUTPUTS_CAP, planOutputs, timelineOf, typeLabel } from './railRules';

export { attachmentKey };

/*
 * The thread's side rail (P29-20, docs/plans/channel-task-view.md section 10e): beside the messages, a collapsible view of how the work stands. "Progress" draws the bot's to-do
 * list as a vertical timeline with its stage; "Outputs" lists the files generated or attached in the thread, the two newest pictures as previews. It reads what the thread already
 * holds (the to-do store, the run lease, the approvals list) and asks the server for one thing of its own: the files, in one read, again only when a message with files appears or goes.
 */

/** Files of the thread, newest first; read again when `key` changes (a new attachment). The list on screen stays while the new one loads. */
export function useThreadFiles(rootId: string, key: string, enabled: boolean, limit: number) {
  const q = useQuery(`thread-files:${rootId}:${limit}:${enabled ? key : 'off'}`, () => (enabled ? fetchThreadFiles(rootId, limit) : Promise.resolve(null)));
  return q;
}

function Mark({ status }: { status: TodoItem['status'] }) {
  return (
    <span className="trMark" data-status={status} aria-hidden="true">
      {status === 'done' ? <CheckIcon size={11} /> : status === 'working' ? <span className="tdPulse" /> : status === 'blocked' ? <ItemBlockedIcon size={13} /> : <ItemWaitingIcon size={13} />}
    </span>
  );
}

function Step({ item, current, owner, sub, waiting, onWaiting }: { item: TodoItem; current: boolean; owner: string | undefined; sub: string | null; waiting: boolean; onWaiting: () => void }) {
  return (
    <li className="trStep" data-status={item.status} data-current={current ? 'true' : 'false'} data-testid="rail-step" aria-current={current ? 'step' : undefined}>
      <Mark status={item.status} />
      <div className="trStepBody">
        <span className="trStepText" dir="auto">{item.text}</span>
        <span className="sr-only"> ({STATUS_WORD[item.status]})</span>
        {current && item.status === 'working' ? (
          <span className="trStage" data-testid="rail-stage">
            {STATUS_WORD.working}
            {owner !== undefined ? ` · ${owner}` : ''}
          </span>
        ) : null}
        {item.status === 'blocked' ? (
          <span className="trStage" data-testid="rail-blocked">
            {waiting ? (
              <button type="button" className="trLink" onClick={onWaiting} data-testid="rail-approval-link">Waiting for an approval</button>
            ) : (
              'Blocked'
            )}
          </span>
        ) : null}
        {sub !== null ? <span className="trSub" data-testid="rail-substep" dir="auto">{sub}</span> : null}
      </div>
    </li>
  );
}

/** The to-do list as a timeline, with its stage on top. */
function Progress({ todo, run, approvals, ownerName }: { todo: ThreadTodo | null; run: RunHead | null; approvals: readonly Approval[]; ownerName: (actorId: string) => string | undefined }) {
  const [openEarlier, setOpenEarlier] = useState(false);
  const items = useMemo(() => todo?.items ?? [], [todo]);
  const stage = useMemo(() => listStage(items), [items]);
  const timeline = useMemo(() => timelineOf(items), [items]);
  const pending = approvals.some((a) => a.status === 'pending');
  const goToApproval = useCallback(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="question-strip"], [data-testid="thread-dock"]');
    el?.scrollIntoView?.({ block: 'center' });
    el?.querySelector<HTMLElement>('button')?.focus?.();
  }, []);
  if (todo === null || items.length === 0) {
    return (
      <section className="trSection" aria-labelledby="rail-progress-h" data-testid="rail-progress">
        <h3 id="rail-progress-h" className="trH">Progress</h3>
        <p className="trEmpty" data-testid="rail-no-todo">No to-do list in this thread</p>
        {run !== null ? <p className="trSub" data-testid="rail-run-line">{`${run.botName} · ${nowLine(run.now, run.state).text}`}</p> : null}
      </section>
    );
  }
  const live = run !== null ? nowLine(run.now, run.state) : null;
  const sub = live !== null ? (live.code !== null ? `${live.text} ${live.code}` : live.text) : null;
  return (
    <section className="trSection" aria-labelledby="rail-progress-h" data-testid="rail-progress" data-stage={stage.stage}>
      <h3 id="rail-progress-h" className="trH">Progress</h3>
      <p className="trTitle" dir="auto">{todoTitle(todo)}</p>
      <div className="trStageLine" data-testid="rail-stage-line">
        <span className="trChip" data-stage={stage.stage}>{stage.label}</span>
        <span className="trCount" data-testid="rail-count">{stage.count}</span>
      </div>
      <div className="tdBar" role="img" aria-label={stage.count ?? ''}>
        <span style={{ width: `${stage.pct}%` }} />
      </div>
      <ol className="trSteps" data-testid="rail-steps">
        {timeline.earlier.length > 0 ? (
          <li className="trEarlier">
            <button type="button" className="trMore" aria-expanded={openEarlier} onClick={() => setOpenEarlier((v) => !v)} data-testid="rail-earlier">
              <span className="rcChev" aria-hidden="true"><CaretIcon open={openEarlier} /></span>
              <span>{earlierLabel(timeline.earlier.length)}</span>
            </button>
            {openEarlier ? (
              <ol className="trSteps trSteps-in" data-testid="rail-earlier-list">
                {timeline.earlier.map((i) => <Step key={i.id} item={i} current={false} owner={undefined} sub={null} waiting={false} onWaiting={goToApproval} />)}
              </ol>
            ) : null}
          </li>
        ) : null}
        {timeline.steps.map((i) => {
          const isCurrent = timeline.current?.id === i.id;
          return <Step key={i.id} item={i} current={isCurrent} owner={i.ownerId !== undefined ? ownerName(i.ownerId) : run?.botName} sub={isCurrent && i.status === 'working' ? sub : null} waiting={pending} onWaiting={goToApproval} />;
        })}
      </ol>
    </section>
  );
}

function Thumb({ item, onOpen }: { item: ThreadFileItem; onOpen: (f: ThreadFileItem) => void }) {
  return (
    <button type="button" className="trThumb" data-testid="rail-preview" aria-label={`Open ${item.file.name}`} onClick={() => onOpen(item)}>
      <img src={fileContentUrl(item.file.id)} alt={item.file.name} loading="lazy" decoding="async" />
      <span className="trThumbName">{item.file.name}</span>
    </button>
  );
}

function FileRow({ item, onOpen }: { item: ThreadFileItem; onOpen: (f: ThreadFileItem) => void }) {
  const kind = fileKind(item.file.name, item.file.mime);
  const body = (
    <>
      <span className={`ic ${kind.tone}`} aria-hidden="true">{kind.label}</span>
      <span className="trFileText">
        <span className="trFileName" dir="auto">{item.file.name}</span>
        <small>{`${typeLabel(item.file)} · ${fileSize(item.file.size)}`}</small>
      </span>
    </>
  );
  return (
    <li>
      {isPreviewableImage(item.file) ? (
        <button type="button" className="trFile" data-testid="rail-file" onClick={() => onOpen(item)}>{body}</button>
      ) : (
        <a className="trFile" data-testid="rail-file" href={fileContentUrl(item.file.id)} download={item.file.name}>{body}</a>
      )}
    </li>
  );
}

/** The files of the thread: the two newest pictures as previews, the rest as a compact list. */
function Outputs({ rootId, fileKey, open }: { rootId: string; fileKey: string; open: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const limit = showAll ? 200 : OUTPUTS_CAP + 2;
  const q = useThreadFiles(rootId, fileKey, open, limit);
  const [viewing, setViewing] = useState<ThreadFileItem | null>(null);
  const close = useCallback(() => setViewing(null), []);
  const data = q.status === 'ok' ? q.data : null;
  const plan = useMemo(() => planOutputs(data?.items ?? [], data?.total ?? 0, showAll), [data, showAll]);
  const shown = plan.previews.length + plan.list.length;
  return (
    <section className="trSection" aria-labelledby="rail-outputs-h" data-testid="rail-outputs">
      <h3 id="rail-outputs-h" className="trH">Outputs{data !== null && data.total > 0 ? <span className="trHCount">{data.total}</span> : null}</h3>
      {q.status === 'error' ? (
        <p className="trEmpty" role="status">{isApiError(q.error) && q.error.status === 403 ? 'You cannot see the files of this thread' : 'The files could not be loaded'}</p>
      ) : data !== null && data.total === 0 ? (
        <p className="trEmpty" data-testid="rail-no-files">No files in this thread yet</p>
      ) : data !== null ? (
        <>
          {plan.previews.length > 0 ? (
            <div className="trThumbs" data-testid="rail-previews" data-count={plan.previews.length}>
              {plan.previews.map((p) => <Thumb key={p.file.id} item={p} onOpen={setViewing} />)}
            </div>
          ) : null}
          {plan.list.length > 0 ? (
            <ul className="trFiles" data-testid="rail-files">
              {plan.list.map((f) => <FileRow key={f.file.id} item={f} onOpen={setViewing} />)}
            </ul>
          ) : null}
          {plan.more > 0 && !showAll ? (
            <button type="button" className="trMore trMore-block" onClick={() => setShowAll(true)} data-testid="rail-show-all">{`Show all files (${data.total})`}</button>
          ) : null}
          {showAll && shown > OUTPUTS_CAP ? (
            <button type="button" className="trMore trMore-block" onClick={() => setShowAll(false)}>Show fewer</button>
          ) : null}
        </>
      ) : (
        <p className="trEmpty" aria-busy="true">Loading files…</p>
      )}
      {viewing !== null ? <Lightbox file={viewing.file} onClose={close} /> : null}
    </section>
  );
}

/**
 * The rail itself: a complementary landmark with a name. Closed it draws nothing (the thread's header holds the toggle); the parent decides where it sits (beside the messages,
 * over them, or as a bottom sheet) from the width of the thread.
 */
export function ThreadRail({ rootId, id, open, onClose, todo, run, approvals, fileKey, ownerName }: {
  rootId: string;
  /** The element id the header's toggle points at with `aria-controls`. */
  id: string;
  open: boolean;
  onClose: () => void;
  todo: ThreadTodo | null;
  run: RunHead | null;
  approvals: readonly Approval[];
  fileKey: string;
  ownerName: (actorId: string) => string | undefined;
}) {
  const heading = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      // Esc closes the rail when focus is inside it (the sheet modes would otherwise trap a keyboard user)
      if (e.key === 'Escape' && !e.defaultPrevented && closeRef.current?.closest('aside')?.contains(document.activeElement)) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <aside id={id} className="trRail" aria-labelledby={heading} data-testid="thread-rail">
      <header className="trHead">
        <h2 id={heading} className="trTop">Thread overview</h2>
        <button ref={closeRef} type="button" className="trClose" aria-label="Close the overview" onClick={onClose} data-testid="rail-close">
          <CloseIcon size={14} />
        </button>
      </header>
      <div className="trScroll">
        <Progress todo={todo} run={run && !runEnded(run.state) ? run : null} approvals={approvals} ownerName={ownerName} />
        <Outputs rootId={rootId} fileKey={fileKey} open={open} />
      </div>
    </aside>
  );
}
