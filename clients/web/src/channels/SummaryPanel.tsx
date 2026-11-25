import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SummariseRequest, SummariseResponse, SummaryRange } from '@manythreads/shared';
import { fetchChannel, summarise } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import type { PanelEntry } from '../kernel/panel';
import { usePanelTitle } from '../kernel/panel/sub';
import { uploadPersonalFile } from '../screens/files/personalApi';
import { usePresence } from '../presence/hooks';
import { useShell } from '../shell/context';
import { CopyTextIcon, RegenerateIcon, SavePageIcon, SummariseIcon } from '../shell/icons';
import { messageLocation, useOpenMessage } from '../shell/messageLink';
import { Markdown } from './MessageMarkdown';
import {
  RANGE_LABEL,
  SUMMARY_FOLDER,
  coverageText,
  defaultRange,
  emptyText,
  parseSummaryPanelId,
  rangesOf,
  readStartOf,
  summaryFileName,
  summaryFileText,
  type SummaryPlace,
} from './summaryModel';

/*
 * The right panel's Summary (P18-05, docs/plans/catch-me-up.md): Brain's short summary of a channel or a thread for the person looking, from only the messages they
 * may read. Nothing is posted; the person may copy it or save it to their Personal files. Each `[n]` opens the message it comes from, with the summary kept below.
 */

type Ready = Extract<SummariseResponse, { state: 'ready' }>;
type Shown = { status: 'loading' } | { status: 'ok'; data: SummariseResponse } | { status: 'error'; message: string };

/**
 * One request per place, range, start and press of Again, shared by the draws of the panel within a minute (a second mount, or React drawing twice, does not ask
 * again and is not refused as "still writing"); after that the panel asks afresh, so a summary opened later covers what came in since.
 */
const REUSE_MS = 60_000;
const asked = new Map<string, { at: number; p: Promise<SummariseResponse> }>();
function ask(place: SummaryPlace, range: SummaryRange, round: number): Promise<SummariseResponse> {
  const start = range === 'new' ? readStartOf(place) : undefined;
  const key = `${place.channelId}.${place.threadRootId ?? ''}|${range}|${start === undefined ? '-' : (start ?? 'none')}|${round}`;
  const now = Date.now();
  const known = asked.get(key);
  if (known && now - known.at < REUSE_MS) return known.p;
  // the ids come from the panel's address and the screen's read state: the server checks them like any other
  const request = { threadRootId: place.threadRootId, range, ...(start !== undefined ? { afterMessageId: start } : {}) } as SummariseRequest;
  const p = summarise(place.channelId, request);
  asked.set(key, { at: now, p });
  // a failure is not kept: pressing the range again asks again
  p.catch(() => asked.delete(key));
  for (const [k, v] of asked) if (now - v.at >= REUSE_MS) asked.delete(k);
  return p;
}

/** For tests: forget every summary asked for. */
export const forgetSummaries = (): void => asked.clear();

export function SummaryPanel({ entry }: { entry: PanelEntry }) {
  const place = useMemo(() => parseSummaryPanelId(entry.id), [entry.id]);
  if (!place) {
    return (
      <div className="panel-empty" role="alert">
        <p className="panel-empty-title">This summary link is not valid.</p>
      </div>
    );
  }
  return <SummaryBody key={entry.id} place={place} entry={entry} />;
}

function SummaryBody({ place, entry }: { place: SummaryPlace; entry: PanelEntry }) {
  const { team, teamSlug } = useShell();
  const slug = team?.slug ?? teamSlug ?? '';
  const openMessage = useOpenMessage();
  const info = useQuery(`channel:${place.channelId}`, () => fetchChannel(place.channelId));
  const channel = info.status === 'ok' ? info.data.channel : null;
  const channelName = channel ? channel.name.replace(/^#/, '') : '';
  const dm = channel !== null && channel.kind === 'dm';
  const placeName = channel === null ? 'this channel' : dm ? 'this conversation' : `#${channelName}`;
  usePanelTitle(place.threadRootId ? 'Summary of this thread' : channel ? `Summary of ${placeName}` : 'Summary');

  const [range, setRange] = useState<SummaryRange>(() => defaultRange(place));
  // "Since I was away" is offered while the person is out of office and for two weeks after (the server says when it began)
  const away = usePresence().me?.away != null;
  const [round, setRound] = useState(0);
  const [shown, setShown] = useState<Shown>({ status: 'loading' });
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setShown({ status: 'loading' });
    setNote(null);
    ask(place, range, round).then(
      (data) => live && setShown({ status: 'ok', data }),
      (e: unknown) => live && setShown({ status: 'error', message: e instanceof Error && e.message ? e.message : 'Brain could not write the summary. Try again.' }),
    );
    return () => {
      live = false;
    };
  }, [place, range, round]);

  const target = useCallback(
    (s: Ready['sources'][number]) => ({
      channelId: place.channelId,
      channelKind: dm ? ('dm' as const) : ('channel' as const),
      channelName: dm ? null : channelName,
      teamId: channel?.teamId ?? null,
      messageId: s.messageId,
      threadRootId: s.threadRootId,
    }),
    [place.channelId, dm, channelName, channel?.teamId],
  );

  const ready = shown.status === 'ok' && shown.data.state === 'ready' ? shown.data : null;
  const byNumber = useMemo(() => new Map((ready?.sources ?? []).map((s) => [s.n, s])), [ready]);
  const cited = useMemo(() => new Set(byNumber.keys()), [byNumber]);
  const marker = useCallback(
    (n: number, key: string): ReactNode => {
      const s = byNumber.get(n);
      if (!s) return null;
      return (
        <sup key={key} className="an-ref">
          <button type="button" className="csm-ref" aria-label={`Open message ${n}`} title="Open the message" data-testid="summary-marker" onClick={() => void openMessage(target(s), [entry], { land: true })}>
            {n}
          </button>
        </sup>
      );
    },
    [byNumber, openMessage, target, entry],
  );

  const copy = async (s: Ready): Promise<void> => {
    try {
      await navigator.clipboard.writeText(s.body);
      setNote('Copied.');
    } catch {
      setNote('Could not copy. Select the text and copy it instead.');
    }
  };
  const save = async (s: Ready): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setNote(null);
    const at = new Date();
    const linkOf = (src: Ready['sources'][number]): string | null => {
      if (!slug) return null;
      const to = messageLocation(slug, target(src));
      return `${window.location.origin}${to.pathname}${to.search}`;
    };
    const text = summaryFileText(s, place.threadRootId ? `a thread in ${placeName}` : placeName, at, linkOf);
    try {
      await uploadPersonalFile(SUMMARY_FOLDER, new File([text], summaryFileName(place.threadRootId ? `${placeName} thread` : placeName, at), { type: 'text/markdown' }), 'rename', () => undefined);
      setNote(`Saved in your Personal files, folder ${SUMMARY_FOLDER}.`);
    } catch (e) {
      setNote(e instanceof Error && e.message ? e.message : 'Could not save it. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="csm" data-testid="summary-panel">
      <div className="csm-ranges" role="group" aria-label="What to summarise">
        {rangesOf(place, away || range === 'away').map((r) => (
          <button key={r} type="button" className="csm-range" aria-pressed={r === range} data-testid={`summary-range-${r}`} onClick={() => setRange(r)}>
            {RANGE_LABEL[r]}
          </button>
        ))}
      </div>
      <p className="csm-note">Only you see this summary. Brain reads only messages you can read, and nothing is posted.</p>
      {shown.status === 'loading' ? (
        <p className="csm-wait" role="status" aria-busy="true" data-testid="summary-loading">
          <SummariseIcon /> Brain is reading {placeName}…
        </p>
      ) : shown.status === 'error' ? (
        <div className="csm-problem" role="alert" data-testid="summary-error">
          <p>{shown.message}</p>
          <button type="button" className="btn s" onClick={() => setRound((n) => n + 1)}>Try again</button>
        </div>
      ) : shown.data.state === 'empty' ? (
        <div className="panel-empty" data-testid="summary-empty">
          <p className="panel-empty-title">{emptyText(range, place.threadRootId ? 'this thread' : placeName)}</p>
          {!place.threadRootId && range !== 'week' ? <p className="panel-empty-body">Try a longer range above.</p> : null}
        </div>
      ) : (
        <>
          <div className="csm-body" data-testid="summary-body">
            <Markdown source={shown.data.body} teamSlug={slug || null} marker={marker} cited={cited} />
          </div>
          <div className="csm-cover" data-testid="summary-coverage">
            {coverageText(shown.data).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p>Written by {shown.data.botName}. It can be wrong: open a number to see the message.</p>
          </div>
          <div className="csm-actions">
            <button type="button" className="btn s" data-testid="summary-copy" onClick={() => void copy(shown.data as Ready)}>
              <CopyTextIcon /> Copy
            </button>
            <button type="button" className="btn s" data-testid="summary-save" disabled={saving} onClick={() => void save(shown.data as Ready)}>
              <SavePageIcon /> {saving ? 'Saving…' : 'Save to my files'}
            </button>
            <button type="button" className="btn s" data-testid="summary-again" onClick={() => setRound((n) => n + 1)}>
              <RegenerateIcon /> Again
            </button>
          </div>
          {note ? <p className="csm-saved" role="status" data-testid="summary-note">{note}</p> : null}
        </>
      )}
    </div>
  );
}
