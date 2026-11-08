import { PageHeader } from '../../../components/PageHeader';

/** Set to true by work package A when the admin page for connected apps is built (PLAN Bundle D, P16-11). Until then its entry is not in the settings menu. */
export const CONNECTIONS_ADMIN_READY = false;

/** `/settings/workspace/connections`: per service, how many people are connected, who needs to sign in again, failures and the permissions asked; and removing a leaving person's connections. Work package A builds it. */
export function ConnectionsAdmin() {
  return <PageHeader title="Connected apps" description="Coming in this bundle." />;
}
