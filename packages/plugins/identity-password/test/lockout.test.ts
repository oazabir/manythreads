import { describe, expect, it } from 'vitest';
import { createLockout } from '../src/lockout.ts';

const clock = () => {
  const c = { t: 0, now: () => new Date(c.t), advance: (ms: number) => void (c.t += ms) };
  return c;
};

describe('lockout', () => {
  it('locks on the 5th failure for 15 minutes', () => {
    const c = clock();
    const l = createLockout({ now: c.now });
    for (let i = 0; i < 4; i++) expect(l.fail('k').locked).toBe(false);
    expect(l.check('k').locked).toBe(false);
    expect(l.fail('k').locked).toBe(true);
    expect(l.check('k')).toEqual({ locked: true, retryAfterMs: 15 * 60_000 });
    c.advance(15 * 60_000 - 1);
    expect(l.check('k').locked).toBe(true);
    c.advance(1);
    expect(l.check('k').locked).toBe(false);
  });

  it('failures older than the window do not count, and a success clears the key', () => {
    const c = clock();
    const l = createLockout({ now: c.now });
    for (let i = 0; i < 4; i++) l.fail('k');
    c.advance(16 * 60_000);
    expect(l.fail('k').locked).toBe(false);
    for (let i = 0; i < 3; i++) l.fail('j');
    l.reset('j');
    for (let i = 0; i < 4; i++) expect(l.fail('j').locked).toBe(false);
  });

  it('keys are independent and memory is bounded', () => {
    const c = clock();
    const l = createLockout({ now: c.now, maxKeys: 10 });
    for (let i = 0; i < 100; i++) l.fail(`k${i}`);
    expect(l.check('k99').locked).toBe(false);
    for (let i = 0; i < 5; i++) l.fail('victim');
    expect(l.check('victim').locked).toBe(true);
    expect(l.check('other').locked).toBe(false);
  });

  it('counts attempts that are still being verified, so a parallel burst cannot outrun the limit', () => {
    const c = clock();
    const l = createLockout({ now: c.now });
    const started = Array.from({ length: 10 }, () => l.begin('k').locked);
    expect(started.filter((locked) => !locked)).toHaveLength(5);
    expect(started.filter((locked) => locked)).toHaveLength(5);
    for (let i = 0; i < 5; i++) l.end('k');
    // Nothing was recorded as a failure, so once the attempts are over the key is free again.
    expect(l.begin('k').locked).toBe(false);
    l.end('k');
    // A success (reset) after an in-flight attempt leaves nothing behind.
    l.reset('k');
    expect(l.check('k').locked).toBe(false);
  });
});
