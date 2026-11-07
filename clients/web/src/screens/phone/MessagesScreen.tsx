import { useParams } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { SkeletonRows } from '../../components/Skeleton';
import { useDms } from '../../dms/store';
import { DmRows, NewMessageButton } from '../../shell/DirectMessages';
import { DmIcon } from '../../shell/icons';

/**
 * The phone's Messages page (P21-23): the person's direct messages as a full page behind the bottom bar, the same rows as the sidebar section
 * (unread count, presence dot, row menu), with "New message" first so its picker has the room below it.
 */
export function MessagesScreen() {
  const slug = useParams().team ?? '';
  const feed = useDms();
  return (
    <div className="phone-page" data-testid="messages-screen">
      <PageHeader title="Messages" description="Your direct messages." />
      <NewMessageButton slug={slug} />
      {feed.status === 'loading' ? <SkeletonRows rows={4} avatar label="Loading messages" /> : null}
      {feed.status === 'ok' && feed.items.length === 0 ? (
        <EmptyState icon={DmIcon} title="No messages yet" testId="messages-empty">Pick a person above to start a conversation.</EmptyState>
      ) : null}
      {feed.status === 'error' ? <p className="empty-body" role="alert">Could not load your messages. Try again in a moment.</p> : null}
      {feed.status === 'absent' ? <p className="empty-body">Direct messages are not turned on here.</p> : null}
      <DmRows slug={slug} />
    </div>
  );
}
