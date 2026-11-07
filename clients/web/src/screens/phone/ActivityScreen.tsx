import { PageHeader } from '../../components/PageHeader';
import { NotificationList } from '../../notifications/NotificationList';

/** The Activity page (`/t/<team>/activity`): the bell's notifications as a full page, the same items and the same Unread / All tabs. It sits behind the phone's bottom bar. */
export function ActivityScreen() {
  return (
    <div className="phone-page act-page" data-testid="activity-screen">
      <PageHeader title="Activity" description="Mentions, replies and other news for you." />
      <div className="act-list" data-testid="activity-list">
        <NotificationList mode="page" />
      </div>
    </div>
  );
}
