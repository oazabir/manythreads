import { createContext, useContext, type ReactNode } from 'react';

/*
 * The small pieces the bot page's tabs are built from (PLAN P5-05). Every tab edits one section of the parsed frontmatter, so they all
 * need the same three shapes: a titled block, a labelled row, and a chip that is either granted or not. Keeping them here means the
 * tabs stay a description of the definition rather than a pile of inputs.
 */

/** The title of the section a block sits in, so a block that repeats it does not print the same words twice. */
const SectionTitle = createContext<string | null>(null);

/**
 * One section of a group (P21-17): the old tab's content under its own `h2`, anchored as `sec-<id>` so an old `?tab=<id>` link can scroll to it.
 * `pane-<id>` stays the test id the tab's pane always had.
 */
export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <SectionTitle.Provider value={title}>
      <section className="b-sec" id={`sec-${id}`} data-testid={`pane-${id}`} aria-labelledby={`sec-${id}-h`}>
        <h2 className="b-sec-h" id={`sec-${id}-h`}>{title}</h2>
        {children}
      </section>
    </SectionTitle.Provider>
  );
}

/** The band of a block: an `h3` when it carries the block's title, a plain `div` when only the count and action are left. */
function Band({ heading, className, children }: { heading: boolean; className: string; children: ReactNode }) {
  return heading ? <h3 className={className}>{children}</h3> : <div className={className}>{children}</div>;
}

export function Block({ title, count, action, children }: { title: string; count?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const sectionTitle = useContext(SectionTitle);
  // the block whose title is the section's own: the section's `h2` already says it, so only the count and the action stay in the band
  const same = sectionTitle === title;
  const hasBand = !same || count !== undefined || Boolean(action);
  return (
    <section className="b-block">
      {hasBand ? (
        <Band className={`bh ${same ? 'bh-same' : ''}`} heading={!same}>
          {same ? null : title}
          {count !== undefined ? <span className="cnt">{count}</span> : null}
          {action ? <span className="bh-act">{action}</span> : null}
        </Band>
      ) : null}
      <div className="b-block-body">{children}</div>
    </section>
  );
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="b-rowline">
      <div className="b-lab">
        {label}
        {hint ? <div className="d">{hint}</div> : null}
      </div>
      <div className="b-val">{children}</div>
    </div>
  );
}

/** A capability in the one allowlist: `on` when the definition grants it, `no` when it does not (the prototype's chips). */
export function Chip({ on, children }: { on: boolean; children: ReactNode }) {
  return <span className={`b-chip ${on ? 'on' : 'no'}`}>{children}</span>;
}

/** Nothing to show for a section the definition left out: say so in the section's own words, never a blank block. */
export function NotSet({ children }: { children: ReactNode }) {
  return <p className="b-notset">{children}</p>;
}

/** A read-only line of the definition, shown where the definition's own words are the answer. */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="mono">{children}</span>;
}