/*
 * Loading placeholders (P21-22): grey bars where a list's rows or a channel's messages will be, instead of the word "Loading…".
 * Both render `role="status"` and `aria-busy="true"` with a label, so a screen reader hears what is loading and the visual specs
 * (`settle()` waits for every `[aria-busy="true"]` to go) keep waiting for the real rows. The shimmer lives in styles/states.css and
 * only runs when the person has not asked for reduced motion. Inline waits inside a dialog or a button stay words.
 */

// bar widths cycle through these so a stack of rows does not look like a barcode; fixed, so a screenshot never changes
const TITLE_WIDTHS = ['46%', '62%', '38%', '54%', '70%'] as const;
const SUB_WIDTHS = ['72%', '58%', '80%', '64%', '50%'] as const;

/** Rows of a list: an optional round avatar, a title bar and a shorter line under it. */
export function SkeletonRows({ rows = 5, avatar = false, label = 'Loading' }: { rows?: number; avatar?: boolean; label?: string }) {
  return (
    <div className="sk sk-rows" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: Math.max(1, rows) }, (_, i) => (
        <div className="sk-row" key={i} aria-hidden="true">
          {avatar ? <span className="sk-bar sk-av" /> : null}
          <span className="sk-lines">
            <span className="sk-bar sk-title" style={{ width: TITLE_WIDTHS[i % TITLE_WIDTHS.length] }} />
            <span className="sk-bar sk-sub" style={{ width: SUB_WIDTHS[i % SUB_WIDTHS.length] }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Messages of a channel or a thread: an avatar square, a name bar and one or two lines of text. */
export function SkeletonMessages({ count = 4, label = 'Loading messages' }: { count?: number; label?: string }) {
  return (
    <div className="sk sk-messages" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: Math.max(1, count) }, (_, i) => (
        <div className="sk-msg" key={i} aria-hidden="true">
          <span className="sk-bar sk-av" />
          <span className="sk-lines">
            <span className="sk-bar sk-name" />
            <span className="sk-bar sk-sub" style={{ width: SUB_WIDTHS[i % SUB_WIDTHS.length] }} />
            {i % 2 === 0 ? <span className="sk-bar sk-sub" style={{ width: TITLE_WIDTHS[(i + 2) % TITLE_WIDTHS.length] }} /> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
