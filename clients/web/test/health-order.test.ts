import { describe, expect, it } from 'vitest';
import type { OpsHealthCheck } from '@manythreads/shared';
import { checkStatus, healthSummary, sortChecks } from '../src/screens/health/format';

const check = (name: string, over: Partial<OpsHealthCheck> = {}): OpsHealthCheck => ({
  name,
  label: name,
  unit: 'seconds',
  value: 5,
  threshold: 60,
  breached: false,
  since: null,
  ...over,
});

const fine = check('fine');
const over = check('over', { value: 90, breached: true });
const down = check('down', { value: null });
const off = check('off', { threshold: 0 });

describe('System health order and verdict', () => {
  it('gives a status of Fine, Over limit, Down or Off', () => {
    expect(checkStatus(fine)).toEqual({ tone: 'ok', word: 'Fine' });
    expect(checkStatus(over)).toEqual({ tone: 'warn', word: 'Over limit' });
    expect(checkStatus(down)).toEqual({ tone: 'down', word: 'Down' });
    expect(checkStatus(off)).toEqual({ tone: 'off', word: 'Off' });
  });

  it('puts problems first, the worst of them on top, and keeps the server order inside a group', () => {
    const list = [fine, check('fine2'), off, over, check('over2', { value: 70, breached: true }), down];
    expect(sortChecks(list).map((c) => c.name)).toEqual(['down', 'over', 'over2', 'fine', 'fine2', 'off']);
  });

  it('does not change the list it was given', () => {
    const list = [fine, over];
    sortChecks(list);
    expect(list.map((c) => c.name)).toEqual(['fine', 'over']);
  });

  it('sums up the page in one line', () => {
    expect(healthSummary([fine, off]).text).toBe('All fine');
    expect(healthSummary([fine, over]).text).toBe('1 problem');
    expect(healthSummary([over, down, fine])).toEqual({ problems: 2, text: '2 problems' });
  });
});
