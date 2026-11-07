import {
  BotPersonalConsent,
  PersonalInboxItem,
  PersonalKnowledgeBase,
  createPersonalInboxNoteRoute,
  createPersonalKnowledgeBaseRoute,
  deletePersonalKnowledgeBaseRoute,
  deletePersonalKnowledgeDocumentRoute,
  deletePersonalMemoryRoute,
  discardPersonalInboxRoute,
  getPersonalInboxItemRoute,
  getPersonalKnowledgeBaseRoute,
  getPersonalMemoryFileRoute,
  listBotConsentsRoute,
  listPersonalInboxRoute,
  listPersonalKnowledgeBasesRoute,
  listPersonalMemoryRoute,
  listPersonalMemoryVersionsRoute,
  releasePersonalInboxRoute,
  restorePersonalMemoryRoute,
  retryPersonalInboxRoute,
  searchPersonalKnowledgeRoute,
  sendPersonalInboxToTeamRoute,
  setBotConsentRoute,
  uploadPersonalInboxRoute,
  uploadPersonalKnowledgeDocumentRoute,
  writePersonalMemoryRoute,
  type InboxKind,
  KnowledgeDocument,
  type MemoryConceptSummary,
  type PersonalMemoryVersion,
} from '@manythreads/shared';

/*
 * The mock of a person's own space (P20-04/05/06/09): their memory files, inbox, knowledge bases and the answers they gave about bots. The same routes, shapes and
 * words the plugins answer with. Everything is kept per signed-in person and nobody can name another: the routes take no person. A guest has no Personal space
 * and is refused with 403. An inbox drop starts `queued` and moves one step every time the list is read (queued, filing, filed). A `.zip` is held for the owner;
 * a picture is kept but fails, as the server does today.
 */

type Route = { method: string; path: string };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type On = (route: Route, handler: (c: Ctx) => unknown) => void;
type Reply = { status: number; body: unknown };

export type PersonalMockHooks = {
  /** The signed-in person; a guest has no Personal space. */
  me(): { id: string; name: string; role: string };
  /** A team the person can post in, by slug (the same refusals as every team route). */
  team(slug: string | undefined): { id: string; slug: string; name: string };
  workspaceId: string;
  nextId(): string;
  now: string;
  fail(status: number, code: 'not_found' | 'conflict' | 'forbidden' | 'validation_failed', message: string): never;
};

const created = (body: unknown): Reply => ({ status: 201, body });
const hex = (n: number): string => n.toString(16).padStart(8, '0').repeat(8);

type FileState = { path: string; content: string; versions: PersonalMemoryVersion[]; texts: Map<number, string>; meta: Pick<MemoryConceptSummary, 'type' | 'title' | 'description' | 'tags' | 'trustTier' | 'origin'> };
type DocState = { doc: Omit<KnowledgeDocument, 'repoPath'>; text: string };
type BaseState = { base: PersonalKnowledgeBase; docs: DocState[] };
type Mine = { files: FileState[]; items: PersonalInboxItem[]; bases: BaseState[]; consents: Map<string, boolean>; counter: number };

const kindOfName = (name: string): InboxKind => {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'text';
  if (ext === 'csv') return 'csv';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (ext === 'zip') return 'bundle';
  return ext === '' ? 'unknown' : 'unknown';
};

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'note';

/** The bots the consent page lists: Brain (yes unless the person says no), one that asks, and one whose definition does not ask. */
const BOTS = [
  { botId: '00000000-0000-7000-8000-0000000b0001', botSlug: 'brain', botName: 'Brain', canAsk: true, defaultAllowed: true },
  { botId: '00000000-0000-7000-8000-0000000b0002', botSlug: 'planner', botName: 'Planner', canAsk: true, defaultAllowed: false },
  { botId: '00000000-0000-7000-8000-0000000b0003', botSlug: 'support-responder', botName: 'Support responder', canAsk: false, defaultAllowed: false },
] as const;

export function installPersonalMock(on: On, h: PersonalMockHooks): { sendToPersonal: (messageId: string, thread: boolean) => unknown } {
  const people = new Map<string, Mine>();
  const changedAt = new Map<string, string>();

  const front = (type: string, title: string, description: string): string => `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\n---\n\n`;

  const file = (mine: Mine, path: string, content: string, meta: FileState['meta'], authorKind: PersonalMemoryVersion['authorKind'] = 'person'): FileState => {
    const f: FileState = { path, content, versions: [], texts: new Map(), meta };
    f.versions.push({ versionNo: 1, sha256: hex(++mine.counter), sizeBytes: content.length, authorKind, createdAt: h.now });
    f.texts.set(1, content);
    mine.files.push(f);
    return f;
  };

  const mineOf = (): Mine => {
    const who = h.me();
    if (who.role === 'guest') h.fail(403, 'forbidden', 'A guest has no Personal space.');
    let m = people.get(who.id);
    if (!m) {
      m = { files: [], items: [], bases: [], consents: new Map(), counter: 0 };
      people.set(who.id, m);
      file(m, 'people/rafi.md', `${front('Person', 'Rafi', 'Works on the release process.')}Rafi runs the release checklist on Thursdays.\n`, { type: 'Person', title: 'Rafi', description: 'Works on the release process.', tags: ['team'], trustTier: 'unverified', origin: 'person' });
      file(m, 'decisions/ship-on-friday.md', `${front('Decision', 'Ship on Friday', 'The team ships on Fridays.')}We ship on Friday unless the upgrade test fails.\n`, { type: 'Decision', title: 'Ship on Friday', description: 'The team ships on Fridays.', tags: [], trustTier: 'human-reviewed', origin: 'person' });
      file(m, 'references/standup-notes-7c1d9e02.md', `${front('Reference', 'Standup notes', 'The full text of a note from the inbox.')}Standup, Monday: the upgrade test is green.\n`, { type: 'Reference', title: 'Standup notes', description: 'The full text of a note from the inbox.', tags: [], trustTier: 'unverified', origin: 'drop' }, 'system');
      m.items.push(
        item(m, { name: 'Standup notes', kind: 'markdown', state: 'filed', filedPaths: ['references/standup-notes-7c1d9e02.md'], filedAt: h.now }),
        item(m, { name: 'partner-export.zip', kind: 'bundle', state: 'held', holdReason: 'foreign_bundle', reason: 'It looks like a memory bundle from somewhere else. A bundle cannot be imported into your memory, so letting it through will fail.' }),
        item(m, { name: 'whiteboard.png', kind: 'image', state: 'failed', reason: 'Pictures cannot be read yet.', attempts: 1 }),
      );
      m.items.reverse();
    }
    return m;
  };

  const personId = (): string => h.me().id;

  const item = (m: Mine, init: Partial<PersonalInboxItem> & Pick<PersonalInboxItem, 'name' | 'kind' | 'state'>): PersonalInboxItem => {
    m.counter += 1;
    return PersonalInboxItem.parse({
      id: h.nextId(), personId: personId(), space: `person:${personId()}`, origin: 'person', size: 2048, sha256: hex(m.counter), droppedBy: null, droppedByName: null, teamOnly: false,
      reason: null, holdReason: null, duplicateOf: null, parentId: null, sender: null, senderCheck: null, filedPaths: [], commitSha: null, originalKept: true, attempts: 0,
      createdAt: h.now, updatedAt: h.now, filedAt: null, ...init,
    });
  };
  const touch = (i: PersonalInboxItem, patch: Partial<PersonalInboxItem>): PersonalInboxItem => Object.assign(i, patch, { updatedAt: h.now });
  const findItem = (m: Mine, id: string | undefined): PersonalInboxItem => {
    const found = m.items.find((i) => i.id === id);
    if (!found) h.fail(404, 'not_found', 'No such item in your inbox');
    return found;
  };

  const summary = (f: FileState): MemoryConceptSummary => ({
    path: f.path, type: f.meta.type, title: f.meta.title, description: f.meta.description, tags: f.meta.tags, status: 'stable', staleAfter: null, trustTier: f.meta.trustTier,
    origin: f.meta.origin, shareNever: false, fromTeam: null, space: `person:${personId()}` as MemoryConceptSummary['space'], blobSha: 'a'.repeat(40), generatedAt: h.now,
  });
  const body = (f: FileState) => {
    const v = f.versions.at(-1);
    return { path: f.path, content: f.content, versionNo: v?.versionNo ?? 1, sizeBytes: f.content.length, updatedAt: v?.createdAt ?? h.now };
  };
  const findFile = (m: Mine, path: string | null | undefined): FileState => {
    const found = m.files.find((f) => f.path === path);
    if (!found) h.fail(404, 'not_found', `You have no memory file “${String(path)}”.`);
    return found;
  };
  const put = (m: Mine, path: string, content: string, authorKind: PersonalMemoryVersion['authorKind'] = 'person'): FileState => {
    const f = findFile(m, path);
    const no = (f.versions.at(-1)?.versionNo ?? 0) + 1;
    f.content = content;
    f.versions.push({ versionNo: no, sha256: hex(++m.counter), sizeBytes: content.length, authorKind, createdAt: h.now });
    f.texts.set(no, content);
    if (f.versions.length > 50) f.versions.shift();
    return f;
  };

  // ---- Personal memory -------------------------------------------------------------------------------------------------------
  on(listPersonalMemoryRoute, () => ({ items: mineOf().files.map(summary) }));
  on(getPersonalMemoryFileRoute, ({ query }) => ({ file: body(findFile(mineOf(), query.get('path'))) }));
  on(writePersonalMemoryRoute, ({ body: b }) => {
    const m = mineOf();
    const path = String(b['path'] ?? '');
    const content = String(b['content'] ?? '');
    if (!path.endsWith('.md')) h.fail(400, 'validation_failed', `“${path}”: only Markdown files (.md) belong in a memory bundle`);
    if (!content.startsWith('---\n') || !/^type:\s*\S/m.test(content)) h.fail(400, 'validation_failed', `“${path}”: the file needs a front block with a type`);
    const existing = m.files.find((f) => f.path === path);
    const base = b['baseVersion'];
    if (existing && base !== undefined && base !== null && base !== existing.versions.at(-1)?.versionNo) {
      h.fail(409, 'conflict', `“${path}” changed since you opened it (it is at version ${String(existing.versions.at(-1)?.versionNo)}). Open it again and redo your edit.`);
    }
    if (!existing) {
      const title = /^title:\s*(.+)$/m.exec(content)?.[1] ?? path;
      file(m, path, content, { type: /^type:\s*(.+)$/m.exec(content)?.[1] ?? 'Fact', title, description: /^description:\s*(.+)$/m.exec(content)?.[1] ?? null, tags: [], trustTier: 'human-reviewed', origin: 'person' });
    } else {
      put(m, path, content);
      existing.meta.title = /^title:\s*(.+)$/m.exec(content)?.[1] ?? existing.meta.title;
      existing.meta.trustTier = 'human-reviewed';
    }
    const f = findFile(m, path);
    return { file: body(f), concept: summary(f) };
  });
  on(deletePersonalMemoryRoute, ({ query }) => {
    const m = mineOf();
    const f = findFile(m, query.get('path'));
    m.files.splice(m.files.indexOf(f), 1);
    return { removed: true };
  });
  on(listPersonalMemoryVersionsRoute, ({ query }) => ({ items: [...findFile(mineOf(), query.get('path')).versions].reverse() }));
  on(restorePersonalMemoryRoute, ({ body: b }) => {
    const m = mineOf();
    const f = findFile(m, String(b['path'] ?? ''));
    const text = f.texts.get(Number(b['versionNo']));
    if (text === undefined) h.fail(404, 'not_found', `“${f.path}” has no saved version ${String(b['versionNo'])}.`);
    put(m, f.path, text);
    return { file: body(f), concept: summary(f) };
  });

  // ---- the person's own inbox ------------------------------------------------------------------------------------------------
  const advance = (m: Mine): void => {
    for (const i of m.items) {
      if (i.state === 'queued' && i.kind === 'image') touch(i, { state: 'failed', reason: 'Pictures cannot be read yet.', attempts: 1 });
      else if (i.state === 'queued') touch(i, { state: 'filing' });
      else if (i.state === 'filing') {
        const path = `references/${slugOf(i.name)}-${i.id.slice(-8)}.md`;
        file(m, path, `${front('Reference', i.name, 'Filed from the inbox.')}Text of ${i.name}.\n`, { type: 'Reference', title: i.name, description: 'Filed from the inbox.', tags: [], trustTier: 'unverified', origin: 'drop' }, 'system');
        touch(i, { state: 'filed', filedPaths: [path], filedAt: h.now, commitSha: null });
      }
    }
  };

  const drop = (m: Mine, name: string, size: number, kind: InboxKind, extra: Partial<PersonalInboxItem> = {}): Reply => {
    if (kind === 'unknown') h.fail(400, 'validation_failed', 'That kind of file cannot be dropped. Markdown, text, CSV, PDF, Word, PowerPoint, Excel and email files can; pictures and recordings are kept but cannot be read yet.');
    const same = m.items.find((i) => i.name === name && i.size === size && i.state !== 'discarded');
    if (same) return { status: 200, body: { item: item(m, { name, kind, state: 'duplicate', size, duplicateOf: same.id }), duplicate: true } };
    const made = item(m, { name, kind, size, state: 'queued', ...extra });
    if (kind === 'bundle') Object.assign(made, { state: 'held', holdReason: 'foreign_bundle', reason: 'It looks like a memory bundle from somewhere else. A bundle cannot be imported into your memory, so letting it through will fail.' });
    else if (kind === 'image') Object.assign(made, { state: 'failed', reason: 'Pictures cannot be read yet.', attempts: 1 });
    m.items.unshift(made);
    return created({ item: made, duplicate: false });
  };

  on(listPersonalInboxRoute, ({ query }) => {
    const m = mineOf();
    advance(m);
    const state = query.get('state');
    return { items: m.items.filter((i) => (state ? i.state === state : i.state !== 'discarded')), maxBytes: 25 * 1024 * 1024 };
  });
  on(getPersonalInboxItemRoute, ({ params }) => ({ item: findItem(mineOf(), params['itemId']) }));
  on(uploadPersonalInboxRoute, ({ query, body: b }) => {
    const m = mineOf();
    const name = String(b['name'] ?? query.get('name') ?? '').trim();
    if (name === '') h.fail(400, 'validation_failed', 'Say what the file is called (the name= part of the address).');
    const size = Number(b['size'] ?? 1024);
    if (size === 0) h.fail(400, 'validation_failed', 'That file is empty.');
    return drop(m, name, size, kindOfName(name));
  });
  on(createPersonalInboxNoteRoute, ({ body: b }) => {
    const m = mineOf();
    const text = String(b['text'] ?? '').trim();
    if (text === '') h.fail(400, 'validation_failed', 'Write something in the note.');
    const title = typeof b['title'] === 'string' && b['title'].trim() !== '' ? b['title'].trim() : null;
    const isLink = /^https?:\/\/\S+$/.test(text);
    const first = text.split('\n').find((l) => l.trim() !== '') ?? 'Note';
    const name = (title ?? (isLink ? text : first.replace(/^[#>*\-\s]+/, '').trim().slice(0, 80))) || 'Note';
    return drop(m, name, text.length, isLink ? 'link' : 'markdown');
  });
  on(releasePersonalInboxRoute, ({ params }) => {
    const i = findItem(mineOf(), params['itemId']);
    if (i.state !== 'held') h.fail(409, 'conflict', 'Only a held item can be let through.');
    // a memory bundle cannot be imported into a Personal space: letting it through ends in a plain sentence
    return { item: touch(i, i.kind === 'bundle' ? { state: 'failed', holdReason: null, reason: 'A memory bundle cannot be imported into your memory.', attempts: 1 } : { state: 'queued', reason: null, holdReason: null }) };
  });
  on(discardPersonalInboxRoute, ({ params }) => {
    const i = findItem(mineOf(), params['itemId']);
    if (!['queued', 'held', 'failed'].includes(i.state)) h.fail(409, 'conflict', i.state === 'filed' ? 'This item is a file in your memory now. Delete it there.' : 'This item cannot be discarded any more.');
    return { item: touch(i, { state: 'discarded', reason: null, holdReason: null, originalKept: false }) };
  });
  on(retryPersonalInboxRoute, ({ params }) => {
    const i = findItem(mineOf(), params['itemId']);
    if (i.state !== 'failed') h.fail(409, 'conflict', 'Only an item that failed can be tried again.');
    return { item: touch(i, { state: 'queued', reason: null, attempts: 0 }) };
  });
  on(sendPersonalInboxToTeamRoute, ({ params, body: b }) => {
    const m = mineOf();
    const i = findItem(m, params['itemId']);
    h.team(String(b['teamSlug'] ?? ''));
    if (!i.originalKept || i.state === 'held' || i.state === 'discarded' || i.state === 'duplicate') h.fail(409, 'conflict', 'This item cannot be sent to a team any more.');
    return created({ teamItemId: h.nextId(), duplicate: false });
  });

  // ---- personal knowledge bases ----------------------------------------------------------------------------------------------
  const baseOf = (m: Mine, slug: string | undefined): BaseState => {
    const found = m.bases.find((b) => b.base.slug === slug);
    if (!found) h.fail(404, 'not_found', `You have no knowledge base called “${String(slug)}”.`);
    return found;
  };
  const recount = (b: BaseState): void => {
    const indexed = b.docs.filter((d) => d.doc.status === 'indexed');
    b.base = { ...b.base, documentCount: b.docs.length, indexedCount: indexed.length, failedCount: b.docs.length - indexed.length, chunkCount: indexed.reduce((n, d) => n + d.doc.chunkCount, 0), state: b.docs.length === 0 ? 'empty' : indexed.length < b.docs.length ? 'attention' : 'ready', lastIndexedAt: indexed.length > 0 ? h.now : null };
  };
  const newBase = (slug: string, name: string): BaseState => ({
    base: PersonalKnowledgeBase.parse({
      id: h.nextId(), personId: personId(), space: `person:${personId()}`, slug, name, state: 'empty', documentCount: 0, indexedCount: 0, failedCount: 0, chunkCount: 0, lastIndexedAt: null, createdAt: h.now,
    }),
    docs: [],
  });
  const addDoc = (b: BaseState, name: string, size: number, text: string, kind: KnowledgeDocument['kind']): { outcome: 'added' | 'updated' | 'unchanged' | 'failed'; doc: DocState['doc'] } => {
    const same = b.docs.find((d) => d.doc.name === name);
    const sha = hex(size + name.length).slice(0, 12);
    if (same && same.doc.shortHash === sha) return { outcome: 'unchanged', doc: same.doc };
    const failed = kind === 'pdf' && size === 0;
    const doc = KnowledgeDocument.omit({ repoPath: true }).parse({
      id: h.nextId(), baseId: b.base.id, name, kind, source: 'upload' as const, size, shortHash: sha, version: (same?.doc.version ?? 0) + 1, status: failed ? ('failed' as const) : ('indexed' as const),
      reason: failed ? 'The PDF has no text to read.' : 'This copy lives in your Personal space only.', chunkCount: failed ? 0 : Math.max(1, Math.ceil(text.length / 400)), indexedAt: failed ? null : h.now, updatedAt: h.now,
    });
    if (same) Object.assign(same, { doc, text });
    else b.docs.push({ doc, text });
    recount(b);
    return { outcome: failed ? 'failed' : same ? 'updated' : 'added', doc };
  };

  on(listPersonalKnowledgeBasesRoute, () => {
    const m = mineOf();
    if (m.bases.length === 0 && !m.consents.has('__seeded')) {
      m.consents.set('__seeded', true);
      const b = newBase('handbook', 'Personal handbook');
      addDoc(b, 'travel-policy.md', 1800, 'Flights over four hours may be booked in premium economy. Ask a lead for anything else.', 'markdown');
      m.bases.push(b);
    }
    return { bases: m.bases.map((b) => b.base), searchMode: 'lexical' };
  });
  on(createPersonalKnowledgeBaseRoute, ({ body: b }) => {
    const m = mineOf();
    const slug = String(b['slug'] ?? '');
    if (m.bases.some((x) => x.base.slug === slug)) h.fail(409, 'conflict', `You already have a knowledge base called “${slug}”.`);
    if (m.bases.length >= 10) h.fail(409, 'conflict', 'You already have the most knowledge bases you can have (10).');
    const made = newBase(slug, typeof b['name'] === 'string' && b['name'].trim() !== '' ? b['name'].trim() : slug);
    m.bases.push(made);
    return created({ base: made.base });
  });
  on(getPersonalKnowledgeBaseRoute, ({ params }) => {
    const b = baseOf(mineOf(), params['base']);
    return { base: b.base, documents: b.docs.map((d) => d.doc), sources: [{ id: h.nextId(), kind: 'upload', url: null, label: null, syncMinutes: null, lastSyncedAt: null, error: null }], searchMode: 'lexical' };
  });
  on(deletePersonalKnowledgeBaseRoute, ({ params }) => {
    const m = mineOf();
    const b = baseOf(m, params['base']);
    m.bases.splice(m.bases.indexOf(b), 1);
    return { removed: true, documents: b.docs.length };
  });
  on(uploadPersonalKnowledgeDocumentRoute, ({ params, query, body: b }) => {
    const base = baseOf(mineOf(), params['base']);
    const name = String(b['name'] ?? query.get('name') ?? '').trim();
    if (name === '') h.fail(400, 'validation_failed', 'Say what the file is called (the name= part of the address).');
    const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
    const kind: KnowledgeDocument['kind'] | null = ext === 'md' || ext === 'markdown' ? 'markdown' : ext === 'txt' ? 'text' : ext === 'csv' ? 'csv' : ext === 'pdf' ? 'pdf' : null;
    if (!kind) h.fail(415, 'validation_failed', 'That kind of file cannot be read. Markdown, text, CSV and PDF files can.');
    if (base.docs.length >= 200) h.fail(409, 'conflict', 'This base already holds the most documents it can (200).');
    const size = Number(b['size'] ?? 1024);
    const text = typeof b['text'] === 'string' ? b['text'] : `${name} ${name.replace(/[-_.]+/g, ' ')}`;
    const out = addDoc(base, name, size, text, kind);
    return created({ outcome: out.outcome, document: out.doc });
  });
  on(deletePersonalKnowledgeDocumentRoute, ({ params }) => {
    const base = baseOf(mineOf(), params['base']);
    const d = base.docs.find((x) => x.doc.id === params['documentId']);
    if (!d) h.fail(404, 'not_found', 'That document is not in this knowledge base.');
    base.docs.splice(base.docs.indexOf(d), 1);
    recount(base);
    return { removed: true };
  });
  on(searchPersonalKnowledgeRoute, ({ params, query }) => {
    const base = baseOf(mineOf(), params['base']);
    const words = (query.get('q') ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (words.length === 0) h.fail(400, 'validation_failed', 'Ask with at least two letters.');
    const hits = base.docs
      .filter((d) => d.doc.status === 'indexed')
      .map((d) => ({ d, score: words.filter((w) => d.text.toLowerCase().includes(w)).length / words.length }))
      .filter((x) => x.score > 0)
      .map(({ d, score }, n) => ({
        chunkId: h.nextId(), baseSlug: base.base.slug, documentId: d.doc.id, documentName: d.doc.name, documentKind: d.doc.kind, version: d.doc.version, currentVersion: d.doc.version, sourceChanged: false,
        section: null, offsetStart: 0, offsetEnd: d.text.length, text: d.text, score: Math.max(0.05, Math.min(1, score - n * 0.01)), repoPath: null, space: `person:${personId()}`,
      }));
    return { mode: 'lexical', hits };
  });

  // ---- which bots may read Personal ------------------------------------------------------------------------------------------
  const consentOf = (m: Mine, b: (typeof BOTS)[number]): BotPersonalConsent => {
    const said = m.consents.get(b.botId);
    const at = changedAt.get(`${personId()}:${b.botId}`) ?? null;
    return BotPersonalConsent.parse({ botId: b.botId, botSlug: b.botSlug, botName: b.botName, canAsk: b.canAsk, allowed: said ?? b.defaultAllowed, isDefault: said === undefined, changedAt: at });
  };
  on(listBotConsentsRoute, () => {
    const m = mineOf();
    return { items: BOTS.map((b) => consentOf(m, b)) };
  });
  on(setBotConsentRoute, ({ params, body: b }) => {
    const m = mineOf();
    const bot = BOTS.find((x) => x.botId === params['botId']);
    if (!bot) h.fail(404, 'not_found', 'No such bot');
    m.consents.set(bot.botId, b['allowed'] === true);
    changedAt.set(`${personId()}:${bot.botId}`, h.now);
    return { item: consentOf(m, bot) };
  });

  /** Send to memory with `target: 'personal'`: the message (or thread) lands in the signed-in person's own inbox. The Inbox mock hands such a send here. */
  return {
    sendToPersonal: (messageId: string, thread: boolean): unknown => drop(mineOf(), thread ? 'Thread in #general' : 'Message in #general', messageId.length * 100 + (thread ? 1 : 0), 'markdown', { origin: 'message' }),
  };
}
