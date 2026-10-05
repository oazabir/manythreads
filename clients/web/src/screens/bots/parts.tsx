import type { ReactNode } from 'react';

/*
 * The small pieces the bot page's tabs are built from (PLAN P5-05). Every tab edits one section of the parsed frontmatter, so they all
 * need the same three shapes: a titled block, a labelled row, and a chip that is either granted or not. Keeping them here means the
 * tabs stay a description of the definition rather than a pile of inputs.
 */

export function Block({ title, count, action, children }: { title: string; count?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="b-block">
      <h3 className="bh">
        {title}
        {count !== undefined ? <span className="cnt">{count}</span> : null}
        {action ? <span className="act">{action}</span> : null}
      </h3>
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