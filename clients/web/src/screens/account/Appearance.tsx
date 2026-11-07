import { PageHeader } from '../../components/PageHeader';

/**
 * Work package A sets this to true when the page below is the real setting. Until then the Account menu does not list the page (the route
 * exists, so a link or a test can already reach it), which keeps every settings screen as it was.
 */
export const APPEARANCE_PAGE_READY = false;

/** Account → Appearance: the theme and the message density. A placeholder until the setting is built (P21-21, work package A). */
export function Appearance() {
  return (
    <>
      <PageHeader title="Appearance" description="How manythreads looks to you: light or dark, and how close together messages sit." />
      <p className="empty-body">Coming in this bundle.</p>
    </>
  );
}
