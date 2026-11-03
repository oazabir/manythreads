import { beforeEach, describe, expect, it } from 'vitest';
import { TOOL_LIMITS, allowCall, resetCallLimits } from '../src/limits.ts';

// How fast a bot may draw, change and read its screens (PLAN P9-04): a sliding minute per bot and per tool, in memory.

const BOT = 'bot-a';
beforeEach(() => resetCallLimits());

describe('allowCall', () => {
  it('lets a bot call each tool up to its limit in a minute and then says no', () => {
    for (let i = 0; i < TOOL_LIMITS.render; i++) expect(allowCall(BOT, 'render', 1_000)).toBe(true);
    expect(allowCall(BOT, 'render', 1_000)).toBe(false);
    expect(allowCall(BOT, 'render', 30_000)).toBe(false);
  });
  it('counts per tool and per bot', () => {
    for (let i = 0; i < TOOL_LIMITS.render; i++) allowCall(BOT, 'render', 1_000);
    expect(allowCall(BOT, 'update', 1_000)).toBe(true);
    expect(allowCall('bot-b', 'render', 1_000)).toBe(true);
  });
  it('forgets a call after a minute', () => {
    for (let i = 0; i < TOOL_LIMITS.render; i++) allowCall(BOT, 'render', 1_000);
    expect(allowCall(BOT, 'render', 61_001)).toBe(true);
  });
  it('a refused call does not extend the wait', () => {
    for (let i = 0; i < TOOL_LIMITS.render; i++) allowCall(BOT, 'render', 1_000);
    for (let i = 0; i < 50; i++) allowCall(BOT, 'render', 50_000);
    expect(allowCall(BOT, 'render', 61_001)).toBe(true);
  });
  it('draws less often than it changes and reads', () => {
    expect(TOOL_LIMITS.render).toBeLessThan(TOOL_LIMITS.update);
    expect(TOOL_LIMITS.update).toBeLessThanOrEqual(TOOL_LIMITS.event);
  });
});
