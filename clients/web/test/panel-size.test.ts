import { describe, expect, it } from 'vitest';
import { NARROW_QUERY } from '../src/shell/useNarrow';
import { CENTER_MIN, PANEL_MIN, PHONE_MAX, RAIL_WIDTH, SIDE_BY_SIDE_MIN, clampPanelWidth, threadLayout } from '../src/kernel/panel/panelSize';

/** What useNarrow answers for a width: the phone query is `(width <= PHONE_MAX px)`. */
const narrowAt = (viewport: number): boolean => viewport <= PHONE_MAX;
const layout = (viewport: number, isThread = true, expanded = false) => threadLayout({ viewport, narrow: narrowAt(viewport), isThread, expanded });

describe('where an open thread is drawn follows the window (P21-27)', () => {
  it('is a sheet on a phone and at 760 px', () => {
    expect(layout(390)).toBe('sheet');
    expect(layout(760)).toBe('sheet');
  });

  it('fills the area from 761 px up to the point it fits beside the channel', () => {
    expect(layout(761)).toBe('fill');
    expect(layout(850)).toBe('fill');
    expect(layout(887)).toBe('fill');
  });

  it('sits at the side from 888 px', () => {
    expect(layout(888)).toBe('side');
    expect(layout(1440)).toBe('side');
  });

  it('fills when the person expanded it, and a sheet stays a sheet', () => {
    expect(layout(1440, true, true)).toBe('fill');
    expect(layout(390, true, true)).toBe('sheet');
  });

  it('keeps any other panel at the side however narrow the window is (above the phone)', () => {
    expect(layout(800, false)).toBe('side');
    expect(layout(1440, false, true)).toBe('side');
  });

  it('follows the width both ways, without remembering', () => {
    expect([1440, 850, 1440, 700, 1440].map((v) => layout(v))).toEqual(['side', 'fill', 'side', 'sheet', 'side']);
  });
});

describe('the sizes behind it', () => {
  it('side by side needs the rail, the least the channel keeps and the least a panel gets', () => {
    expect(SIDE_BY_SIDE_MIN).toBe(RAIL_WIDTH + CENTER_MIN + PANEL_MIN);
    expect(SIDE_BY_SIDE_MIN).toBe(888);
  });

  it('the phone query is built from PHONE_MAX', () => {
    expect(PHONE_MAX).toBe(760);
    expect(NARROW_QUERY).toContain(String(PHONE_MAX));
    expect(NARROW_QUERY).toBe('(width <= 760px)');
  });

  it('a panel is never narrower than its minimum, and fits at the first width it sits at the side', () => {
    expect(clampPanelWidth(10_000, SIDE_BY_SIDE_MIN)).toBeGreaterThanOrEqual(PANEL_MIN);
    expect(clampPanelWidth(10_000, SIDE_BY_SIDE_MIN)).toBe(SIDE_BY_SIDE_MIN - RAIL_WIDTH - CENTER_MIN);
    expect(clampPanelWidth(10_000, SIDE_BY_SIDE_MIN) + RAIL_WIDTH + CENTER_MIN).toBeLessThanOrEqual(SIDE_BY_SIDE_MIN);
    expect(clampPanelWidth(1, 1440)).toBe(PANEL_MIN);
  });
});
