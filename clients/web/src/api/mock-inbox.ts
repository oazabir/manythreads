import {
  createInboxNoteRoute,
  createTaskRoute,
  discardInboxItemRoute,
  getInboxEmailRoute,
  getInboxItemRoute,
  listInboxActionsRoute,
  listInboxItemsRoute,
  listMemoryConceptsRoute,
  recordInboxActionRoute,
  releaseInboxItemRoute,
  retryInboxItemRoute,
  sendToMemoryRoute,
  setUpInboxMailRoute,
  uploadInboxItemRoute,
  InboxItem,
  Task,
  TaskId,
  type InboxAction,
  type InboxKind,
  type MemoryConceptSummary,
} from '@manythreads/shared';

/*
 * The mock of the Memory screen's Inbox tab (P8-21): the same routes, shapes and words the memory-inbox plugin answers with. A drop starts `queued` and moves
 * one step every time the list is read (queued, filing, filed), so a page that waits for it sees the whole way. A `.zip` is held for a lead (it looks like a memory
 * bundle from elsewhere); a picture is kept but fails, as the server does today. A lead or workspace admin releases, discards and retries; everyone else gets
 * the server's refusals. The workspace mailbox starts off: a workspace admin switches it on (`POST /api/workspace/inbox-mail`) and every team then has an
 * address on it; anyone else is told to ask an admin. The Engineering release notes became an Action Items concept, whose actions can be added to the board: the
 * mock also answers the tasks API's create call (the only task call the Inbox makes), so the click works offline.
 */

type Route = { method: string; path: string };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type On = (route: Route, handler: (c: Ctx) => unknown) => void;
type Reply = { status: number; body: unknown };

export type InboxMockHooks = {
  /** The team behind a slug, as the signed-in person may see it (the same refusals as every team route). */
  team(slug: string | undefined): { id: string; slug: string };
  /** The signed-in person, to name the dropper. */
  me(): { actorId: string; name: string };
  /** A team lead or a workspace admin of the team. */
  canManage(slug: string): boolean;
  /** A workspace admin: the person who may switch the workspace mailbox on. */
  canSetUp(): boolean;
  workspaceId: string;
  nextId(): string;
  now: string;
  fail(status: number, code: 'not_found' | 'conflict' | 'forbidden' | 'validation_failed', message: string): never;
};

const ACTION_CONCEPT = 'memory/action-items/release-2-4-follow-ups.md';

const created = (body: unknown): Reply => ({ status: 201, body });

const kindOfName = (name: string): InboxKind => {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'text';
  if (ext === 'csv') return 'csv';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'eml') return 'eml';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (ext === 'zip') return 'bundle';
  return 'unknown';
};

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'note';

const hex = (n: number): string => n.toString(16).padStart(8, '0').repeat(8);

export function installInboxMock(on: On, h: InboxMockHooks): void {
  const items = new Map<string, InboxItem[]>();
  const concepts = new Map<string, MemoryConceptSummary[]>();
  const seeded = new Set<string>();
  /** The actions of a filed item's Action Items concepts, by item id. */
  const actions = new Map<string, InboxAction[]>();
  const tasks = new Map<string, Task>();
  let mailOn = false;
  let counter = 0;

  const concept = (path: string, title: string, description: string, type?: string): MemoryConceptSummary => ({
    path, type: type ?? (path.includes('/references/') ? 'Reference' : 'Fact'), title, description, tags: [], status: 'stable', staleAfter: null, trustTier: 'unverified', origin: 'drop',
    shareNever: false, fromTeam: null, blobSha: 'a'.repeat(40), generatedAt: h.now,
  });
  const itemsOf = (slug: string): InboxItem[] => {
    let list = items.get(slug);
    if (!list) {
      list = [];
      items.set(slug, list);
    }
    return list;
  };
  const conceptsOf = (slug: string): MemoryConceptSummary[] => {
    let list = concepts.get(slug);
    if (!list) {
      list = [];
      concepts.set(slug, list);
    }
    return list;
  };

  const make = (team: { id: string; slug: string }, init: Partial<InboxItem> & Pick<InboxItem, 'name' | 'kind' | 'state'>): InboxItem => {
    counter += 1;
    const me = h.me();
    return InboxItem.parse({
      id: h.nextId(), teamId: team.id, origin: 'person', size: 2048, sha256: hex(counter), droppedBy: me.actorId, droppedByName: me.name, teamOnly: false, reason: null, holdReason: null,
      duplicateOf: null, parentId: null, sender: null, senderCheck: null, filedPaths: [], commitSha: null, originalKept: true, attempts: 0, createdAt: h.now, updatedAt: h.now, filedAt: null,
      ...init,
    });
  };

  /** The Engineering team starts with one drop in each place the queue can be, so the tab and its filters have something to show. */
  const seed = (team: { id: string; slug: string }): void => {
    if (seeded.has(team.slug)) return;
    seeded.add(team.slug);
    if (team.slug !== 'engineering') return;
    const list = itemsOf(team.slug);
    const cs = conceptsOf(team.slug);
    const filedPaths = [
      'memory/facts/release-process.md',
      'memory/decisions/upgrade-test-on-2-3.md',
      'memory/people/release-captain.md',
      ACTION_CONCEPT,
      'memory/references/release-notes-2-4-7c1d9e02.md',
    ];
    cs.push(
      concept(filedPaths[0] as string, 'Release process', 'A release needs the upgrade test on a 2.3 fixture.'),
      concept(filedPaths[1] as string, 'Run the upgrade test on a 2.3 fixture', 'The decision to test upgrades from 2.3.'),
      concept(filedPaths[2] as string, 'The release captain', 'Who looks after a release.'),
      concept(ACTION_CONCEPT, 'Release 2.4 follow-ups', 'What the release notes left to do.', 'Action Items'),
      concept(filedPaths[4] as string, 'Release notes 2.4', 'The full text of the release notes.'),
    );
    list.push(
      make(team, { name: 'Release notes 2.4.md', kind: 'markdown', state: 'filed', filedPaths, commitSha: 'b'.repeat(40), filedAt: h.now }),
      make(team, { name: 'Design review, Tuesday', kind: 'markdown', state: 'filing', reason: null }),
      make(team, { name: 'partner-export.zip', kind: 'bundle', state: 'held', holdReason: 'foreign_bundle', reason: 'It looks like a memory bundle from somewhere else, and importing one is not available yet.' }),
      make(team, { name: 'Vendor quote.pdf', kind: 'pdf', state: 'needs_review', reason: 'The Archivist’s answer could not be used. A team lead can file the reference only.' }),
      make(team, { name: 'whiteboard.png', kind: 'image', state: 'failed', reason: 'Pictures cannot be read yet.', attempts: 1 }),
    );
    list.reverse();
    const filed = list.find((i) => i.state === 'filed');
    if (filed) {
      const action = (index: number, what: string, ownerName: string | null, due: string | null, done: boolean): InboxAction => ({
        conceptPath: ACTION_CONCEPT, index, what, ownerName, ownerActorId: null, due, done, taskId: null, addedBy: null,
        prepared: {
          title: what.slice(0, 200),
          description: [ownerName ? `Owner: ${ownerName}.` : '', due ? `Due: ${due}.` : '', `From the inbox item ${filed.name}.`].filter((l) => l !== '').join('\n'),
          kind: 'other', priority: 'normal', branch: 'main',
        },
      });
      actions.set(filed.id, [
        action(0, 'Run the upgrade test on a 2.3 fixture', 'Nadia', '2026-11-20', false),
        action(1, 'Write the release announcement', 'Rafi', null, false),
        action(2, 'Update the changelog', null, null, true),
      ]);
    }
  };

  const find = (team: { slug: string }, id: string | undefined): InboxItem => {
    const found = itemsOf(team.slug).find((i) => i.id === id);
    if (!found) h.fail(404, 'not_found', 'No such item in this team’s inbox');
    return found;
  };
  const touch = (i: InboxItem, patch: Partial<InboxItem>): InboxItem => Object.assign(i, patch, { updatedAt: h.now });
  const requireManage = (team: { slug: string }): void => {
    if (!h.canManage(team.slug)) h.fail(403, 'forbidden', 'Only a team lead or a workspace admin can do that.');
  };

  /** One step for every item that is moving. */
  const advance = (team: { id: string; slug: string }): void => {
    for (const i of itemsOf(team.slug)) {
      if (i.state === 'queued' && i.kind === 'image') touch(i, { state: 'failed', reason: 'Pictures cannot be read yet.', attempts: 1 });
      else if (i.state === 'queued') touch(i, { state: 'filing' });
      else if (i.state === 'filing' && i.name !== 'Design review, Tuesday') {
        const base = slugOf(i.name);
        const paths = [`memory/facts/${base}.md`, `memory/references/${base}-${i.id.slice(-8)}.md`];
        for (const p of paths) conceptsOf(team.slug).push(concept(p, p.includes('/references/') ? i.name : `${i.name}: what matters`, 'Filed from the inbox.'));
        touch(i, { state: 'filed', filedPaths: paths, filedAt: h.now, commitSha: 'c'.repeat(40) });
      }
    }
  };

  const drop = (team: { id: string; slug: string }, name: string, size: number, teamOnly: boolean, kind: InboxKind, extra: Partial<InboxItem> = {}): Reply => {
    if (kind === 'unknown') h.fail(400, 'validation_failed', 'That kind of file cannot be dropped. Markdown, text, CSV, PDF, Word, PowerPoint, Excel and email files can; pictures and recordings are kept but cannot be read yet.');
    const list = itemsOf(team.slug);
    const same = list.find((i) => i.name === name && i.size === size && i.state !== 'discarded' && i.origin === (extra.origin ?? 'person'));
    if (same) return { status: 200, body: { item: make(team, { name, kind, state: 'duplicate', size, duplicateOf: same.id, teamOnly }), duplicate: true } };
    const item = make(team, { name, kind, size, teamOnly, state: 'queued', ...extra });
    if (kind === 'bundle') Object.assign(item, { state: 'held', holdReason: 'foreign_bundle', reason: 'It looks like a memory bundle from somewhere else, and importing one is not available yet.' });
    else if (kind === 'image') Object.assign(item, { state: 'failed', reason: 'Pictures cannot be read yet.', attempts: 1 });
    list.unshift(item);
    return created({ item, duplicate: false });
  };

  on(listInboxItemsRoute, ({ params, query }) => {
    const team = h.team(params['slug']);
    seed(team);
    advance(team);
    const state = query.get('state');
    const rows = itemsOf(team.slug).filter((i) => (state ? i.state === state : i.state !== 'discarded'));
    return { items: rows, canManage: h.canManage(team.slug), maxBytes: 25 * 1024 * 1024 };
  });
  on(getInboxItemRoute, ({ params }) => {
    const team = h.team(params['slug']);
    seed(team);
    return { item: find(team, params['itemId']), canManage: h.canManage(team.slug) };
  });

  on(uploadInboxItemRoute, ({ params, query, body }) => {
    const team = h.team(params['slug']);
    seed(team);
    const name = String(body['name'] ?? query.get('name') ?? '').trim();
    if (name === '') h.fail(400, 'validation_failed', 'Say what the file is called (the name= part of the address).');
    const size = Number(body['size'] ?? 1024);
    if (size === 0) h.fail(400, 'validation_failed', 'That file is empty.');
    return drop(team, name, size, body['teamOnly'] === true || query.get('teamOnly') === 'true', kindOfName(name));
  });

  on(createInboxNoteRoute, ({ params, body }) => {
    const team = h.team(params['slug']);
    seed(team);
    const text = String(body['text'] ?? '').trim();
    if (text === '') h.fail(400, 'validation_failed', 'Write something in the note.');
    const title = typeof body['title'] === 'string' && body['title'].trim() !== '' ? body['title'].trim() : null;
    const isLink = /^https?:\/\/\S+$/.test(text);
    const first = text.split('\n').find((l) => l.trim() !== '') ?? 'Note';
    const name = (title ?? (isLink ? text : first.replace(/^[#>*\-\s]+/, '').trim().slice(0, 80))) || 'Note';
    return drop(team, name, text.length, body['teamOnly'] === true, isLink ? 'link' : 'markdown');
  });

  on(sendToMemoryRoute, ({ params, body }) => {
    const team = h.team('engineering');
    seed(team);
    const channel = params['channelId'] ?? 'channel';
    const name = body['thread'] === true ? 'Thread in #general' : 'Message in #general';
    return drop(team, name, channel.length * 100 + (params['messageId'] ?? '').length, body['teamOnly'] === true, 'markdown', { origin: 'message' });
  });

  on(releaseInboxItemRoute, ({ params }) => {
    const team = h.team(params['slug']);
    seed(team);
    requireManage(team);
    const i = find(team, params['itemId']);
    if (i.state !== 'held' && i.state !== 'needs_review') h.fail(409, 'conflict', 'Only a held item, or one that needs review, can be released.');
    return { item: touch(i, { state: 'queued', reason: null, holdReason: null }) };
  });
  on(discardInboxItemRoute, ({ params }) => {
    const team = h.team(params['slug']);
    seed(team);
    requireManage(team);
    const i = find(team, params['itemId']);
    if (!['queued', 'held', 'needs_review', 'failed'].includes(i.state)) h.fail(409, 'conflict', 'This item cannot be discarded any more.');
    return { item: touch(i, { state: 'discarded', reason: null, holdReason: null, originalKept: false }) };
  });
  on(retryInboxItemRoute, ({ params }) => {
    const team = h.team(params['slug']);
    seed(team);
    requireManage(team);
    const i = find(team, params['itemId']);
    if (i.state !== 'failed') h.fail(409, 'conflict', 'Only an item that failed can be tried again.');
    return { item: touch(i, { state: 'queued', reason: null, attempts: 0 }) };
  });

  const RULE = 'Mail from people on this team is filed straight away; mail from anyone else waits for a team lead or a workspace admin.';
  on(getInboxEmailRoute, ({ params }) => {
    const team = h.team(params['slug']);
    seed(team);
    const canSetUp = h.canSetUp();
    if (!mailOn) {
      return {
        address: null, connection: null, allowedSenders: [], rule: RULE, canSetUp,
        reason: canSetUp
          ? 'Email to this team is not switched on yet. Switch it on and every team gets its own address.'
          : 'Email to this team is not switched on yet. Ask a workspace admin to switch it on.',
      };
    }
    return {
      address: `inbox+${team.slug}@mail.kahf.example`, connection: { slug: 'inbox', name: 'Workspace inbox' }, reason: null,
      allowedSenders: team.slug === 'engineering' ? ['partner@vendor.example', '@acme.example'] : [], rule: RULE, canSetUp,
    };
  });
  on(setUpInboxMailRoute, () => {
    if (!h.canSetUp()) h.fail(403, 'forbidden', 'Only a workspace admin can switch the workspace mailbox on.');
    const first = !mailOn;
    mailOn = true;
    return created({ connection: { slug: 'inbox', name: 'Workspace inbox' }, created: first, domain: 'mail.kahf.example' });
  });

  on(listInboxActionsRoute, ({ params }) => {
    const team = h.team(params['slug']);
    seed(team);
    const item = find(team, params['itemId']);
    return { actions: actions.get(item.id) ?? [], canAdd: true };
  });
  on(recordInboxActionRoute, ({ params, body }) => {
    const team = h.team(params['slug']);
    seed(team);
    const item = find(team, params['itemId']);
    const action = (actions.get(item.id) ?? []).find((a) => a.conceptPath === body['conceptPath'] && a.index === body['index']);
    if (!action) h.fail(404, 'not_found', 'No such action in this item.');
    const taskId = String(body['taskId'] ?? '');
    if (!tasks.has(taskId)) h.fail(409, 'conflict', 'That card does not exist.');
    if (action.taskId !== null) h.fail(409, 'conflict', 'That action is already on the board.');
    action.taskId = TaskId.parse(taskId);
    action.addedBy = h.me().actorId;
    return created({ action });
  });

  // the tasks API's create call: the Inbox's "Add to board" makes the card as the signed-in person
  on(createTaskRoute, ({ params, body }) => {
    const team = h.team(params['slug']);
    const title = String(body['title'] ?? '').trim();
    if (title === '') h.fail(400, 'validation_failed', 'A card needs a title.');
    const task = Task.parse({
      id: h.nextId(), workspaceId: h.workspaceId, teamId: team.id, goalId: null, title, description: String(body['description'] ?? ''), state: 'open',
      kind: body['kind'] ?? 'code', priority: body['priority'] ?? 'normal', ownerId: null, branch: String(body['branch'] ?? 'main'), baseSha: null, testedSha: null,
      environmentId: null, boardId: null, threadRootId: null, pullRequest: null, blockerReason: '', reworkCount: 0, handoffCount: 0, createdBy: h.me().actorId,
      createdAt: h.now, updatedAt: h.now, completedAt: null,
    });
    tasks.set(task.id, task);
    return created({ task });
  });

  on(listMemoryConceptsRoute, ({ params }) => {
    const team = h.team(params['slug']);
    seed(team);
    return { items: conceptsOf(team.slug) };
  });
}
