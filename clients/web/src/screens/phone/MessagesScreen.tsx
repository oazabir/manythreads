import { useParams } from 'react-router';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { SkeletonRows } from '../../components/Skeleton';
import { DmChatList } from '../../dms/DmChatList';
import { useDms } from '../../dms/store';
import { NewMessageButton } from '../../shell/DirectMessages';
import { DmIcon } from '../../shell/icons';
import { useNewRequest } from '../../shell/useNewRequest';

/**
 * The Messages page (P21-23): the person's direct messages as a full page, behind the bottom bar on a phone and from the sidebar's "Direct messages" heading on
 * a desktop, with "New message" first so its picker has the room below it. The rows are a chat app's list (P34-05): face, name, time, last line, unread count.
 */
export function MessagesScreen() {
  const slug = useParams().team ?? '';
  const feed = useDms();
  // "Message a person" in the sidebar's New menu (`?new=person`): the picker opens, with the cursor in its search box
  const asked = useNewRequest(['person'] as const);
  return (
    <div className="phone-page" data-testid="messages-screen">
      <PageHeader title="Messages" description="Your direct messages." />
      <NewMessageButton slug={slug} asked={asked.kind === 'person'} onAsked={asked.done} />
      {feed.status === 'loading' ? <SkeletonRows rows={4} avatar label="Loading messages" /> : null}
      {feed.status === 'ok' && feed.items.length === 0 ? (
        <EmptyState icon={DmIcon} title="No messages yet" testId="messages-empty">Pick a person above to start a conversation.</EmptyState>
      ) : null}
      {feed.status === 'error' ? <p className="empty-body" role="alert">Could not load your messages. Try again in a moment.</p> : null}
      {feed.status === 'absent' ? <p className="empty-body">Direct messages are not turned on here.</p> : null}
      <DmChatList slug={slug} />
    </div>
  );
}
