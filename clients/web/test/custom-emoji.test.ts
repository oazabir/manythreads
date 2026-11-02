import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomEmoji } from '@manythreads/shared';
import { nameFromFile, nameProblem, pictureProblem, splitCustomEmoji, toBase64 } from '../src/channels/customEmoji';
import { authorMark } from '../src/channels/authorMark';
import { broadcastAsk } from '../src/channels/broadcast';
import { chooseDraft, readDraft, readSynced, writeDraft, writeSynced } from '../src/channels/serverDraft';

const emoji = (name: string): CustomEmoji =>
  ({ id: `id-${name}`, name, contentType: 'image/png', size: 100, createdBy: null, createdAt: '2026-01-01T00:00:00.000Z' }) as unknown as CustomEmoji;
const known = new Map([emoji('party_parrot'), emoji('wave')].map((e) => [e.name, e]));

describe('splitCustomEmoji', () => {
  it('turns a known :name: into its emoji and keeps the text around it', () => {
    const out = splitCustomEmoji('ship it :party_parrot: now', known);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('ship it ');
    expect(out[1]).toMatchObject({ name: 'party_parrot' });
    expect(out[2]).toBe(' now');
  });

  it('draws two in a row, one at the start and one at the end', () => {
    const out = splitCustomEmoji(':wave: :wave:', known);
    expect(out.map((p) => (typeof p === 'string' ? p : p.name))).toEqual(['wave', ' ', 'wave']);
  });

  it('leaves unknown names, times and words that run into the colons as text', () => {
    for (const t of ['no :such: emoji', 'it is 10:30:15 now', 'a:wave:b', 'x:wave:', ':wave:x', ':Wave:', '::wave::', 'plain text']) {
      expect(splitCustomEmoji(t, known), t).toEqual([t]);
    }
  });

  it('does nothing when the workspace has none, and never loops on long input', () => {
    expect(splitCustomEmoji(':wave:', new Map())).toEqual([':wave:']);
    const long = ':'.repeat(50_000) + 'x'.repeat(50_000);
    const started = Date.now();
    expect(splitCustomEmoji(long, known)).toEqual([long]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('adding a custom emoji', () => {
  it('suggests a name from the file name', () => {
    expect(nameFromFile('Party Parrot.gif')).toBe('party_parrot');
    expect(nameFromFile('3d-glasses.png')).toBe('e_3d_glasses');
    expect(nameFromFile('ok.PNG')).toBe('ok');
    expect(nameFromFile('...png')).toBe('');
    expect(nameFromFile(`${'a'.repeat(50)}.png`)).toHaveLength(32);
  });

  it('explains a name or picture that will not do', () => {
    expect(nameProblem('')).toMatch(/name/);
    expect(nameProblem('Wave')).toMatch(/lower-case/);
    expect(nameProblem('wave')).toBeNull();
    expect(pictureProblem({ type: 'image/svg+xml', size: 10 })).toMatch(/PNG, JPEG, GIF or WebP/);
    expect(pictureProblem({ type: 'image/png', size: 300 * 1024 })).toMatch(/256 KB/);
    expect(pictureProblem({ type: 'image/png', size: 1000 })).toBeNull();
  });

  it('writes bytes as base64', () => {
    expect(toBase64(Uint8Array.from([104, 105]))).toBe('aGk=');
    expect(toBase64(new Uint8Array(100_000)).length).toBeGreaterThan(130_000);
  });
});

describe('the mark beside an author (follow-up to P14-04)', () => {
  it('a webhook is a Webhook, the reminder sender is System, people and bots have none', () => {
    expect(authorMark({ kind: 'system', sender: 'webhook' })).toMatchObject({ label: 'Webhook' });
    expect(authorMark({ kind: 'system', sender: 'reminders' })).toMatchObject({ label: 'System' });
    // the server's marker decides, never the name: a webhook that its admin called "Reminders" is still a webhook
    expect(authorMark({ kind: 'system', sender: 'webhook', displayName: 'Reminders' } as never)).toMatchObject({ label: 'Webhook' });
    // a system author with no marker (an imported person's placeholder) gets no badge: nothing guesses it is a webhook
    expect(authorMark({ kind: 'system' })).toBeNull();
    expect(authorMark({ kind: 'system', sender: null })).toBeNull();
    expect(authorMark({ kind: 'person', sender: null })).toBeNull();
    expect(authorMark({ kind: 'bot' })).toBeNull();
    expect(authorMark(null)).toBeNull();
    expect(authorMark(undefined)).toBeNull();
  });
});

describe('@channel and @here need a yes in a big room', () => {
  const reach = { channel: 52, here: 8, confirmAbove: 20 };
  it('asks for @channel above the limit, with the number in plain words', () => {
    const ask = broadcastAsk('Heads up @channel', reach);
    expect(ask).toMatchObject({ words: ['channel'], people: 52 });
    expect(ask?.text).toBe('@channel will notify 52 people. Send it anyway?');
  });
  it('does not ask for @here while few are online, or at exactly the limit', () => {
    expect(broadcastAsk('@here a look?', reach)).toBeNull();
    expect(broadcastAsk('@channel', { channel: 20, here: 20, confirmAbove: 20 })).toBeNull();
    expect(broadcastAsk('@channel', { channel: 21, here: 0, confirmAbove: 20 })).not.toBeNull();
  });
  it('a message with both words counts the larger set; one with neither never asks', () => {
    expect(broadcastAsk('@here and @channel', reach)?.people).toBe(52);
    expect(broadcastAsk('hello @rafi', reach)).toBeNull();
    expect(broadcastAsk('code `@channel`', reach)).toBeNull();
  });
});

describe('which draft a box starts with', () => {
  const server = { body: 'from the server', updatedAt: '2026-05-01T10:00:00.000Z' };
  it('keeps a local text the server has never seen (never synced), and nothing for an empty box', () => {
    expect(chooseDraft('mine', null, null)).toEqual({ text: 'mine', from: 'local' });
    expect(chooseDraft('', null, null)).toEqual({ text: '', from: 'local' });
  });
  it('an empty box takes the server text', () => {
    expect(chooseDraft('', null, server)).toEqual({ text: 'from the server', from: 'server' });
  });
  it('the same text is the same, whoever has it', () => {
    expect(chooseDraft('from the server', null, server).from).toBe('local');
  });
  it('text typed here after the last sync wins while the server copy is the one this device knew', () => {
    expect(chooseDraft('typed here', { text: 'from the server', version: server.updatedAt }, server)).toEqual({ text: 'typed here', from: 'local' });
  });
  it('another device saved since: its copy wins over the one this device synced, whatever the clocks say', () => {
    const old = { text: 'mine', version: '2026-05-01T08:00:00.000Z' };
    expect(chooseDraft('mine', old, server)).toEqual({ text: 'from the server', from: 'server' });
    // nothing here reads the time on this device, so a skewed clock changes nothing
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2099-01-01T00:00:00Z'));
    expect(chooseDraft('mine', old, server)).toEqual({ text: 'from the server', from: 'server' });
    spy.mockRestore();
  });
  it('a local copy this device never synced loses to the server copy', () => {
    expect(chooseDraft('old local', null, server)).toEqual({ text: 'from the server', from: 'server' });
  });
  it('a text that was synced and is gone from the server (sent or cleared elsewhere) is dropped, not pushed back', () => {
    expect(chooseDraft('hello', { text: 'hello', version: server.updatedAt }, null)).toEqual({ text: '', from: 'cleared' });
  });
  it('but text typed here since the sync is kept when the server has none', () => {
    expect(chooseDraft('hello again', { text: 'hello', version: server.updatedAt }, null)).toEqual({ text: 'hello again', from: 'local' });
  });
});

describe('the local copy and what this device knows of the server', () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, v),
        removeItem: (k: string) => void mem.delete(k),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('writing the local copy again never changes what was synced (opening and leaving a box cannot make a copy look newer)', () => {
    writeSynced('channel:1', { text: 'a', version: 'v1' });
    writeDraft('channel:1', 'a');
    writeDraft('channel:1', 'a');
    expect(readDraft('channel:1')).toBe('a');
    expect(readSynced('channel:1')).toEqual({ text: 'a', version: 'v1' });
  });
  it('emptying the box (a send does) forgets the synced version too', () => {
    writeSynced('channel:1', { text: 'a', version: 'v1' });
    writeDraft('channel:1', 'a');
    writeDraft('channel:1', '');
    expect(readDraft('channel:1')).toBe('');
    expect(readSynced('channel:1')).toBeNull();
  });
  it('a garbled synced marker reads as nothing', () => {
    mem.set('manythreads.draft-sync:channel:1', '{oops');
    expect(readSynced('channel:1')).toBeNull();
  });
});
