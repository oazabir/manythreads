import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AnswerChip, AnswerPayloadView, AnswerSharePreview, AnswerShareTargetsResponse } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { Dialog } from '../components/Dialog';
import { handoffAnswer, fetchShareTargets, previewAnswerShare, saveAnswerAsPage, shareAnswer } from '../screens/conversations/api';
import { channelPath } from '../shell/nav';
import { Answer, maskedLine, type TeamSlugOf } from './Answer';
import { channelStore } from './store';

/*
 * What a person does with an answer in their own conversation (SPEC §6.3, §6.4, §12.4; PLAN P5-17): share it to a channel with masking, save it
 * as a page, hand it to another bot, ask a follow-up. The preview dialog follows the wireframe "Share preview with masking": each citation as
 * `[n] label · kept` or `[n] from Omar's Drive · not shared / snippet removed [Remove claim on n]`, then Cancel and Share.
 *
 * Nothing here decides what is shown to anyone. The server makes the copy from the stored answer (a request carries only the numbers of the
 * claims to remove), the preview is that copy exactly, and Share sends back its digest: what is posted is what was on this screen.
 */

/** Where the answer lives and who may act on it: set only for an answer in the reader's OWN conversation that was for them. */
export type AnswerTools = {
  /** The conversation channel the answer is in. */
  channelId: string;
  /** The thread (the conversation's first message): a follow-up goes into it. */
  threadRootId: string | null;
  /** The slug of the team of the page: links go there. */
  team: string;
};

type Mode = 'channel' | 'page';

type TargetList = AnswerShareTargetsResponse['channels'];

const STATUS_TEXT: Record<'kept' | 'masked' | 'removed', string> = { kept: 'kept', masked: 'not shared', removed: 'removed' };

/** What the dialog draws. Pure: the container below owns the requests, so this is the part a component test renders. */
export type ShareDialogViewProps = {
  mode: Mode;
  /** The channels the person may post in; null while they load. Channel mode only. */
  targets: TargetList | null;
  targetId: string;
  onTarget: (id: string) => void;
  preview: AnswerSharePreview | null;
  /** The preview is being (re)read. */
  loading: boolean;
  error: string | null;
  removed: ReadonlySet<number>;
  onToggle: (n: number) => void;
  /** Whose answer it is: "from Omar's Drive". */
  who: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ShareDialogView(p: ShareDialogViewProps): ReactNode {
  const pickerId = useId();
  const items = p.preview?.items ?? [];
  const wider = p.preview?.audience === 'wider';
  const counts = p.preview?.counts;
  const chosen = p.targets?.find((t) => t.id === p.targetId);
  const ready = p.preview !== null && !p.loading && p.error === null && (p.mode === 'page' || p.targetId !== '');
  return (
    <div className="an-dlg" data-testid="answer-share-dialog" data-mode={p.mode}>
      {p.mode === 'channel' ? (
        <div className="an-dlg-pick dlg-form">
          <label className="dlg-label" htmlFor={pickerId}>Share to</label>
          {p.targets === null ? (
            <p className="dlg-hint" aria-busy="true">Loading channels…</p>
          ) : p.targets.length === 0 ? (
            <p className="dlg-hint" data-testid="answer-share-no-targets">There is no channel you can post in.</p>
          ) : (
            <select id={pickerId} className="dlg-input" data-testid="answer-share-target" data-autofocus value={p.targetId} onChange={(e) => p.onTarget(e.target.value)}>
              <option value="">Choose a channel…</option>
              {p.targets.map((t) => (
                <option key={t.id} value={t.id}>{`# ${t.name}${t.private ? ' · private' : ''}${t.teamName ? ` · ${t.teamName}` : ''}`}</option>
              ))}
            </select>
          )}
        </div>
      ) : (
        <p className="dlg-text" data-testid="answer-save-where">
          {p.preview?.target.path ? <>Saved as <code>{p.preview.target.path}</code> in the team’s pages: everybody on the team can open it.</> : 'Saved in the team’s pages: everybody on the team can open it.'}
        </p>
      )}

      {p.error !== null ? (
        <p className="dlg-error" role="alert" data-testid="answer-share-error">{p.error}</p>
      ) : null}

      {p.loading && p.preview === null ? <p className="dlg-hint" aria-busy="true">Reading what the readers may open…</p> : null}

      {items.length > 0 ? (
        <ol className="an-share-items" data-testid="answer-share-items" aria-label="Sources of this answer">
          {items.map((it) => {
            const isRemoved = p.removed.has(it.n);
            return (
              <li key={it.n} className={`an-share-item an-share-${it.status}`} data-testid="answer-share-item" data-n={it.n} data-status={it.status}>
                <span className="an-n" aria-hidden="true">{it.n}</span>
                <span className="an-share-label">
                  {it.status === 'masked' ? maskedLine(p.who, it.kind) : it.label}
                  {it.status === 'masked' ? <span className="an-share-sub" data-vt-mask>{`was: ${it.label}`}</span> : null}
                </span>
                <span className="an-share-status">{STATUS_TEXT[it.status]}</span>
                <button
                  type="button"
                  className="btn s an-share-toggle"
                  data-testid="answer-share-remove"
                  aria-pressed={isRemoved}
                  aria-label={isRemoved ? `Keep the claim on ${it.n}` : `Remove claim on ${it.n}`}
                  disabled={p.busy}
                  onClick={() => p.onToggle(it.n)}
                >
                  {isRemoved ? 'Keep claim' : `Remove claim on ${it.n}`}
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}

      {counts ? (
        <p className="an-share-sum" data-testid="answer-share-counts" data-vt-mask>
          {`${counts.kept} kept · ${counts.masked} not shared · ${counts.removed} removed`}
        </p>
      ) : null}
      {wider ? (
        <p className="dlg-hint" data-testid="answer-share-wider">
          {p.mode === 'channel' && chosen ? `People outside the team may read # ${chosen.name}, ` : 'People outside the team may read this, '}
          so only what lives in the channel itself stays as a source; the rest is shown as “not shared”.
        </p>
      ) : null}
      <p className="dlg-hint">The text is the answer’s own; removing a claim only takes words out. Your conversation stays private.</p>

      <div className="dlg-foot">
        <button type="button" className="btn" data-testid="answer-share-cancel" onClick={p.onCancel}>Cancel</button>
        <button type="button" className="btn primary" data-testid="answer-share-confirm" disabled={!ready || p.busy} onClick={p.onConfirm}>
          {p.busy ? 'Working…' : p.mode === 'page' ? 'Save as page' : 'Share'}
        </button>
      </div>
    </div>
  );
}

const messageOf = (err: unknown, fallback: string): string => (isApiError(err) ? err.message : err instanceof Error ? err.message : fallback);

/** What a finished share or save tells the person, with the link to what was made. */
type Done = { kind: 'channel'; text: string; to: string } | { kind: 'page'; text: string; to: string; search: string };

/** The dialog with its requests: the target list, the preview (re-read on every change of target or removed claim), the confirm. */
function ShareDialog({ mode, tools, messageId, who, onClose, onDone }: { mode: Mode; tools: AnswerTools; messageId: string; who: string | null; onClose: () => void; onDone: (d: Done) => void }) {
  const address = useMemo(() => ({ channelId: tools.channelId, messageId }), [tools.channelId, messageId]);
  const [targets, setTargets] = useState<TargetList | null>(mode === 'channel' ? null : []);
  const [targetId, setTargetId] = useState('');
  const [removed, setRemoved] = useState<ReadonlySet<number>>(new Set());
  const [preview, setPreview] = useState<AnswerSharePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (mode !== 'channel') return;
    let live = true;
    fetchShareTargets(address).then(
      (r) => live && setTargets(r.channels),
      (e: unknown) => {
        if (!live) return;
        setTargets([]);
        setError(messageOf(e, 'The channels could not be loaded.'));
      },
    );
    return () => {
      live = false;
    };
  }, [mode, address]);

  const remove = useMemo(() => [...removed].sort((a, b) => a - b), [removed]);
  const read = useCallback(async (): Promise<void> => {
    if (mode === 'channel' && targetId === '') {
      setPreview(null);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const next = await previewAnswerShare(address, mode === 'page' ? { kind: 'page' } : { kind: 'channel', channelId: targetId }, remove);
      if (mine === seq.current) setPreview(next);
    } catch (e) {
      if (mine !== seq.current) return;
      setPreview(null);
      setError(messageOf(e, 'The preview could not be made.'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [address, mode, targetId, remove]);
  useEffect(() => {
    void read();
  }, [read]);

  const toggle = (n: number): void =>
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const confirm = async (): Promise<void> => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'channel') {
        const res = await shareAnswer(address, targetId, remove, preview.digest);
        const name = targets?.find((t) => t.id === targetId)?.name ?? preview.target.name ?? 'channel';
        onDone({ kind: 'channel', text: res.replayed ? `Already shared to # ${name}.` : `Shared to # ${name}.`, to: `${channelPath(tools.team, name)}?message=${res.messageId}` });
      } else {
        const res = await saveAnswerAsPage(address, remove, preview.digest);
        onDone({ kind: 'page', text: res.created ? 'Saved as a page.' : 'This answer is already saved as a page.', to: `/t/${tools.team}/files`, search: `?open=${encodeURIComponent(res.path)}` });
      }
    } catch (e) {
      // a copy that would now read otherwise (a reader joined the channel since): look at the new preview before sharing
      if (isApiError(e) && e.status === 409) {
        setError(`${e.message}`);
        void read();
      } else {
        setError(messageOf(e, 'It could not be shared.'));
      }
    } finally {
      setBusy(false);
    }
  };

  const channelName = targets?.find((t) => t.id === targetId)?.name;
  const title = mode === 'page' ? 'Save this answer as a page' : channelName ? `Share this answer to # ${channelName}` : 'Share this answer to a channel';
  return (
    <Dialog title={title} onClose={onClose} testId="answer-share-modal" wide>
      <ShareDialogView
        mode={mode}
        targets={targets}
        targetId={targetId}
        onTarget={(id) => {
          setTargetId(id);
          setRemoved(new Set());
        }}
        preview={preview}
        loading={loading}
        error={error}
        removed={removed}
        onToggle={toggle}
        who={who}
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={onClose}
      />
    </Dialog>
  );
}

/**
 * The answer with what a person can do with it: the toolbar (Share to channel, Save as page), the chips as buttons, and the dialogs. Used for an
 * answer in the reader's own conversation that was for them; any other answer is drawn by `Answer` alone.
 */
export function AnswerActions({
  payload,
  teamSlug,
  teamSlugOf,
  messageId,
  tools,
}: {
  payload: AnswerPayloadView;
  teamSlug: string | null;
  teamSlugOf: TeamSlugOf;
  messageId: string;
  tools: AnswerTools;
}) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Mode | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyChip, setBusyChip] = useState(false);
  const who = payload.answeredFor.name;

  const onChip = (chip: AnswerChip): void => {
    if (busyChip) return;
    setError(null);
    if (chip.kind === 'followup') {
      // the question goes into this thread as the person's own reply: the bot answers it as it answers anything said there
      if (tools.threadRootId !== null) void channelStore.send(tools.channelId, tools.threadRootId, chip.prompt, []);
      return;
    }
    setBusyChip(true);
    handoffAnswer({ channelId: tools.channelId, messageId }, chip.botId).then(
      (res) => {
        setBusyChip(false);
        void navigate({ pathname: `/t/${tools.team}/bots/${res.botSlug}/chat`, search: `?thread=${res.threadRootId}` });
      },
      (e: unknown) => {
        setBusyChip(false);
        setError(messageOf(e, 'It could not be handed over.'));
      },
    );
  };

  return (
    <div className="an-wrap" data-testid="answer-with-actions">
      <Answer payload={payload} teamSlug={teamSlug} teamSlugOf={teamSlugOf} onChip={onChip} />
      <div className="an-acts" data-testid="answer-actions">
        <button type="button" className="btn s" data-testid="answer-share-open" onClick={() => { setDone(null); setDialog('channel'); }}>Share to channel</button>
        <button type="button" className="btn s" data-testid="answer-save-open" onClick={() => { setDone(null); setDialog('page'); }}>Save as page</button>
        {done ? (
          <span className="an-act-done" role="status" data-testid="answer-share-done">
            {done.text}{' '}
            {done.kind === 'channel' ? <Link to={done.to}>Open</Link> : null}
            {done.kind === 'page' ? <Link to={{ pathname: done.to, search: done.search }}>Open page</Link> : null}
          </span>
        ) : null}
        {error ? <span className="an-act-error" role="alert" data-testid="answer-action-error">{error}</span> : null}
      </div>
      {dialog ? (
        <ShareDialog
          mode={dialog}
          tools={tools}
          messageId={messageId}
          who={who}
          onClose={() => setDialog(null)}
          onDone={(d) => {
            setDialog(null);
            setDone(d);
          }}
        />
      ) : null}
    </div>
  );
}
