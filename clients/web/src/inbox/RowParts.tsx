import type { ThreadInboxItem } from '@manythreads/shared';
import { ago } from '../channels/format';
import { usePeople } from '../channels/hooks';
import { Avatar } from '../components/ui';
import { highlight, type NeedsYou, type RowProgress } from './rules';

/*
 * The parts of a Threads row that the list row and the grid card share (P29, docs/plans/channel-task-view.md section 10c): the highlighted text, the "Needs you" chip, the one line
 * of progress, and the blocks under the reply count. The starting message is the head of a row; the reply count is the divider; ONE block follows it, drawn very differently from the head:
 * indented behind a muted elbow, ONE line with the replier's picture, name and time (and "Mentions you" when it names the person), then up to four lines of the reply on its own faint surface. When the latest reply is the one that names
 * the person, that same block takes the "Mentions you" look (never two blocks for one message); when the mention is an older reply, it is shown first and the latest reply follows.
 */

/** A text with the filter's words marked. */
export function Hl({ text, words }: { text: string; words: readonly string[] }) {
  if (words.length === 0) return <>{text}</>;
  return (
    <>
      {highlight(text, words).map((p, i) =>
        p.hit ? (
          <mark key={i} className="thc-hit">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

/** "Needs you": the row waits on the person (a question to decide, or a message that names them). Amber, with the reason in words for a screen reader. */
export function NeedsChip({ needs }: { needs: NeedsYou }) {
  if (!needs.needs) return null;
  const reason = needs.approval !== null ? 'an approval is waiting for you' : 'a message names you';
  return (
    <span className="thc-needs" data-testid="thread-needs-you" title={needs.approval !== null ? 'An approval is waiting for you' : 'Someone mentioned you'}>
      <span aria-hidden="true">Needs you</span>
      <span className="sr-only">{`Needs you: ${reason}`}</span>
    </span>
  );
}

/** The one line of progress: the bar and "2 of 4" with the item being worked on, or the bot and what it does now. One line, no card. */
export function ProgressLine({ progress }: { progress: RowProgress }) {
  const label = progress.count !== null ? `${progress.count}: ${progress.text}` : progress.text;
  return (
    <span className="thc-prog" data-testid="thread-progress" data-kind={progress.kind} data-tone={progress.tone} aria-label={label}>
      {progress.kind === 'todo' ? (
        <>
          <span className="thc-bar" aria-hidden="true">
            <span style={{ width: `${progress.pct ?? 0}%` }} />
          </span>
          <span className="thc-prog-count" aria-hidden="true">{progress.count}</span>
        </>
      ) : (
        <span className="thc-pulse" aria-hidden="true" />
      )}
      <span className="thc-prog-text" aria-hidden="true" data-vt-mask>{progress.text}</span>
    </span>
  );
}

type Who = { actorId?: string | undefined; name: string; kind: 'person' | 'bot' | 'system' | undefined };

function SmallFace({ who }: { who: Who }) {
  const people = usePeople();
  const person = who.actorId !== undefined && who.kind === 'person' ? people.byActor(who.actorId) : undefined;
  const name = person?.name ?? who.name;
  if (person) return <Avatar name={name} avatar={person.avatar} personId={person.personId} />;
  return <Avatar name={name} kind={who.kind === 'person' || who.kind === undefined ? 'person' : 'agent'} avatar={who.kind === 'bot' && who.actorId ? people.botAvatar(who.actorId) : null} />;
}

function Block({ kind, label, who, at, text, words }: { kind: 'latest' | 'mention'; label: string; who: Who; at: string | undefined; text: string; words: readonly string[] }) {
  const people = usePeople();
  const name = (who.actorId !== undefined && who.kind === 'person' ? people.byActor(who.actorId)?.name : undefined) ?? who.name;
  return (
    <span className="thc-blk" data-kind={kind} data-testid={kind === 'mention' ? 'thread-mention-block' : 'thread-latest-block'}>
      <span className="thc-blk-who">
        {/* "Latest reply" is what the elbow and the box already show, so it is said only to a screen reader; "Mentions you" is shown, it is news */}
        <span className={kind === 'mention' ? 'thc-blk-label' : 'sr-only'}>{kind === 'mention' ? label : `${label}: `}</span>
        <span className="thc-blk-face">
          <SmallFace who={who} />
        </span>
        <b data-vt-mask>{name}</b>
        {at ? <time dateTime={at} data-vt-mask>{ago(at)}</time> : null}
      </span>
      {text !== '' ? <span className="thc-blk-text" data-vt-mask><Hl text={text} words={words} /></span> : null}
    </span>
  );
}

/** What follows the reply count: the mention block and/or the latest-reply block, never two blocks for the same message, none when nobody has replied. */
export function ReplyBlocks({ item, words }: { item: ThreadInboxItem; words: readonly string[] }) {
  const mention = item.mention ?? null;
  const last = item.lastReply;
  const lastText = last ? last.preview.trim() : '';
  // the latest reply is the one that names the person: ONE block, in the mention's look
  const same = mention !== null && last !== null && last.messageId !== undefined && last.messageId === mention.messageId;
  return (
    <>
      {mention !== null ? (
        <Block kind="mention" label="Mentions you" who={{ actorId: mention.authorId, name: mention.authorName, kind: mention.kind }} at={mention.at} text={mention.preview.trim()} words={words} />
      ) : null}
      {last !== null && !same && lastText !== '' ? (
        <Block kind="latest" label="Latest reply" who={{ actorId: last.authorId, name: last.authorName, kind: last.kind }} at={last.at} text={lastText} words={words} />
      ) : null}
    </>
  );
}
