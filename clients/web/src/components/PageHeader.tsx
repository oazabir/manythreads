import type { ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { useHeaderActionsSlot, useHeaderTitleSlot, useOwnsPageTitle } from '../shell/topic';
import { useNarrow } from '../shell/useNarrow';

/**
 * The one page header (P21-12): a single h1, an optional one-line description, and the page's actions (at most one primary button).
 * Every screen uses it. Inside the shell the h1 is drawn in the shell's band (P34-06): one row with the title on the left and the tools on the right,
 * the same height, padding, type and divider as a channel's header, and no trail above it. On a wide screen the actions sit in the band too; on a
 * phone they stay on the page under it, beside the description, so the band stays one row. Outside the shell (the settings and account frames), or
 * with `inline` (a header that belongs to a block of its own, such as a bot's head with its avatar), the header is drawn where the screen puts it.
 * `headingRef` and `tabIndex -1` let a screen that moves focus to its heading keep doing so; `copyId` keeps the `data-copy` hook of the onboarding
 * copy tests.
 */
export function PageHeader({ title, description, actions, compact, headingRef, copyId, testIds, inline }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  copyId?: string;
  /** test ids for the title and description, so a screen's existing specs keep their hooks */
  testIds?: { title?: string; description?: string };
  /** draw the header in place, never in the shell's band */
  inline?: boolean;
}) {
  useOwnsPageTitle();
  const band = useHeaderTitleSlot();
  const actionsSlot = useHeaderActionsSlot();
  const narrow = useNarrow();
  const inBand = band !== null && !inline;
  const h1 = (
    <h1 className={inBand ? 'chead-title ph-band-title' : 'ph-title'} data-landmark="title" data-copy={copyId} data-testid={testIds?.title} tabIndex={-1} ref={headingRef}>
      {title}
    </h1>
  );
  const desc = description ? <p className="ph-desc" data-testid={testIds?.description}>{description}</p> : null;
  if (!inBand) {
    return (
      <header className={compact ? 'ph compact' : 'ph'} data-landmark="page-header">
        <div className="ph-text">
          {h1}
          {desc}
        </div>
        {actions ? <div className="ph-actions">{actions}</div> : null}
      </header>
    );
  }
  const actionsInBand = actions && !narrow && actionsSlot !== null;
  const pageActions = actions && !actionsInBand ? actions : null;
  return (
    <>
      {createPortal(h1, band)}
      {actionsInBand ? createPortal(<div className="ph-actions ph-band-actions">{actions}</div>, actionsSlot) : null}
      {desc || pageActions ? (
        <header className={compact ? 'ph ph-under compact' : 'ph ph-under'} data-landmark="page-header">
          {desc ? <div className="ph-text">{desc}</div> : null}
          {pageActions ? <div className="ph-actions">{pageActions}</div> : null}
        </header>
      ) : null}
    </>
  );
}
