import { memo } from 'react';
import type { ThreadInboxItem } from '@manythreads/shared';
import { ago } from '../channels/format';
import { usePeople } from '../channels/hooks';
import { channelLabel, markerLabel, repliesLine, withHandles } from '../screens/threadCard';
import { QuestionStrip } from '../taskview/QuestionStrip';
import { Hl, NeedsChip, ProgressLine, ReplyBlocks } from './RowParts';
import { NOT_NEEDED, progressOf, type NeedsYou } from './rules';
import { NO_WORK, type RowWork } from './work';

const NO_WORDS: readonly string[] = [];
const NOOP = (): void => undefined;

/**
 * One thread as a card in the grid (P29-17): where it lives and who started it, the starting message, how far its work has come, the one block under the reply count, the question that
 * waits on the person with its own buttons (the same decide path as everywhere), and an open action. The card is not one big button, because the question's buttons live inside it.
 */
export const ThreadGridCard = memo(function ThreadGridCard({
  item,
  slug,
  onOpen,
  words = NO_WORDS,
  work = NO_WORK,
  needs = NOT_NEEDED,
}: {
  item: ThreadInboxItem;
  slug: string;
  onOpen: (rootId: string) => void;
  words?: readonly string[];
  work?: RowWork;
  needs?: NeedsYou;
}) {
  const people = usePeople();
  const unread = item.unreadCount > 0;
  const rootName = (item.rootAuthor && people.byActor(item.rootAuthor.actorId)?.name) ?? item.rootAuthor?.displayName ?? 'Someone';
  const progress = progressOf(work.todo, work.run ? { botName: work.run.botName, head: work.run.head } : null);
  const waiting = work.questions.filter((q) => q.status === 'pending');
  const label = markerLabel(item);
  return (
    <li className={`thg ${needs.needs ? 'needs' : ''} ${unread ? 'unread' : ''}`} data-testid="thread-card" data-root-id={item.rootMessageId}>
      <div className="thg-head">
        <b className="thc-who" data-vt-mask>{rootName}</b>
        <span className="thc-place" title={channelLabel(item.channel)}><Hl text={channelLabel(item.channel)} words={words} /></span>
        <NeedsChip needs={needs} />
        <time className="thc-time thg-time" dateTime={item.lastReplyAt} data-vt-mask>{ago(item.lastReplyAt)}</time>
      </div>
      <button type="button" className="thg-open" data-testid="thread-card-open" onClick={() => onOpen(item.rootMessageId)}>
        <span className="thc-text thg-text" data-vt-mask>{withHandles(item.title).map((p, i) => (p.handle ? <span key={i} className="thc-handle">{p.text}</span> : <Hl key={i} text={p.text} words={words} />))}</span>
        {progress ? <ProgressLine progress={progress} /> : null}
        <span className="thc-foot">
          {item.mentionCount > 0 ? <span className="thc-tag" data-vt-mask>{item.mentionCount}</span> : unread ? <span className="thc-dot" /> : null}
          <span className={`thc-replies ${unread ? 'new' : ''}`} data-vt-mask>{repliesLine(item)}</span>
          {label ? <span className="sr-only">{label}</span> : null}
        </span>
        <ReplyBlocks item={item} words={words} />
      </button>
      {waiting.length > 0 ? <QuestionStrip questions={waiting} slug={slug} rootId={item.rootMessageId} onDecided={NOOP} /> : null}
    </li>
  );
});
