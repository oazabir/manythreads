import type { ReactNode } from 'react';
import { Time } from './ui';

/*
 * The status strip (P21-18): the first thing on a page that is about something connected to the outside (a team's agents, its projects). One
 * line per thing: where it is, a dot AND a word for how it is doing (never the colour alone), and when that was last known. Everything else
 * on the page (how to set it up, the long explanations) sits below it, folded.
 *
 * Classes are prefixed `ss-` (styles/status-strip.css). The component draws no data of its own: a screen turns its rows into `StripItem`s.
 */

/** `ok` working, `warn` working but needs attention soon, `bad` not working, `idle` nothing to report yet. */
export type StripTone = 'ok' | 'warn' | 'bad' | 'idle';

export interface StripItem {
  id: string;
  /** Where or what: the connection or project name. Shown in the code font. */
  host: string;
  /** A second line under the host, e.g. an address. The screen passes it only to people who may see it. */
  detail?: string | null;
  tone: StripTone;
  /** The state in words: "Working", "Not working", "Token expires soon". */
  word: string;
  /** When the state was last known: the label ("last checked", "token saved") and the time. Omitted when there is none. */
  when?: { label: string; iso: string } | null;
}

export function StatusStrip({ label, items, empty, testId = 'status-strip' }: { label: string; items: ReadonlyArray<StripItem>; empty: ReactNode; testId?: string }) {
  return (
    <section className="ss" aria-label={label} data-testid={testId} data-landmark="status-strip">
      {items.length === 0 ? (
        <p className="ss-empty" data-testid="status-strip-empty">{empty}</p>
      ) : (
        <ul className="ss-list">
          {items.map((i) => (
            <li key={i.id} className="ss-item" data-testid="status-strip-item" data-tone={i.tone} data-item={i.host}>
              <span className="ss-dot" aria-hidden="true" />
              <span className="ss-host">
                <span className="mono ss-name">{i.host}</span>
                {i.detail ? <span className="mono ss-detail" data-testid="status-strip-detail" data-vt-mask>{i.detail}</span> : null}
              </span>
              <span className="ss-word" data-testid="status-strip-word">{i.word}</span>
              {i.when ? <span className="ss-when">{i.when.label} <Time iso={i.when.iso} /></span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
