import { PageHeader } from '../../components/PageHeader';

/** The phone's Messages page: the list of direct messages behind the bottom bar. A placeholder until it is built (P21-23, work package E1). */
export function MessagesScreen() {
  return (
    <div className="phone-page" data-testid="messages-screen">
      <PageHeader title="Messages" description="Your direct messages." />
      <p className="empty-body">Coming in this bundle.</p>
    </div>
  );
}
