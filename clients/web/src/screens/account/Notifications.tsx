import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { NotificationSettings } from '../../notifications/NotificationSettings';
import { PresenceSettings } from '../../presence/PresenceSettings';

/** Account → Notifications: what may interrupt you, and the status / Do not disturb settings. */
export function Notifications() {
  const { hash } = useLocation();
  // a link such as /account#acc-notifications arrives here after a redirect, which the browser does not scroll for; the status section scrolls itself once it is drawn
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    if (id !== '' && id !== 'status-and-dnd') document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [hash]);
  return (
    <>
      <PageHeader title="Notifications" description="What may interrupt you, by channel, by email and in this browser, and when you want quiet." />
      <NotificationSettings />
      <PresenceSettings />
    </>
  );
}
