import { describe, expect, it, vi } from 'vitest';
// the byte-stream uploads switch to a JSON stand-in in mock mode (as the screens do offline)
vi.mock('../src/api/setup', async (original) => ({ ...(await original<typeof import('../src/api/setup')>()), isMockMode: () => true }));

import { ApiError, setTransport } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { consentFailureWords, isCannotAsk } from '../src/screens/account/BotConsents';
import { fetchBotConsents, setBotConsent } from '../src/screens/account/botConsentsApi';
import { savePersonalFile } from '../src/screens/memory/personalApi';
import { MEMORY_FULL_SENTENCE, isChangedSince, isMemoryFull, saveFailureWords } from '../src/screens/memory/personalWords';

/*
 * The two refusals P20-05 and P20-09 added: a Personal Memory already holding 2,000 files (409 `personal_memory_full`, which is NOT "changed since you opened it") and a
 * yes for a bot that never asks to read Personal files (422 `bot_cannot_ask_personal`). The words are checked on the errors the client really raises, from the mock.
 */

const as = (who: string) => setTransport(createMockTransport({ latencyMs: 0, as: who }));
const api = (status: number, code: ApiError['code'], message: string) => new ApiError({ status, code, message });

describe('a full Personal Memory (409 personal_memory_full)', () => {
  const SERVER = 'Your Memory already holds the most files it can (2,000). Delete a file you no longer need, then save again.';
  const full = api(409, 'personal_memory_full', SERVER);
  const moved = api(409, 'conflict', '“facts/lunch.md” changed since you opened it (it is at version 3). Open it again and redo your edit.');

  it('says the plain sentence, whatever words the server sent', () => {
    expect(MEMORY_FULL_SENTENCE).toBe(SERVER);
    expect(saveFailureWords(full, 'fallback')).toBe(MEMORY_FULL_SENTENCE);
    expect(saveFailureWords(api(409, 'personal_memory_full', 'something else'), 'fallback')).toBe(MEMORY_FULL_SENTENCE);
  });

  it('is checked before the generic 409: no "open the latest version" for a full Memory, still one for a moved file', () => {
    expect(isMemoryFull(full)).toBe(true);
    expect(isChangedSince(full)).toBe(false);
    expect(isMemoryFull(moved)).toBe(false);
    expect(isChangedSince(moved)).toBe(true);
    expect(saveFailureWords(moved, 'fallback')).toMatch(/changed since you opened it/);
    expect(isChangedSince({ status: 409 })).toBe(true);
    expect(isChangedSince({ status: 500 })).toBe(false);
    expect(isChangedSince(null)).toBe(false);
  });

  it('falls back to the screen’s own sentence for any other failure', () => {
    expect(saveFailureWords(new Error(''), 'The file could not be saved. Try again.')).toBe('The file could not be saved. Try again.');
    expect(saveFailureWords('nope', 'The file could not be saved. Try again.')).toBe('The file could not be saved. Try again.');
  });

  it('reaches the screen from the mock as the server sends it: the 2,001st file is refused, a save over an existing file is not', async () => {
    as('nadia');
    const front = (n: number): string => `---\ntype: Fact\ntitle: F${String(n)}\n---\n\nbody ${String(n)}\n`;
    let last: Awaited<ReturnType<typeof savePersonalFile>> | null = null;
    // the seeded files count toward the cap, so write until it answers
    let err: unknown = null;
    for (let n = 0; n < 2100 && err === null; n++) {
      try {
        last = await savePersonalFile({ path: `cap/f${String(n)}.md`, content: front(n) });
      } catch (e) {
        err = e;
      }
    }
    expect(err).toMatchObject({ status: 409, code: 'personal_memory_full' });
    expect(isMemoryFull(err)).toBe(true);
    expect(isChangedSince(err)).toBe(false);
    expect(saveFailureWords(err, 'x')).toBe(MEMORY_FULL_SENTENCE);
    // a file that already exists is saved again with its version (no new file, so no cap)
    expect(last).not.toBeNull();
    const again = await savePersonalFile({ path: last!.file.path, content: front(0).replace('F0', 'Again'), baseVersion: last!.file.versionNo });
    expect(again.file.versionNo).toBe(last!.file.versionNo + 1);
    // another person's space is their own
    as('rafi');
    await expect(savePersonalFile({ path: 'cap/rafi.md', content: front(1) })).resolves.toBeDefined();
  });
});

describe('a yes for a bot that cannot ask (422 bot_cannot_ask_personal)', () => {
  const SERVER = 'This bot does not ask to read your Personal files, so there is nothing to allow.';

  it('shows the server’s sentence, and a plain one if the server sent none', () => {
    const e = api(422, 'bot_cannot_ask_personal', SERVER);
    expect(isCannotAsk(e)).toBe(true);
    expect(consentFailureWords(e)).toBe(SERVER);
    expect(consentFailureWords(api(422, 'bot_cannot_ask_personal', ''))).toBe(SERVER);
    expect(isCannotAsk(api(422, 'validation_failed', 'x'))).toBe(false);
    expect(isCannotAsk(null)).toBe(false);
  });

  it('keeps the "your choice is unchanged" sentence for any other failure', () => {
    expect(consentFailureWords(api(500, 'internal', 'Boom'))).toBe('Boom');
    expect(consentFailureWords(new Error(''))).toBe('That could not be saved. Your choice is unchanged.');
  });

  it('is refused by the mock as the server does, and a no is still accepted', async () => {
    as('nadia');
    const list = (await fetchBotConsents()).items;
    const cannot = list.find((c) => !c.canAsk);
    if (!cannot) throw new Error('the mock lists a bot that cannot ask');
    const err = await setBotConsent(cannot.botId, true).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'bot_cannot_ask_personal' });
    expect(consentFailureWords(err)).toBe(SERVER);
    expect((await fetchBotConsents()).items.find((c) => c.botId === cannot.botId)).toMatchObject({ allowed: false, isDefault: true });
    await expect(setBotConsent(cannot.botId, false)).resolves.toMatchObject({ item: { allowed: false } });
  });
});
