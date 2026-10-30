import { describe, expect, it } from 'vitest';
import { HttpError, createLockout, guardRedemption, lockedError } from '@manythreads/sdk';

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

describe('a lock does not extend while it holds, and refusals count behind guardRedemption', () => {
  it('attempts made while locked neither count nor move the end of the lock', () => {
    const c = clock();
    const l = createLockout({ now: c.now, max: 2, lockMs: 10 * 60_000 });
    l.fail('k');
    expect(l.fail('k').locked).toBe(true);
    c.advance(6 * 60_000);
    for (let i = 0; i < 20; i++) expect(l.begin('k').locked).toBe(true);
    c.advance(4 * 60_000);
    expect(l.check('k').locked).toBe(false); // ten minutes after the lock began, whatever came in between
  });

  it('lockedError is a 429 rate_limited with a whole-second retry-after and a plain message', () => {
    const err = lockedError({ locked: true, retryAfterMs: 90_500 }, 'attempts with a link');
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(err.headers['retry-after']).toBe('91');
    expect(err.message).toBe('Too many failed attempts with a link. Try again in 2 minutes.');
  });

  it('guardRedemption counts a thrown 404 or 410 (or a result the caller names), not other errors, and refuses at once when locked', async () => {
    const c = clock();
    const l = createLockout({ now: c.now, max: 3 });
    const gone = (): Promise<never> => Promise.reject(new HttpError(410, 'gone', 'gone'));
    for (let i = 0; i < 3; i++) await expect(guardRedemption(l, 'k', 'attempts', gone)).rejects.toMatchObject({ status: 410 });
    let ran = false;
    await expect(
      guardRedemption(l, 'k', 'attempts', () => {
        ran = true;
        return Promise.resolve('ok');
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(ran).toBe(false);

    const other = createLockout({ now: c.now, max: 2 });
    for (let i = 0; i < 5; i++) await expect(guardRedemption(other, 'k', 'a', () => Promise.reject(new HttpError(400, 'validation_failed', 'bad')))).rejects.toMatchObject({ status: 400 });
    expect(other.check('k').locked).toBe(false);
    const byResult = createLockout({ now: c.now, max: 2 });
    const refuse = ({ result }: { result?: { status: number } }): boolean => result?.status === 410;
    await guardRedemption(byResult, 'k', 'a', () => Promise.resolve({ status: 410 }), refuse);
    await guardRedemption(byResult, 'k', 'a', () => Promise.resolve({ status: 410 }), refuse);
    expect(byResult.check('k').locked).toBe(true);
  });
});
