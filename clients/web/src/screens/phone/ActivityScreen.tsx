import { PageHeader } from '../../components/PageHeader';

/** The phone's Activity page: the notifications as a full page behind the bottom bar. A placeholder until it is built (P21-10, work package C). */
export function ActivityScreen() {
  return (
    <div className="phone-page" data-testid="activity-screen">
      <PageHeader title="Activity" description="Mentions, replies and other news for you." />
      <p className="empty-body">Coming in this bundle.</p>
    </div>
  );
}
