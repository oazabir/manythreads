import { useState, type KeyboardEvent } from 'react';
import type { UsageDay } from '@manythreads/shared';
import { barHeight, barLabel, chartSummary, dayMonth, failedShare, fillDays } from './format';

/**
 * A bar chart in plain HTML and CSS: one column per day of the range (a day with nothing is a 0, never a gap in the axis), tallest day = full
 * height, a baseline and two light grid lines. The failed part of a bar is drawn at its foot. Every column can be focused (arrow keys move
 * between them, Tab leaves the chart) and shows its day and number as a tooltip on hover and on focus; a screen reader reads the same text.
 * A chart with nothing in it is a dotted line saying "No data yet".
 */
export function DayChart({ title, id, days, rangeDays, pick, failed, unit, barUnit, format }: {
  title: string;
  id: string;
  days: readonly UsageDay[];
  /** How many days the picked range has; the axis always has that many columns. */
  rangeDays?: number;
  pick: (d: UsageDay) => number;
  failed?: (d: UsageDay) => number;
  unit: string;
  /** The word after the number in a bar's label ("18 runs"); empty when the number says it itself ("$3.20"). */
  barUnit: string;
  format: (n: number) => string;
}) {
  const all = fillDays(days, rangeDays ?? days.length);
  const max = all.reduce((m, d) => Math.max(m, pick(d)), 0);
  const first = all[0];
  const last = all[all.length - 1];
  const [active, setActive] = useState(all.length - 1);

  const move = (e: KeyboardEvent<HTMLElement>, i: number) => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null;
    if (to === null || to < 0 || to >= all.length) return;
    e.preventDefault();
    setActive(to);
    (e.currentTarget.parentElement?.children[to] as HTMLElement | undefined)?.focus();
  };

  return (
    <section className="box" aria-labelledby={id} data-testid={`usage-chart-${id}`}>
      <h2 className="box-h" id={id}>{title}</h2>
      <p className="sr-only">{chartSummary(all, pick, unit)}</p>
      {max > 0 ? (
        <div className="usage-plot">
          <div className="usage-y d" aria-hidden="true"><span>{format(max)}</span><span>0</span></div>
          <div className="usage-field">
            <div className="usage-grid" aria-hidden="true"><i /><i /></div>
            <div className="usage-bars" role="group" aria-label={`${title}, one bar for each day`}>
              {all.map((d, i) => {
                const v = pick(d);
                const f = failed ? failed(d) : 0;
                const text = barLabel(d.day, format(v), barUnit, f);
                return (
                  <div
                    className="usage-col"
                    key={d.day}
                    role="img"
                    aria-label={text}
                    tabIndex={i === active ? 0 : -1}
                    data-edge={i < all.length / 6 ? 'start' : i >= all.length - all.length / 6 ? 'end' : undefined}
                    onFocus={() => setActive(i)}
                    onKeyDown={(e) => move(e, i)}
                  >
                    <div className="usage-bar" style={{ height: `${barHeight(v, max)}%` }}>
                      {f > 0 ? <div className="usage-bar-bad" style={{ height: `${failedShare(f, v)}%` }} /> : null}
                    </div>
                    <span className="usage-tip" aria-hidden="true">{text}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="usage-empty" role="img" aria-label={`No ${unit} yet`}>
          <span className="d">No data yet</span>
          <span className="usage-empty-line" aria-hidden="true" />
        </div>
      )}
      {first && last ? (
        <div className="usage-axis d" aria-hidden="true">
          <span>{dayMonth(first.day)}</span>
          {max > 0 ? <span>busiest day: {format(max)}</span> : null}
          <span>{dayMonth(last.day)}</span>
        </div>
      ) : null}
    </section>
  );
}
