import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// the byte-stream uploads switch to a JSON stand-in in mock mode (as the screens do offline)
vi.mock('../src/api/setup', async (original) => ({ ...(await original<typeof import('../src/api/setup')>()), isMockMode: () => true }));

import { BotPersonalConsent } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import {
  createPersonalNote,
  discardPersonalItem,
  fetchPersonalConcepts,
  fetchPersonalFile,
  fetchPersonalInbox,
  fetchPersonalVersions,
  releasePersonalItem,
  removePersonalFile,
  restorePersonalVersion,
  retryPersonalItem,
  savePersonalFile,
  sendPersonalItemToTeam,
  uploadPersonalFile,
} from '../src/screens/memory/personalApi';
import {
  bundlePath,
  conceptTitles,
  filedFiles,
  filedReference,
  findConcept,
  isChangedSince,
  personalActions,
  personalSentence,
  samePath,
  teamChoiceLabel,
  titleFor,
} from '../src/screens/memory/personalWords';
import { PERSONAL_TABS, TABS, nextTab, tabFromParams } from '../src/screens/memory/memoryTabs';
import {
  createPersonalBase,
  deletePersonalBase,
  deletePersonalDocument,
  fetchPersonalBase,
  fetchPersonalBases,
  searchPersonalBase,
  uploadPersonalDocument,
} from '../src/screens/knowledge/api';
import { countLine, fallbackSlug, searchModeSentence, sizeLabel, slugFromName, stateSentence, uploadSentence } from '../src/screens/knowledge/words';
import { fetchBotConsents, setBotConsent } from '../src/screens/account/botConsentsApi';
import { consentSentence } from '../src/screens/account/BotConsents';

/*
 * The Personal side of Memory, Knowledge and the bot-consent page. The first part checks each call reaches the route the plugins mount (written out, not derived from
 * the route objects the client uses). The second runs the calls against the mock transport the screens use offline: its answers must parse with the shared schemas,
 * keep one person's space away from the next, and refuse what the server refuses. The third reads the plain words.
 */

const BRAIN = '00000000-0000-7000-8000-0000000b0001';
const PLANNER = '00000000-0000-7000-8000-0000000b0002';
const ITEM = '00000000-0000-7000-8000-0000000d0001';

describe('the calls reach the routes the plugins mount', () => {
  let seen: TransportRequest[] = [];
  beforeEach(() => {
    seen = [];
    setTransport(async (req) => {
      seen.push(req);
      return { status: 418, body: { error: { code: 'internal', message: 'stop' } } };
    });
  });
  const last = async (run: () => Promise<unknown>): Promise<TransportRequest> => {
    await run().catch(() => undefined);
    const req = seen.at(-1);
    if (!req) throw new Error('no request was sent');
    return req;
  };
  const cases: Array<{ name: string; run: () => Promise<unknown>; method: string; url: string; query?: string; body?: unknown }> = [
    { name: 'lists the files', run: () => fetchPersonalConcepts(), method: 'GET', url: '/api/me/memory/concepts' },
    { name: 'reads a file by path', run: () => fetchPersonalFile('people/rafi.md'), method: 'GET', url: '/api/me/memory/file', query: 'path=people%2Frafi.md' },
    { name: 'saves a file', run: () => savePersonalFile({ path: 'people/rafi.md', content: '---\ntype: Person\n---\nx', baseVersion: 2 }), method: 'PUT', url: '/api/me/memory/file', body: { path: 'people/rafi.md', content: '---\ntype: Person\n---\nx', baseVersion: 2 } },
    { name: 'deletes a file by path', run: () => removePersonalFile('people/rafi.md'), method: 'DELETE', url: '/api/me/memory/file', query: 'path=people%2Frafi.md' },
    { name: 'lists versions', run: () => fetchPersonalVersions('people/rafi.md'), method: 'GET', url: '/api/me/memory/versions', query: 'path=people%2Frafi.md' },
    { name: 'restores a version', run: () => restorePersonalVersion('people/rafi.md', 1), method: 'POST', url: '/api/me/memory/restore', body: { path: 'people/rafi.md', versionNo: 1 } },
    { name: 'lists the inbox', run: () => fetchPersonalInbox(), method: 'GET', url: '/api/me/inbox/items' },
    { name: 'releases', run: () => releasePersonalItem(ITEM), method: 'POST', url: `/api/me/inbox/items/${ITEM}/release` },
    { name: 'discards', run: () => discardPersonalItem(ITEM), method: 'POST', url: `/api/me/inbox/items/${ITEM}/discard` },
    { name: 'retries', run: () => retryPersonalItem(ITEM), method: 'POST', url: `/api/me/inbox/items/${ITEM}/retry` },
    { name: 'adds a note', run: () => createPersonalNote({ title: 'Idea', text: 'Try the thing.' }), method: 'POST', url: '/api/me/inbox/notes', body: { title: 'Idea', text: 'Try the thing.' } },
    { name: 'sends to a team', run: () => sendPersonalItemToTeam(ITEM, { teamSlug: 'engineering', teamOnly: true }), method: 'POST', url: `/api/me/inbox/items/${ITEM}/send-to-team`, body: { teamSlug: 'engineering', teamOnly: true } },
    { name: 'lists the knowledge bases', run: () => fetchPersonalBases(), method: 'GET', url: '/api/me/knowledge' },
    { name: 'creates a knowledge base', run: () => createPersonalBase({ slug: 'reading', name: 'Reading' }), method: 'POST', url: '/api/me/knowledge', body: { slug: 'reading', name: 'Reading' } },
    { name: 'reads one base', run: () => fetchPersonalBase('reading'), method: 'GET', url: '/api/me/knowledge/reading' },
    { name: 'deletes a base', run: () => deletePersonalBase('reading'), method: 'DELETE', url: '/api/me/knowledge/reading' },
    { name: 'deletes a document', run: () => deletePersonalDocument('reading', ITEM), method: 'DELETE', url: `/api/me/knowledge/reading/documents/${ITEM}` },
    { name: 'searches a base', run: () => searchPersonalBase('reading', 'refund policy'), method: 'GET', url: '/api/me/knowledge/reading/search', query: 'q=refund+policy&limit=5' },
    { name: 'lists the consents', run: () => fetchBotConsents(), method: 'GET', url: '/api/me/bot-consents' },
    { name: 'sets a consent', run: () => setBotConsent(BRAIN, false), method: 'PUT', url: `/api/me/bot-consents/${BRAIN}`, body: { allowed: false } },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const req = await last(c.run);
      expect(req.method).toBe(c.method);
      expect(req.url.split('?')[0]).toBe(c.url);
      if (c.query !== undefined) expect(req.url.split('?')[1]).toBe(c.query);
      if (c.body !== undefined) expect(JSON.parse(req.body ?? 'null')).toEqual(c.body);
    });
  }

  it('refuses a consent body the schema does not know before it leaves the browser', async () => {
    expect(() => setBotConsent(BRAIN, 'yes' as never)).toThrow();
    expect(seen).toHaveLength(0);
  });
  it('refuses an empty path before it leaves the browser', async () => {
    expect(() => savePersonalFile({ path: '', content: 'x' })).toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('the mock answers as the plugins do', () => {
  const as = (who: string) => setTransport(createMockTransport({ latencyMs: 0, as: who }));
  const FILE = '---\ntype: Fact\ntitle: Lunch\ndescription: Where we eat.\n---\n\nWe eat at noon.\n';

  it('keeps one person’s space away from the next', async () => {
    as('nadia');
    await savePersonalFile({ path: 'facts/lunch.md', content: FILE });
    expect((await fetchPersonalConcepts()).items.map((c) => c.path)).toContain('facts/lunch.md');
    as('rafi');
    expect((await fetchPersonalConcepts()).items.map((c) => c.path)).not.toContain('facts/lunch.md');
    await expect(fetchPersonalFile('facts/lunch.md')).rejects.toMatchObject({ status: 404 });
  });

  it('shows a guest no Personal space on any route', async () => {
    as('lena');
    for (const run of [() => fetchPersonalConcepts(), () => fetchPersonalInbox(), () => fetchPersonalBases(), () => fetchBotConsents()]) {
      await expect(run()).rejects.toMatchObject({ status: 403 });
    }
  });

  it('refuses a save from a stale version, and keeps the newer text', async () => {
    as('nadia');
    const first = await savePersonalFile({ path: 'facts/lunch.md', content: FILE });
    const v1 = first.file.versionNo;
    const second = await savePersonalFile({ path: 'facts/lunch.md', content: FILE.replace('noon', '1pm'), baseVersion: v1 });
    expect(second.file.versionNo).toBe(v1 + 1);
    const err = await savePersonalFile({ path: 'facts/lunch.md', content: FILE.replace('noon', '2pm'), baseVersion: v1 }).catch((e: unknown) => e);
    expect(isChangedSince(err)).toBe(true);
    expect((await fetchPersonalFile('facts/lunch.md')).file.content).toContain('1pm');
  });

  it('keeps every version and restores an earlier one as a new version', async () => {
    as('nadia');
    const a = await savePersonalFile({ path: 'facts/lunch.md', content: FILE });
    await savePersonalFile({ path: 'facts/lunch.md', content: FILE.replace('noon', '1pm'), baseVersion: a.file.versionNo });
    const versions = (await fetchPersonalVersions('facts/lunch.md')).items;
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    const restored = await restorePersonalVersion('facts/lunch.md', 1);
    expect(restored.file.content).toContain('noon');
    expect(restored.file.versionNo).toBe(3);
  });

  it('refuses a file with no front block', async () => {
    as('nadia');
    await expect(savePersonalFile({ path: 'facts/x.md', content: 'just text' })).rejects.toMatchObject({ status: 400 });
  });

  it('deletes a file', async () => {
    as('nadia');
    await savePersonalFile({ path: 'facts/lunch.md', content: FILE });
    expect(await removePersonalFile('facts/lunch.md')).toEqual({ removed: true });
    expect((await fetchPersonalConcepts()).items.map((c) => c.path)).not.toContain('facts/lunch.md');
  });

  it('files a note from queued to filed and links the file it wrote', async () => {
    as('nadia');
    const made = await createPersonalNote({ title: 'Idea', text: 'Try the thing.' });
    expect(made.duplicate).toBe(false);
    expect(made.item.state).toBe('queued');
    expect((await fetchPersonalInbox()).items.find((i) => i.id === made.item.id)?.state).toBe('filing');
    const done = (await fetchPersonalInbox()).items.find((i) => i.id === made.item.id);
    expect(done?.state).toBe('filed');
    const ref = done ? filedReference(done) : null;
    expect(ref).not.toBeNull();
    const concepts = (await fetchPersonalConcepts()).items;
    expect(findConcept(concepts, ref)?.title).toBe('Idea');
    expect((await createPersonalNote({ title: 'Idea', text: 'Try the thing.' })).duplicate).toBe(true);
  });

  it('holds a bundle until the person lets it through, and lets them discard it', async () => {
    as('nadia');
    const held = (await fetchPersonalInbox()).items.find((i) => i.state === 'held');
    expect(held?.holdReason).toBe('foreign_bundle');
    await expect(retryPersonalItem(held?.id ?? '')).rejects.toMatchObject({ status: 409 });
    // a memory bundle cannot be imported into Personal: letting it through ends in a plain sentence, not a silent drop
    const released = await releasePersonalItem(held?.id ?? '');
    expect(released.item.state).toBe('failed');
    expect(released.item.reason).toMatch(/cannot be imported/);
    const failed = (await fetchPersonalInbox()).items.find((i) => i.state === 'failed');
    expect(failed).toBeDefined();
    expect((await retryPersonalItem(failed?.id ?? '')).item.state).toBe('queued');
    const gone = await discardPersonalItem(failed?.id ?? '');
    expect(gone.item.state).toBe('discarded');
    expect((await fetchPersonalInbox()).items.some((i) => i.id === failed?.id)).toBe(false);
  });

  it('copies an item to a team the person belongs to, and to no other', async () => {
    as('nadia');
    const filed = (await fetchPersonalInbox()).items.find((i) => i.state === 'filed');
    const sent = await sendPersonalItemToTeam(filed?.id ?? '', { teamSlug: 'engineering', teamOnly: false });
    expect(sent.duplicate).toBe(false);
    await expect(sendPersonalItemToTeam(filed?.id ?? '', { teamSlug: 'no-such-team', teamOnly: false })).rejects.toMatchObject({ status: 403 });
  });

  it('creates, fills, searches and deletes a knowledge base, and stops at ten', async () => {
    as('nadia');
    const { base } = await createPersonalBase({ slug: 'reading', name: 'Reading list' });
    expect(base.state).toBe('empty');
    await expect(createPersonalBase({ slug: 'reading', name: 'Again' })).rejects.toMatchObject({ status: 409 });
    const file = new File(['Refunds take five days.'], 'refunds.md', { type: 'text/markdown' });
    const up = await uploadPersonalDocument('reading', file, () => undefined);
    expect(up.outcome).toBe('added');
    const got = await fetchPersonalBase('reading');
    expect(got.documents.map((d) => d.name)).toEqual(['refunds.md']);
    expect((await searchPersonalBase('reading', 'refunds')).hits.length).toBeGreaterThan(0);
    expect((await deletePersonalDocument('reading', got.documents[0]?.id ?? '')).removed).toBeDefined();
    await deletePersonalBase('reading');
    await expect(fetchPersonalBase('reading')).rejects.toMatchObject({ status: 404 });
    for (let n = 0; n < 10; n += 1) await createPersonalBase({ slug: `b${String(n)}`, name: `Base ${String(n)}` });
    await expect(createPersonalBase({ slug: 'one-more', name: 'One more' })).rejects.toMatchObject({ status: 409 });
  });

  it('keeps one person’s knowledge bases away from the next', async () => {
    as('nadia');
    await createPersonalBase({ slug: 'mine', name: 'Mine' });
    as('rafi');
    expect((await fetchPersonalBases()).bases.map((b) => b.slug)).not.toContain('mine');
    await expect(fetchPersonalBase('mine')).rejects.toMatchObject({ status: 404 });
  });

  it('lists the bots with their defaults and keeps each person’s answer to themselves', async () => {
    as('nadia');
    const list = (await fetchBotConsents()).items;
    const brain = list.find((c) => c.botId === BRAIN);
    const planner = list.find((c) => c.botId === PLANNER);
    expect(brain).toMatchObject({ allowed: true, isDefault: true, canAsk: true });
    expect(planner).toMatchObject({ allowed: false, isDefault: true, canAsk: true });
    expect(list.some((c) => !c.canAsk)).toBe(true);
    const off = await setBotConsent(BRAIN, false);
    expect(off.item).toMatchObject({ allowed: false, isDefault: false });
    expect(off.item.changedAt).not.toBeNull();
    as('rafi');
    expect((await fetchBotConsents()).items.find((c) => c.botId === BRAIN)?.allowed).toBe(true);
    await expect(setBotConsent('00000000-0000-7000-8000-0000000b00ff', true)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the upload helpers in mock mode', () => {
  it('drops a file into the inbox with its name', async () => {
    setTransport(createMockTransport({ latencyMs: 0, as: 'nadia' }));
    const answer = await uploadPersonalFile(new File(['hello'], 'notes.txt', { type: 'text/plain' }), () => undefined);
    expect(answer.item.name).toBe('notes.txt');
    expect(answer.item.kind).toBe('text');
  });
});

describe('the plain words', () => {
  it('matches paths with or without the memory folder in front', () => {
    expect(bundlePath('memory/references/a.md')).toBe('references/a.md');
    expect(bundlePath('references/a.md')).toBe('references/a.md');
    expect(samePath('memory/references/a.md', 'references/a.md')).toBe(true);
    expect(samePath('a.md', 'b.md')).toBe(false);
    const concepts = [{ path: 'references/a.md' }, { path: 'people/b.md' }];
    expect(findConcept(concepts, 'memory/references/a.md')?.path).toBe('references/a.md');
    expect(findConcept(concepts, 'nope.md')).toBeNull();
    expect(findConcept(concepts, null)).toBeNull();
  });

  it('splits what an item became from its reference', () => {
    const item = { filedPaths: ['memory/people/rafi.md', 'memory/references/x-1.md'] };
    expect(filedFiles(item)).toEqual(['memory/people/rafi.md']);
    expect(filedReference(item)).toBe('memory/references/x-1.md');
    expect(filedReference({ filedPaths: [] })).toBeNull();
  });

  it('offers each state only the actions the server allows', () => {
    expect(personalActions({ state: 'held', originalKept: true })).toMatchObject({ release: true, discard: true, retry: false });
    expect(personalActions({ state: 'failed', originalKept: true })).toMatchObject({ retry: true, discard: true, release: false });
    expect(personalActions({ state: 'filed', originalKept: true })).toMatchObject({ discard: false, sendToTeam: true });
    expect(personalActions({ state: 'filed', originalKept: false }).sendToTeam).toBe(false);
    expect(personalActions({ state: 'duplicate', originalKept: true }).sendToTeam).toBe(false);
  });

  it('says why a held item waits, in words', () => {
    expect(personalSentence({ state: 'held', reason: null, holdReason: 'dlp' })).toMatch(/private data/);
    expect(personalSentence({ state: 'queued', reason: null, holdReason: null })).toMatch(/turn/);
    expect(personalSentence({ state: 'failed', reason: 'Pictures cannot be read yet.', holdReason: null })).toBe('Pictures cannot be read yet.');
    expect(personalSentence({ state: 'filed', reason: null, holdReason: null })).toBeNull();
  });

  it('knows a 409 as "changed since you opened it"', () => {
    expect(isChangedSince({ status: 409 })).toBe(true);
    expect(isChangedSince({ status: 500 })).toBe(false);
    expect(isChangedSince(null)).toBe(false);
  });

  it('names a team for the choice with its slug only when two share a name', () => {
    expect(teamChoiceLabel({ name: 'Engineering', slug: 'engineering' })).toContain('Engineering');
  });

  it('gives Personal two tabs and no Sharing, and the arrows wrap inside them', () => {
    expect(PERSONAL_TABS.map((t) => t.id)).toEqual(['concepts', 'inbox']);
    expect(TABS.map((t) => t.id)).toContain('sharing');
    expect(tabFromParams('sharing', null, PERSONAL_TABS)).toBe('concepts');
    expect(tabFromParams('inbox', null, PERSONAL_TABS)).toBe('inbox');
    expect(tabFromParams('inbox', 'people/a.md', PERSONAL_TABS)).toBe('concepts');
    expect(nextTab('inbox', 'ArrowRight', PERSONAL_TABS)).toBe('concepts');
    expect(nextTab('concepts', 'ArrowLeft', PERSONAL_TABS)).toBe('inbox');
    expect(nextTab('concepts', 'End', PERSONAL_TABS)).toBe('inbox');
    expect(nextTab('concepts', 'x', PERSONAL_TABS)).toBeNull();
  });

  it('makes an address-safe base name from what a person types', () => {
    expect(slugFromName('Reading list')).toBe('reading-list');
    expect(slugFromName('  Café & Crème!  ')).toBe('cafe-creme');
    expect(slugFromName('!!!')).toBeNull();
    expect(slugFromName('a'.repeat(100))?.length).toBe(63);
  });

  it('writes sizes, counts and upload results in plain words', () => {
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(2048)).toBe('2.0 KB');
    expect(sizeLabel(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(countLine(1, 'document', 'documents')).toBe('1 document');
    expect(countLine(0, 'document', 'documents')).toBe('0 documents');
    const doc = { name: 'a.md', chunkCount: 3, version: 2, reason: null };
    expect(uploadSentence('added', doc)).toContain('3 passages');
    expect(uploadSentence('added', { ...doc, chunkCount: 1 })).toContain('(1 passage)');
    expect(uploadSentence('updated', doc)).toContain('version 2');
    expect(uploadSentence('unchanged', doc)).toContain('nothing changed');
    expect(uploadSentence('failed', { ...doc, reason: 'Not readable.' })).toContain('Not readable.');
    expect(stateSentence('attention')).toMatch(/could not be read/);
    expect(searchModeSentence('lexical')).toMatch(/embedding model/);
    expect(searchModeSentence('hybrid')).toMatch(/meaning/);
  });

  it('says what each bot may do, and that a bot that does not ask cannot read', () => {
    const base = BotPersonalConsent.parse({ botId: BRAIN, botSlug: 'brain', botName: 'Brain', canAsk: true, allowed: true, isDefault: true, changedAt: null });
    expect(consentSentence(base)).toMatch(/default for Brain/);
    expect(consentSentence({ ...base, isDefault: false })).toBe('May read your Personal space when you ask it.');
    expect(consentSentence({ ...base, allowed: false, isDefault: false })).toMatch(/You turned it off/);
    expect(consentSentence({ ...base, botSlug: 'planner', allowed: false })).toMatch(/until you allow it/);
    expect(consentSentence({ ...base, botSlug: 'support-responder', canAsk: false, allowed: false })).toMatch(/not set up to ask/);
  });
});

describe('review fixes (P20-R5)', () => {
  it('keeps the Account pages free of the app shell context: they sit in the settings frame, where it is not provided', () => {
    // `useShell` throws outside the shell; /account/bots crashed on it until the role came from the session
    const dir = new URL('../src/screens/account/', import.meta.url);
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
      expect(readFileSync(new URL(name, dir), 'utf8'), name).not.toMatch(/shell\/context|useShell\(/);
    }
  });

  it('finds a title for a file path in either spelling', () => {
    const titles = conceptTitles([{ path: 'references/standup-7c1d9e02.md', title: 'Standup notes' }]);
    expect(titleFor(titles, 'references/standup-7c1d9e02.md')).toBe('Standup notes');
    expect(titleFor(titles, 'memory/references/standup-7c1d9e02.md')).toBe('Standup notes');
    expect(titleFor(titles, 'memory/references/other.md')).toBeUndefined();
  });

  it('gives a base named in another script an address the server accepts', () => {
    expect(slugFromName('مكتبتي')).toBeNull();
    for (let i = 0; i < 50; i += 1) expect(fallbackSlug()).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
});
