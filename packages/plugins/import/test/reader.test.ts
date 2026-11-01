import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { IMPORT_MESSAGE_MAX_CHARS } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveError, looksLikeArchive, openArchive } from '../src/archive.ts';
import { DEFAULT_LIMITS, type ArchiveLimits } from '../src/limits.ts';
import type { ArchiveMessage, ArchiveReader } from '../src/model.ts';
import { convertSlackText } from '../src/slack.ts';
import { NotTextError, cleanEmail, cleanMessageText, decodeText, jsonDepth, splitJsonArray, splitLines } from '../src/text.ts';
import { MATTERMOST_EXPECTED, SLACK_EXPECTED, mattermostExport, slackEntries, slackExport } from './fixtures.ts';
import { buildZip } from './zip-builder.ts';

// The two readers against the committed fixtures and against archives built to hurt them. No database: the readers only turn bytes into messages.

let dir = '';
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'import-reader-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (bytes: Uint8Array | string): Promise<string> => {
  const path = join(dir, `f${(n += 1)}`);
  await writeFile(path, bytes);
  return path;
};
const all = async (r: ArchiveReader): Promise<ArchiveMessage[]> => {
  const out: ArchiveMessage[] = [];
  for await (const m of r.messages()) out.push(m);
  return out;
};
const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
const limits = (over: Partial<ArchiveLimits> = {}): ArchiveLimits => ({ ...DEFAULT_LIMITS, ...over });

describe('the committed fixtures', () => {
  it('are what the generator writes (run generate-fixtures.ts after changing fixtures.ts)', () => {
    expect(fixture('slack-export.zip').equals(slackExport())).toBe(true);
    expect(fixture('mattermost-export.jsonl').toString('utf8')).toBe(mattermostExport());
  });

  it('have 3 channels and 200 messages in the Slack workspace channels, with threads, reactions and a file', () => {
    const entries = slackEntries();
    const days = entries.filter((e) => /^(general|eng-random|leadership)\/.+\.json$/.test(e.name));
    let messages = 0;
    let threads = 0;
    let reactions = 0;
    let files = 0;
    for (const day of days) {
      for (const m of JSON.parse(String(day.data)) as Record<string, unknown>[]) {
        messages += 1;
        if (m['thread_ts'] && m['thread_ts'] !== m['ts']) threads += 1;
        if (m['reactions']) reactions += 1;
        if (m['files']) files += 1;
      }
    }
    expect(messages).toBe(200);
    expect(threads).toBeGreaterThan(5);
    expect(reactions).toBeGreaterThanOrEqual(2);
    expect(files).toBeGreaterThan(0);
  });
});

describe('the Slack reader', () => {
  it('reads people, channels and messages of the fixture', async () => {
    const r = await openArchive(await write(slackExport()), 'slack');
    try {
      const people = await r.people();
      const humans = people.filter((p) => !p.isBot);
      expect(people).toHaveLength(SLACK_EXPECTED.people + 1);
      expect(humans).toHaveLength(SLACK_EXPECTED.people);
      expect(humans.filter((p) => p.email !== null).length).toBe(SLACK_EXPECTED.people - SLACK_EXPECTED.withoutEmail);
      const channels = await r.channels();
      expect(channels).toHaveLength(SLACK_EXPECTED.channels);
      expect(channels.filter((c) => c.kind === 'private').map((c) => c.name)).toEqual(['leadership']);
      expect(channels.filter((c) => c.kind === 'direct')).toHaveLength(2);
      const messages = await all(r);
      expect(messages).toHaveLength(SLACK_EXPECTED.messages);
      expect(messages.filter((m) => m.skip === 'app_message')).toHaveLength(SLACK_EXPECTED.appMessages);
      expect(messages.filter((m) => m.skip === 'system_message')).toHaveLength(SLACK_EXPECTED.systemMessages);
      expect(messages.filter((m) => m.skip === 'huddle')).toHaveLength(SLACK_EXPECTED.huddles);
      expect(r.notes.get('canvas')).toBe(SLACK_EXPECTED.canvases);
      expect(messages.filter((m) => m.skip === null && m.files.length > 0).length).toBeGreaterThan(0);
      // Every kept message has a time in the past and a key that is unique.
      expect(new Set(messages.map((m) => `${m.channelKey}:${m.key}`)).size).toBe(messages.length);
      expect(messages.every((m) => m.at <= Date.now() && m.at > 0)).toBe(true);
      // Replies point at a root in the same channel; the one orphan reply points at a message the export does not hold.
      const keys = new Set(messages.map((m) => `${m.channelKey}:${m.rootKey === null ? m.key : m.rootKey}`));
      const known = new Set(messages.map((m) => `${m.channelKey}:${m.key}`));
      const orphans = messages.filter((m) => m.rootKey !== null && !known.has(`${m.channelKey}:${m.rootKey}`));
      expect(keys.size).toBeGreaterThan(0);
      expect(orphans).toHaveLength(SLACK_EXPECTED.orphanReplies);
    } finally {
      await r.close();
    }
  });

  it('is the same on a second read (keys are stable, so a second run can recognise its own work)', async () => {
    const path = await write(slackExport());
    const a = await openArchive(path, 'slack');
    const b = await openArchive(path, 'slack');
    try {
      expect((await all(a)).map((m) => m.key)).toEqual((await all(b)).map((m) => m.key));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('turns Slack markup into plain text and links, and never into a mention', () => {
    const names = new Map([['U1', 'Omar']]);
    const channels = new Map([['C1', 'general']]);
    const { text, mentions } = convertSlackText(
      'hi <@U1> see <#C1|general> and <https://example.com/a?b=1|the page> <mailto:a@b.example|mail> <javascript:alert(1)|click> <!here> :+1:',
      (k) => names.get(k) ?? null,
      (k) => channels.get(k) ?? null,
    );
    expect(mentions).toBeGreaterThanOrEqual(1);
    expect(text).toContain('@omar');
    expect(text).toContain('[the page](https://example.com/a?b=1)');
    expect(text).not.toContain('javascript:');
    expect(text).not.toContain('<@');
  });

  it('refuses a file that is not a zip, and an export of nothing', async () => {
    await expect(openArchive(await write('plain text, not a zip'), 'slack')).rejects.toBeInstanceOf(ArchiveError);
    const empty = await openArchive(await write(buildZip([{ name: 'readme.txt', data: 'hello' }])), 'slack');
    expect(await empty.channels()).toEqual([]);
    expect(await all(empty)).toEqual([]);
    await empty.close();
  });

  it('counts a malformed day file and a refused entry, and reads the rest', async () => {
    const path = await write(
      buildZip([
        { name: 'users.json', data: JSON.stringify([{ id: 'U1', name: 'a', profile: { email: 'a@kahf.example', real_name: 'A' } }]) },
        { name: 'channels.json', data: JSON.stringify([{ id: 'C1', name: 'general', members: ['U1'] }]) },
        { name: 'general/2024-03-04.json', data: '[{"ts":"1709546400.000100","user":"U1","text":"fine"}, {broken json}, {"ts":"1709546460.000100","user":"U1","text":"also fine"}]' },
        { name: 'general/2024-03-05.json', data: Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x00]) },
        { name: '../escape.json', data: '[]' },
      ]),
    );
    const r = await openArchive(path, 'slack');
    const messages = await all(r);
    expect(messages.filter((m) => m.skip === null)).toHaveLength(2);
    expect(r.notes.get('malformed_entry') ?? 0).toBeGreaterThanOrEqual(1);
    expect(r.notes.get('refused_entry') ?? 0).toBeGreaterThanOrEqual(1);
    await r.close();
  });

  it('shortens a 1 MB message to the platform limit and keeps the 40,000-character one', async () => {
    const day = JSON.stringify([
      { ts: '1709546400.000100', user: 'U1', text: randomBytes(512 * 1024).toString('hex') },
      { ts: '1709546460.000100', user: 'U1', text: 'y'.repeat(40_000) },
    ]);
    const path = await write(
      buildZip([
        { name: 'users.json', data: JSON.stringify([{ id: 'U1', name: 'a', profile: { email: 'a@kahf.example' } }]) },
        { name: 'channels.json', data: JSON.stringify([{ id: 'C1', name: 'general' }]) },
        { name: 'general/2024-03-04.json', data: day },
      ]),
    );
    const r = await openArchive(path, 'slack');
    const messages = (await all(r)).filter((m) => m.skip === null);
    expect(messages).toHaveLength(2);
    for (const m of messages) expect(m.text.length).toBeLessThanOrEqual(IMPORT_MESSAGE_MAX_CHARS);
    expect(messages[0]!.shortened).toBe(true);
    await r.close();
  });

  it('drops a message nested 5,000 deep without recursing and reads the one beside it', async () => {
    const deep = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    const day = `[{"ts":"1709546400.000100","user":"U1","text":"ok"},{"ts":"1709546460.000100","user":"U1","text":"x","blocks":${deep}}]`;
    const path = await write(
      buildZip([
        { name: 'users.json', data: JSON.stringify([{ id: 'U1', name: 'a' }]) },
        { name: 'channels.json', data: JSON.stringify([{ id: 'C1', name: 'general' }]) },
        { name: 'general/2024-03-04.json', data: day },
      ]),
    );
    const r = await openArchive(path, 'slack');
    const messages = (await all(r)).filter((m) => m.skip === null);
    expect(messages.map((m) => m.text)).toEqual(['ok']);
    expect(r.notes.get('malformed_entry')).toBe(1);
    await r.close();
  });

  it('puts a message dated in the future back to now and refuses a message with no time', async () => {
    const day = JSON.stringify([
      { ts: '99999999999.000100', user: 'U1', text: 'future' },
      { user: 'U1', text: 'no time' },
    ]);
    const path = await write(
      buildZip([
        { name: 'users.json', data: JSON.stringify([{ id: 'U1', name: 'a' }]) },
        { name: 'channels.json', data: JSON.stringify([{ id: 'C1', name: 'general' }]) },
        { name: 'general/2024-03-04.json', data: day },
      ]),
    );
    const r = await openArchive(path, 'slack', DEFAULT_LIMITS, () => Date.UTC(2025, 0, 1));
    const messages = await all(r);
    expect(messages.every((m) => m.at <= Date.UTC(2025, 0, 1))).toBe(true);
    await r.close();
  });
});

describe('the Mattermost reader', () => {
  it('reads people, channels and posts (with their replies and reactions) of the fixture', async () => {
    const r = await openArchive(await write(mattermostExport()), 'mattermost');
    try {
      const people = await r.people();
      expect(people).toHaveLength(MATTERMOST_EXPECTED.people);
      expect(await r.channels()).toHaveLength(MATTERMOST_EXPECTED.channels);
      const messages = await all(r);
      expect(messages).toHaveLength(MATTERMOST_EXPECTED.messages);
      expect(messages.some((m) => m.rootKey !== null)).toBe(true);
      expect(messages.some((m) => m.reactions.length > 0)).toBe(true);
      expect(new Set(messages.map((m) => m.key)).size).toBe(messages.length);
      const priv = (await r.channels()).find((c) => c.kind === 'private')!;
      // keys carry the fingerprint of the server the archive came from, then the username
      expect(priv.memberKeys!.map((k) => k.slice(k.indexOf(':') + 1)).sort()).toEqual(['jon', 'nadia', 'omar']);
      expect(new Set(priv.memberKeys!.map((k) => k.slice(0, k.indexOf(':')))).size).toBe(1);
    } finally {
      await r.close();
    }
  });

  it('reads the same export inside a zip', async () => {
    const path = await write(buildZip([{ name: 'export.jsonl', data: mattermostExport() }, { name: 'data/readme.txt', data: 'x' }]));
    const r = await openArchive(path, 'mattermost');
    expect(await all(r)).toHaveLength(MATTERMOST_EXPECTED.messages);
    await r.close();
  });

  it('counts a malformed line and a line over the limit and reads the lines around them', async () => {
    const good = (i: number): string => JSON.stringify({ type: 'post', post: { team: 't', channel: 'c', user: 'u', message: `m${i}`, create_at: 1709546400000 + i } });
    const head = [
      JSON.stringify({ type: 'version', version: 1 }),
      JSON.stringify({ type: 'channel', channel: { team: 't', name: 'c', display_name: 'C', type: 'O' } }),
      JSON.stringify({ type: 'user', user: { username: 'u', email: 'u@kahf.example', teams: [{ name: 't', channels: [{ name: 'c' }] }] } }),
    ];
    const text = [...head, good(1), '{"type":"post","post":{broken', 'x'.repeat(6 * 1024 * 1024), good(2), `{"type":"post","post":{"team":"t","channel":"c","user":"u","message":"${'z'.repeat(40_000)}","create_at":1709546500000}}`].join('\n');
    const r = await openArchive(await write(text), 'mattermost', limits({ maxLineBytes: 1024 * 1024 }));
    const messages = (await all(r)).filter((m) => m.skip === null);
    expect(messages).toHaveLength(3);
    expect(r.notes.get('line_too_long')).toBeGreaterThanOrEqual(1);
    expect(r.notes.get('malformed_entry')).toBeGreaterThanOrEqual(1);
    await r.close();
  });

  it('drops a line nested 5,000 deep and a line that is not an object', async () => {
    const deep = `{"type":"post","post":{"team":"t","channel":"c","user":"u","message":"m","create_at":1709546400000,"x":${'['.repeat(5000)}${']'.repeat(5000)}}}`;
    const text = [JSON.stringify({ type: 'channel', channel: { team: 't', name: 'c', display_name: 'C', type: 'O' } }), deep, '[1,2,3]', '"just a string"', '42'].join('\n');
    const r = await openArchive(await write(text), 'mattermost');
    expect((await all(r)).filter((m) => m.skip === null)).toHaveLength(0);
    expect(r.notes.get('malformed_entry')).toBeGreaterThanOrEqual(1);
    await r.close();
  });

  it('refuses a file that is not JSON lines and a zip without one', async () => {
    await expect(openArchive(await write('not json lines'), 'mattermost')).rejects.toBeInstanceOf(ArchiveError);
    await expect(openArchive(await write(buildZip([{ name: 'notes.txt', data: 'x' }])), 'mattermost')).rejects.toBeInstanceOf(ArchiveError);
  });
});


// Mattermost keys: what makes an archive's names its own, and what a second look at the same archive must repeat.
const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n');
const MM_USER = (name: string, over: Record<string, unknown> = {}): unknown => ({
  type: 'user',
  user: { username: name, email: `${name}@kahf.example`, teams: [{ name: 'main', channels: [{ name: 'town-square' }] }], ...over },
});
const MM_POST = (user: string, at: number, message = 'hi', extra: Record<string, unknown> = {}): unknown => ({
  type: 'post',
  post: { team: 'main', channel: 'town-square', user, message, create_at: at, ...extra },
});
const MM_HEAD = (display = 'Main'): unknown[] => [
  { type: 'version', version: 1 },
  { type: 'team', team: { name: 'main', display_name: display, type: 'O' } },
  { type: 'channel', channel: { team: 'main', name: 'town-square', display_name: 'Town Square', type: 'O' } },
];
const T0 = 1709546400000;
async function mm(lines: unknown[], over: Partial<ArchiveLimits> = {}, now?: () => number): Promise<ArchiveReader> {
  return openArchive(await write(jsonl(lines)), 'mattermost', limits(over), now);
}

describe('the Mattermost reader keys', () => {
  it('differ between two servers that both have main/town-square and alice, and repeat for the same server', async () => {
    const a1 = await mm([...MM_HEAD('Main'), MM_USER('alice'), MM_POST('alice', T0)]);
    const a2 = await mm([...MM_HEAD('Main'), MM_USER('alice'), MM_POST('alice', T0), MM_POST('alice', T0 + 60_000, 'later')]);
    const b = await mm([...MM_HEAD('Main office B'), MM_USER('alice'), MM_POST('alice', T0)]);
    const [pa1, pa2, pb] = [(await a1.people())[0]!, (await a2.people())[0]!, (await b.people())[0]!];
    expect(pa1.key).toBe(pa2.key);
    expect(pa1.key).not.toBe(pb.key);
    expect((await a1.channels())[0]!.key).toBe((await a2.channels())[0]!.key);
    expect((await a1.channels())[0]!.key).not.toBe((await b.channels())[0]!.key);
    const [ma, mb] = [(await all(a1))[0]!, (await all(b))[0]!];
    expect(ma.key).not.toBe(mb.key);
    expect(ma.authorKey).toBe(pa1.key);
    expect(ma.channelKey).toBe((await a1.channels())[0]!.key);
    expect((await all(a2))[0]!.key).toBe(ma.key);
    for (const r of [a1, a2, b]) await r.close();
  });

  it('are not changed by details of the version record that differ between exports of one server', async () => {
    const one = await mm([{ type: 'version', version: 1, info: { created: '2025-01-01' } }, ...MM_HEAD().slice(1), MM_USER('alice')]);
    const two = await mm([{ type: 'version', version: 1, info: { created: '2026-06-06' } }, ...MM_HEAD().slice(1), MM_USER('alice')]);
    expect((await one.people())[0]!.key).toBe((await two.people())[0]!.key);
    await one.close();
    await two.close();
  });

  it('read a conversation, a reaction and a mention with the same keys as the people list', async () => {
    const r = await mm([
      ...MM_HEAD(),
      MM_USER('alice'),
      MM_USER('bob'),
      { type: 'direct_channel', direct_channel: { members: ['alice', 'bob'] } },
      { type: 'direct_post', direct_post: { channel_members: ['bob', 'alice'], user: 'bob', message: 'psst @alice', create_at: T0 + 5 } },
      MM_POST('alice', T0, 'hello', { reactions: [{ user: 'bob', emoji_name: 'tada' }] }),
    ]);
    const keys = new Set((await r.people()).map((p) => p.key));
    const dm = (await r.channels()).find((c) => c.kind === 'direct')!;
    expect(dm.memberKeys!.every((k) => keys.has(k))).toBe(true);
    const messages = await all(r);
    expect(messages.find((m) => m.channelKey === dm.key)!.authorKey).toSatisfy((k: string) => keys.has(k));
    expect(messages.find((m) => m.reactions.length > 0)!.reactions[0]!.userKeys.every((k) => keys.has(k))).toBe(true);
    expect(messages.find((m) => m.channelKey === dm.key)!.mentions).toBe(1);
    expect(r.nameOf!((await r.people())[0]!.key)).toBe('alice');
    await r.close();
  });

  it('keep the key of a message dated in the future the same on every run, and store its time as now', async () => {
    const lines = [...MM_HEAD(), MM_USER('alice'), MM_POST('alice', Date.UTC(2099, 0, 1), 'from the future')];
    const early = await mm(lines, {}, () => T0 + 1000);
    const late = await mm(lines, {}, () => T0 + 999_000);
    const [a, b] = [(await all(early))[0]!, (await all(late))[0]!];
    expect(a.key).toBe(b.key);
    expect(a.at).toBe(T0 + 1000);
    expect(b.at).toBe(T0 + 999_000);
    await early.close();
    await late.close();
  });

  it('leave out the posts of a bot account as app messages, as Slack does', async () => {
    const r = await mm([...MM_HEAD(), MM_USER('alice'), MM_USER('buildbot', { is_bot: true }), MM_POST('buildbot', T0, 'build ok'), MM_POST('alice', T0 + 1, 'thanks')]);
    const messages = await all(r);
    expect(messages.map((m) => m.skip)).toEqual(['app_message', null]);
    await r.close();
  });

  it('count a thread when its first message is handed on, even when that message ends a batch of 100', async () => {
    const root = MM_POST('alice', T0, 'root', { replies: [{ user: 'alice', message: 'reply', create_at: T0 + 60_000 }] });
    const r = await mm([...MM_HEAD(), MM_USER('alice'), root]);
    const seen: boolean[] = [];
    for await (const m of r.messages()) seen.push(m.rootKey === null && m.startsThread);
    // the root was already marked when it was received (a consumer that reads it at once, before asking for the next, sees the mark)
    expect(seen).toEqual([true, false]);
    await r.close();
  });

  it('name a channel for the importer when its display name has no Latin letter', async () => {
    const r = await mm([{ type: 'channel', channel: { team: 'main', name: 'arabic-room', display_name: 'قناة عامة', type: 'O' } }]);
    const c = (await r.channels())[0]!;
    expect(c.name).toBe('قناة عامة');
    expect(c.slug).toBe('arabic-room');
    await r.close();
  });

  it('refuse an export that lists more people, channels or memberships than the limits allow, in plain words', async () => {
    const people = Array.from({ length: 5 }, (_, i) => MM_USER(`user${i}`));
    await expect((await mm([...MM_HEAD(), ...people], { maxPeople: 4 })).people()).rejects.toThrow(/more than 4 people/);
    const rooms = Array.from({ length: 5 }, (_, i) => ({ type: 'channel', channel: { team: 'main', name: `room${i}`, display_name: `R${i}`, type: 'O' } }));
    await expect((await mm(rooms, { maxChannels: 4 })).channels()).rejects.toBeInstanceOf(ArchiveError);
    const crowd = MM_USER('alice', { teams: [{ name: 'main', channels: Array.from({ length: 10 }, (_, i) => ({ name: `c${i}` })) }] });
    await expect((await mm([crowd], { maxMemberships: 9 })).people()).rejects.toThrow(/channel memberships/);
    // and at the limit it still reads
    expect(await (await mm([...MM_HEAD(), ...people], { maxPeople: 5 })).people()).toHaveLength(5);
  });
});

describe('the Slack reader channel names', () => {
  it('gives a channel its id as the short name for the importer', async () => {
    const zip = buildZip([
      { name: 'users.json', data: '[]' },
      { name: 'channels.json', data: JSON.stringify([{ id: 'C0ARABIC', name: 'قناة', members: [] }]) },
    ]);
    const r = await openArchive(await write(zip), 'slack');
    const c = (await r.channels())[0]!;
    expect(c.slug).toBe('C0ARABIC');
    await r.close();
  });
});

describe('which files an upload may be', () => {
  const zipHead = buildZip([{ name: 'a', data: 'b' }]).subarray(0, 64);
  it('lets Slack take a zip only and Mattermost a zip or JSON lines', () => {
    expect(looksLikeArchive('slack', zipHead)).toBe(true);
    expect(looksLikeArchive('slack', Buffer.from('{"type":"version"}'))).toBe(false);
    expect(looksLikeArchive('mattermost', Buffer.from('{"type":"version"}'))).toBe(true);
    expect(looksLikeArchive('mattermost', Buffer.from('﻿ \n{"type":"version"}'))).toBe(true);
    expect(looksLikeArchive('mattermost', zipHead)).toBe(true);
    for (const source of ['slack', 'mattermost'] as const) {
      expect(looksLikeArchive(source, Buffer.from('MZ\u0090\u0000 an executable'))).toBe(false);
      expect(looksLikeArchive(source, Buffer.from('#!/bin/sh\nrm -rf /'))).toBe(false);
      expect(looksLikeArchive(source, Buffer.alloc(0))).toBe(false);
    }
  });
});

describe('text helpers', () => {
  it('decodes UTF-8, UTF-8 with a mark and UTF-16, and refuses other encodings', () => {
    expect(decodeText(Buffer.from('héllo', 'utf8'))).toBe('héllo');
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x')])).replace('﻿', '')).toBe('x');
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]))).toBe('hi');
    expect(() => decodeText(Buffer.from([0x68, 0xe9, 0x6c, 0x6c, 0x6f]))).toThrow(NotTextError);
  });

  it('splits a JSON array element by element, with brackets and quotes inside strings', () => {
    const pieces = [...splitJsonArray('[{"a":"]},"},[1,[2]], 3, {bad}, "x\\"y"]', 10)];
    expect(pieces.map((p) => (p.ok ? p.value : p.reason))).toEqual([{ a: ']},' }, [1, [2]], 3, 'malformed', 'x"y']);
    expect(() => [...splitJsonArray('{"not":"an array"}', 10)]).toThrow(NotTextError);
    expect(() => [...splitJsonArray('[1,2', 10)]).toThrow(NotTextError);
  });

  it('measures nesting without recursion', () => {
    expect(jsonDepth('{"a":[1,{"b":[]}]}')).toBe(4);
    expect(jsonDepth(`${'['.repeat(200_000)}${']'.repeat(200_000)}`)).toBe(200_000);
  });

  it('splits lines across chunk boundaries, drops over-long lines without keeping them and skips blank lines', async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('one\r\ntw');
      yield Buffer.from('o\n\n');
      yield Buffer.from('x'.repeat(100));
      yield Buffer.from('x'.repeat(100));
      yield Buffer.from('\nlast');
    }
    const out: string[] = [];
    for await (const l of splitLines(chunks(), 150)) out.push('tooLong' in l ? 'TOO_LONG' : l.line.toString());
    expect(out).toEqual(['one', 'two', 'TOO_LONG', 'last']);
  });

  it('cleans message text: control characters out, lone surrogates replaced, line endings plain, length cut', () => {
    expect(cleanMessageText('a\u0000b\u0007c\r\nd\te').text).toBe('abc\nd\te');
    expect(cleanMessageText('bad \uD800 half').text).toBe('bad � half');
    const long = cleanMessageText('😀'.repeat(IMPORT_MESSAGE_MAX_CHARS));
    expect(long.shortened).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(IMPORT_MESSAGE_MAX_CHARS);
    expect(long.text).not.toMatch(/\uD83D$/);
  });

  it('accepts a plausible email address and nothing else', () => {
    expect(cleanEmail(' Omar@Kahf.Example ')).toBe('omar@kahf.example');
    for (const bad of ['', 'nope', 'a@b', 'a b@c.d', '<x>@y.zz', null, 42]) expect(cleanEmail(bad)).toBeNull();
  });
});
