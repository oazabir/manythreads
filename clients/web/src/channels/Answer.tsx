import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ANSWER_MASKED_KIND,
  isSupportedCitation,
  type AnswerChip,
  type AnswerCitation,
  type AnswerOutsideReason,
  type AnswerPayloadView,
  type AnswerUnsupportedCitation,
} from '@manythreads/shared';
import { fileContentUrl } from '../api/endpoints';
import { messageLocation } from '../shell/messageLink';
import { ago } from './format';
import { Markdown } from './MessageMarkdown';

/*
 * The Answer (SPEC §12.4, §14; PLAN P5-18; `[proto §12]` plate 2): what a bot finished its reply with. The text is the message; around it the
 * platform's own statement of what the answer rests on — numbered citations that open the cited item, the Lineage (each source, how old, the
 * words quoted), Sources reached (what the run read; "your connection" for what was read as the asker), Outside scope (how many sources the
 * asker or the reply's readers could not see, and why — never a title) and "Answered for <person> · scoped · <alias>". The suggested next steps
 * are chips. In the asker's own conversation they act (P5-17: a follow-up is sent into the thread, "Hand to <bot>" opens a thread with that
 * bot) and the answer can be shared to a channel with masking or saved as a page (`AnswerShare.tsx`); anywhere else they are only drawn.
 * A copy a person shared says, for each source its readers may not open, "from <person>'s <kind> · not shared".
 *
 * Forward compatibility: a citation of a kind this client does not know arrives as `AnswerUnsupportedCitation` and is drawn as a neutral
 * "Unsupported source" chip — it never throws and never hides the answer.
 */

/** Where a citation opens: a route of the app, a download, or nowhere (a source that has no page of its own yet). */
export type CitationTarget =
  | { type: 'route'; pathname: string; search: string; state: unknown }
  | { type: 'download'; href: string }
  | null;

/** The team slug of a team id, when the reader knows it. */
export type TeamSlugOf = (teamId: string) => string | null;

export function citationTarget(c: AnswerCitation, teamSlug: string, teamSlugOf: TeamSlugOf): CitationTarget {
  switch (c.kind) {
    case 'message': {
      const to = messageLocation(teamSlugOf(c.teamId ?? '') ?? teamSlug, {
        channelId: c.channelId,
        channelKind: c.channelKind,
        channelName: c.channelName,
        messageId: c.messageId,
        threadRootId: c.threadRootId,
      });
      return { type: 'route', pathname: to.pathname, search: to.search, state: to.state };
    }
    case 'thread': {
      const to = messageLocation(teamSlugOf(c.teamId ?? '') ?? teamSlug, {
        channelId: c.channelId,
        channelKind: c.channelKind,
        channelName: c.channelName,
        messageId: c.threadRootId,
        threadRootId: c.threadRootId,
      });
      return { type: 'route', pathname: to.pathname, search: to.search, state: to.state };
    }
    case 'page': {
      const slug = teamSlugOf(c.teamId) ?? teamSlug;
      return { type: 'route', pathname: `/t/${slug}/files`, search: `?open=${encodeURIComponent(c.path)}`, state: null };
    }
    case 'file':
      return { type: 'download', href: fileContentUrl(c.fileId) };
    case 'run':
      return c.botSlug ? { type: 'route', pathname: `/t/${teamSlug}/bots/${c.botSlug}`, search: '?tab=audit', state: null } : null;
    case 'masked':
      return null;
  }
}

const KIND_NAMES: Record<string, readonly [string, string]> = {
  message: ['message', 'messages'],
  thread: ['thread', 'threads'],
  page: ['page', 'pages'],
  file: ['file', 'files'],
  run: ['run', 'runs'],
  memory: ['memory item', 'memory items'],
};

/** "1 message", "2 pages": a kind and a count in words; a kind this client has no word for is "source". */
export function kindCount(kind: string, count: number): string {
  const names = KIND_NAMES[kind] ?? ['source', 'sources'];
  return `${count} ${count === 1 ? names[0] : names[1]}`;
}

const KIND_LABEL: Record<string, string> = { message: 'Message', thread: 'Thread', page: 'Page', file: 'File', run: 'Run', memory: 'Memory' };
const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? 'Source';

const SOURCE_NOUN: Record<string, string> = { message: 'message', thread: 'thread', page: 'page', file: 'file', run: 'run', drive: 'Drive', memory: 'memory item' };

/** What a shared copy says of a source its readers may not open: "from Omar's message · not shared". Nothing of the source itself. */
export function maskedLine(who: string | null, source: string): string {
  return `from ${who ?? 'the asker'}’s ${SOURCE_NOUN[source] ?? 'source'} · not shared`;
}

const REASON: Record<AnswerOutsideReason, string> = {
  not_visible: 'not visible to the person who asked',
  not_granted: 'not granted to this bot',
  not_shared: 'private to the person who asked, so not shown to this channel',
  not_reached: 'not read by this bot in this run',
};

/** "Answered for Omar · scoped · smart": whom the answer was for, how it was scoped, and the model alias it ran on. */
export function answeredForLine(a: AnswerPayloadView['answeredFor']): string {
  const parts = [`Answered for ${a.name ?? 'the team'}`, a.scope];
  if (a.alias) parts.push(a.alias);
  return parts.join(' · ');
}

function CiteBody({ n, label }: { n: number; label: string }): ReactNode {
  return (
    <>
      <span className="an-n" aria-hidden="true">{n}</span>
      <span className="an-cite-label">{label}</span>
    </>
  );
}

function Citation({ c, teamSlug, teamSlugOf, who }: { c: AnswerCitation | AnswerUnsupportedCitation; teamSlug: string; teamSlugOf: TeamSlugOf; who: string | null }) {
  if (!isSupportedCitation(c)) {
    return (
      <li>
        <span className="an-cite an-cite-unsupported" data-testid="answer-citation" data-kind={c.kind} data-n={c.n}>
          <CiteBody n={c.n} label="Unsupported source" />
        </span>
      </li>
    );
  }
  if (c.kind === ANSWER_MASKED_KIND) {
    return (
      <li>
        <span className="an-cite an-cite-masked" data-testid="answer-citation" data-kind="masked" data-n={c.n} data-source={c.source}>
          <CiteBody n={c.n} label={maskedLine(who, c.source)} />
        </span>
      </li>
    );
  }
  const target = citationTarget(c, teamSlug, teamSlugOf);
  const common = { className: `an-cite an-scope-${c.scope}`, 'data-testid': 'answer-citation', 'data-kind': c.kind, 'data-n': c.n } as const;
  const label = `Source ${c.n}: ${c.label}`;
  if (target?.type === 'route') {
    return (
      <li>
        <Link {...common} aria-label={label} to={{ pathname: target.pathname, search: target.search }} state={target.state}>
          <CiteBody n={c.n} label={c.label} />
        </Link>
      </li>
    );
  }
  if (target?.type === 'download') {
    return (
      <li>
        <a {...common} aria-label={label} href={target.href} download>
          <CiteBody n={c.n} label={c.label} />
        </a>
      </li>
    );
  }
  return (
    <li>
      <span {...common} title={label}>
        <CiteBody n={c.n} label={c.label} />
      </span>
    </li>
  );
}

/** The line under a shared copy that says it was cut: "Shared by Omar · 1 source not shared · 1 claim removed". */
export function shareNote(who: string | null, share: { masked: number; removed: number }): string {
  const parts = [`Shared by ${who ?? 'the person who asked'}`];
  if (share.masked > 0) parts.push(`${share.masked} ${share.masked === 1 ? 'source' : 'sources'} not shared`);
  if (share.removed > 0) parts.push(`${share.removed} ${share.removed === 1 ? 'claim' : 'claims'} removed`);
  return parts.join(' · ');
}

const NO_TEAMS: TeamSlugOf = () => null;

type Props = {
  payload: AnswerPayloadView;
  /** The team of the page the reader is on: where relative links go. */
  teamSlug: string | null;
  teamSlugOf?: TeamSlugOf;
  /** What choosing a chip does (P5-17). Without it the chips are shown and inert: this version only carries their data. */
  onChip?: (chip: AnswerChip) => void;
};

function Chip({ className, kind, chip, onChip, bot, children }: { className: string; kind: string; chip: AnswerChip; onChip: ((chip: AnswerChip) => void) | undefined; bot?: string; children: ReactNode }) {
  const data = { 'data-kind': kind, ...(bot ? { 'data-bot': bot } : {}) };
  if (!onChip) return <span className={className} {...data}>{children}</span>;
  return (
    <button type="button" className={className} {...data} onClick={() => onChip(chip)}>
      {children}
    </button>
  );
}

/** The Answer, drawn from a stored payload. Pure of the shell: `AnswerMessage` below wires it to the reader's teams. */
export function Answer({ payload, teamSlug, teamSlugOf = NO_TEAMS, onChip }: Props) {
  const slug = teamSlug ?? '';
  const byNumber = useMemo(() => new Map(payload.citations.map((c) => [c.n, c] as const)), [payload.citations]);
  // only a number the answer has a citation for becomes a superscript, and the gaps below its highest (a citation the answer left out keeps
  // its number, muted); `arr[0]` and a `[12]` beyond the last citation stay the text they were written as
  const citedNumbers = useMemo(() => {
    const kept = payload.citations.map((c) => c.n);
    const top = kept.reduce((m, n) => Math.max(m, n), 0);
    return new Set(Array.from({ length: top }, (_, i) => i + 1));
  }, [payload.citations]);
  const lineage = payload.lineage;
  const reached = payload.sourcesReached;
  const outside = payload.outsideScope;
  const handoffs = payload.chips.filter((c) => c.kind === 'handoff');
  const followups = payload.chips.filter((c) => c.kind === 'followup');

  // `[3]` in the text becomes the citation's number: a link to the source when the answer kept it, a muted number when it was left out
  const marker = useMemo(
    () => (n: number, key: string): ReactNode => {
      const c = byNumber.get(n);
      if (c && isSupportedCitation(c)) {
        if (c.kind === ANSWER_MASKED_KIND) {
          // a source the copy's readers may not open: the number stays (the claim rests on something), muted, and says so
          return (
            <sup key={key} className="an-ref an-ref-masked" data-testid="answer-marker-masked" title={maskedLine(payload.answeredFor.name, c.source)}>
              <span>{n}</span>
            </sup>
          );
        }
        const target = citationTarget(c, slug, teamSlugOf);
        const label = `Source ${n}: ${c.label}`;
        if (target?.type === 'route') {
          return (
            <sup key={key} className="an-ref">
              <Link to={{ pathname: target.pathname, search: target.search }} state={target.state} aria-label={label} data-testid="answer-marker">{n}</Link>
            </sup>
          );
        }
        if (target?.type === 'download') {
          return (
            <sup key={key} className="an-ref">
              <a href={target.href} download aria-label={label} data-testid="answer-marker">{n}</a>
            </sup>
          );
        }
        return <sup key={key} className="an-ref" data-testid="answer-marker"><span>{n}</span></sup>;
      }
      return <sup key={key} className="an-ref an-ref-gone" data-testid="answer-marker-gone"><span>{n}</span></sup>;
    },
    [byNumber, slug, teamSlugOf, payload.answeredFor.name],
  );

  return (
    <div className="an" data-testid="answer" data-citations={payload.citations.length} data-landmark="answer">
      <div className="an-text txt" data-testid="answer-text">
        {/* the Answer's own text (`meta.answer.body`, which the platform keeps equal to the message's body) */}
        <Markdown source={payload.body} teamSlug={teamSlug} marker={marker} cited={citedNumbers} />
      </div>
      {payload.share && (payload.share.masked > 0 || payload.share.removed > 0) ? (
        <p className="an-share-note" data-testid="answer-share-note">{shareNote(payload.answeredFor.name, payload.share)}</p>
      ) : null}

      {payload.citations.length > 0 ? (
        <ol className="an-cites" data-testid="answer-citations" aria-label="Sources cited">
          {payload.citations.map((c) => (
            <Citation key={c.n} c={c} teamSlug={slug} teamSlugOf={teamSlugOf} who={payload.answeredFor.name} />
          ))}
        </ol>
      ) : null}

      {lineage.length > 0 ? (
        <section className="an-sec" data-testid="answer-lineage" aria-label="Lineage">
          <div className="an-h" role="heading" aria-level={4}>Lineage</div>
          <ol className="an-lin-list">
            {lineage.map((l) => (
              <li key={l.n} className={`an-lin ${l.masked ? 'an-lin-masked' : ''}`} data-testid="answer-lineage-row" data-n={l.n} data-masked={l.masked ? 'true' : undefined}>
                <span className="an-n" aria-hidden="true">{l.n}</span>
                <span className="an-nm">{l.masked ? maskedLine(payload.answeredFor.name, l.kind) : l.label}</span>
                {l.at ? <span className="an-age" data-vt-mask>{ago(l.at)}</span> : null}
                {l.masked ? <span className="an-sn an-sn-removed">snippet removed</span> : null}
                {l.snippet ? <span className="an-sn" data-vt-mask>{`“${l.snippet}”`}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {reached.length > 0 ? (
        <section className="an-sec" data-testid="answer-reached" aria-label="Sources reached">
          <div className="an-h" role="heading" aria-level={4}>Sources reached</div>
          <ul className="an-src-list">
            {reached.map((s, i) => (
              <li key={`${s.kind}:${s.ref}:${i}`} className="an-src" data-testid="answer-reached-row" data-marker={s.marker}>
                <span className={`an-dot ${s.marker}`} aria-hidden="true" />
                <span className="an-src-kind">{kindLabel(s.kind)}</span>
                {s.label ? <span className="an-src-label">{s.label}</span> : null}
                {s.marker === 'scoped' ? <span className="an-mark">through the asker’s own connection</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {outside.count > 0 ? (
        <section className="an-sec" data-testid="answer-outside" aria-label="Outside scope">
          <div className="an-h" role="heading" aria-level={4}>Outside scope</div>
          <ul className="an-src-list">
            {outside.items.map((o, i) => (
              <li key={`${o.kind}:${o.reason}:${i}`} className="an-src an-miss" data-testid="answer-outside-row" data-reason={o.reason}>
                <span className="an-dot miss" aria-hidden="true" />
                <span>{`${kindCount(o.kind, o.count)} · ${REASON[o.reason]}`}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {followups.length > 0 ? (
        <div className="an-chips" data-testid="answer-followups">
          {followups.map((c, i) =>
            c.kind === 'followup' ? (
              <Chip key={`${c.prompt}:${i}`} className="an-chip" kind="followup" chip={c} onChip={onChip}>{c.label}</Chip>
            ) : null,
          )}
        </div>
      ) : null}

      {handoffs.length > 0 ? (
        <section className="an-sec" data-testid="answer-chips" aria-label="Hand to a bot">
          <div className="an-h" role="heading" aria-level={4}>Hand to a bot</div>
          <div className="an-chips">
            {handoffs.map((c) =>
              c.kind === 'handoff' ? (
                <Chip key={c.botId} className="an-chip an-chip-bot" kind="handoff" chip={c} onChip={onChip} bot={c.botSlug}>{`@${c.botName}`}</Chip>
              ) : null,
            )}
          </div>
        </section>
      ) : null}

      <div className="an-foot" data-testid="answer-for">{answeredForLine(payload.answeredFor)}</div>
    </div>
  );
}
