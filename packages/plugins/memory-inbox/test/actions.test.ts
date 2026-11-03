import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventually, ensureChannels } from '../../channels/test/world.ts';
import { createWorld, personas, type FilesWorld } from '../../files/test/world.ts';
import { resetDropLimits } from '../src/upload.ts';

// P8-20 through the real server: a filed item that produced an Action Items concept lists its actions with a card body ready to send. The card itself is made by the
// signed-in person through the tasks API (never by a bot); the inbox then records which action it was. The click of the Inbox tab does exactly these two calls.

const { omar, nadia, rafi, sameera, lena } = personas;
vi.setConfig({ testTimeout: 120_000 });

let world: FilesWorld;
let itemId = '';
const CONCEPT = 'memory/action-items/q4-planning.md';

interface Action {
  conceptPath: string;
  index: number;
  what: string;
  ownerName: string | null;
  ownerActorId: string | null;
  due: string | null;
  done: boolean;
  prepared: { title: string; description: string; kind: string; priority: string; branch: string };
  taskId: string | null;
  addedBy: string | null;
}
interface Actions {
  actions: Action[];
  canAdd: boolean;
}

const BODY = [
  '# Q4 planning: action items',
  '',
  '- [ ] Write the deploy runbook (owner: Nadia; due: 2026-11-20)',
  '- [ ] Book the offsite (owner: Somebody Unknown)',
  '- [x] Send the minutes (owner: Rafi; due: 2026-11-02)',
  '- [ ] Ask finance about the budget',
  'Not an action line.',
].join('\n');

const actionsOf = (who: typeof omar, id = itemId, team = 'engineering') => world.call<Actions>(who, 'GET', `/api/teams/${team}/inbox/items/${id}/actions`);
const record = (who: typeof omar, body: Record<string, unknown>, id = itemId) => world.call<{ action: Action }>(who, 'POST', `/api/teams/engineering/inbox/items/${id}/actions`, body);
/** What the Inbox tab does on the click: the tasks API, as the signed-in person, with the prepared body. */
const makeCard = async (who: typeof omar, action: Action): Promise<string> => {
  const res = await world.call<{ task: { id: string } }>(who, 'POST', '/api/teams/engineering/tasks', action.prepared);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.task.id;
};

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  // a note, filed by the pipeline; then an Action Items concept committed to the team's memory and named among the item's filed paths
  const dropped = await world.call<{ item: { id: string } }>(nadia, 'POST', '/api/teams/engineering/inbox/notes', { title: 'Q4 planning', text: 'We met about Q4 and agreed on next steps.', teamOnly: false });
  expect(dropped.status, JSON.stringify(dropped.body)).toBe(201);
  itemId = dropped.body.item.id;
  await eventually(async () => ((await world.call<{ item: { state: string } }>(omar, 'GET', `/api/teams/engineering/inbox/items/${itemId}`)).body.item.state === 'filed' ? true : false), 60_000, 'the note to be filed');
  const content = `---\ntype: Action Items\ntitle: Q4 planning actions\nstatus: stable\n---\n\n${BODY}\n`;
  const put = await world.call(omar, 'POST', '/api/teams/engineering/repo/commit', { changes: [{ op: 'put', path: CONCEPT, content }], message: 'Q4 planning actions' });
  expect(put.status, JSON.stringify(put.body)).toBeLessThan(300);
  await world.system((tx) => tx.query(`UPDATE app.memory_inbox_items SET filed_paths = filed_paths || $2::text[] WHERE id = $1`, [itemId, [CONCEPT]]));
}, 180_000);

beforeEach(() => {
  resetDropLimits();
});

afterAll(async () => {
  await world?.close();
});

describe('listing the actions of an item', () => {
  it('reads each action line of an Action Items concept, with the owner as a person of the team when the name is exactly one of them', async () => {
    const res = await actionsOf(nadia);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.canAdd).toBe(true);
    const [a, b, c, d] = res.body.actions;
    expect(res.body.actions).toHaveLength(4);
    expect(a).toMatchObject({ conceptPath: CONCEPT, index: 0, what: 'Write the deploy runbook', ownerName: 'Nadia', ownerActorId: nadia.actorId, due: '2026-11-20', done: false, taskId: null, addedBy: null });
    expect(b).toMatchObject({ index: 1, what: 'Book the offsite', ownerName: 'Somebody Unknown', ownerActorId: null, due: null });
    expect(c).toMatchObject({ index: 2, what: 'Send the minutes', ownerActorId: rafi.actorId, due: '2026-11-02', done: true });
    expect(d).toMatchObject({ index: 3, what: 'Ask finance about the budget', ownerName: null, ownerActorId: null, due: null });
  });

  it('prepares the card body exactly as the tasks API takes it: owner and due date go into the description', async () => {
    const [a, , , d] = (await actionsOf(nadia)).body.actions;
    expect(a!.prepared).toMatchObject({ title: 'Write the deploy runbook', kind: 'other', priority: 'normal', branch: 'main' });
    expect(a!.prepared.description).toContain('Owner: Nadia');
    expect(a!.prepared.description).toContain('Due: 2026-11-20');
    expect(a!.prepared.description).toContain(CONCEPT);
    expect(d!.prepared.description).not.toContain('Owner:');
    expect(d!.prepared.description).not.toContain('Due:');
  });

  it('is empty for an item that filed no Action Items, and is a 404 for an item that is not in the team', async () => {
    const note = await world.call<{ item: { id: string } }>(nadia, 'POST', '/api/teams/engineering/inbox/notes', { text: 'Just a reminder about the offsite.', teamOnly: false });
    const plain = await actionsOf(nadia, note.body.item.id);
    expect(plain.status).toBe(200);
    expect(plain.body.actions).toEqual([]);
    expect((await actionsOf(nadia, randomUUID())).status).toBe(404);
  });

  it('is read by the people of the team only', async () => {
    expect((await actionsOf(sameera)).status).toBeGreaterThanOrEqual(403);
    expect((await actionsOf(lena)).status).toBe(403);
    expect((await fetch(`${world.server.url}/api/teams/engineering/inbox/items/${itemId}/actions`)).status).toBe(401);
  });
});

describe('putting an action on the board', () => {
  let first: Action;
  let cardId: string;

  it('the card is made by the person through the tasks API, then recorded; the action then shows as added', async () => {
    first = (await actionsOf(nadia)).body.actions[0]!;
    cardId = await makeCard(nadia, first);
    const made = await world.system((tx) => tx.query<{ created_by: string }>('SELECT created_by FROM app.tasks WHERE id = $1', [cardId]));
    expect(made.rows[0]!.created_by).toBe(nadia.actorId);
    const res = await record(nadia, { conceptPath: CONCEPT, index: 0, taskId: cardId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.action).toMatchObject({ index: 0, taskId: cardId, addedBy: nadia.actorId });
    const after = (await actionsOf(omar)).body.actions;
    expect(after[0]).toMatchObject({ taskId: cardId, addedBy: nadia.actorId });
    expect(after[1]!.taskId).toBeNull();
  });

  it('recording the same card again changes nothing', async () => {
    const again = await record(nadia, { conceptPath: CONCEPT, index: 0, taskId: cardId });
    expect(again.status).toBe(200);
    expect(again.body.action.taskId).toBe(cardId);
    const rows = await world.system((tx) => tx.query('SELECT 1 FROM app.memory_inbox_actions WHERE item_id = $1', [itemId]));
    expect(rows.rows).toHaveLength(1);
  });

  it('refuses a second card for an action that is already on the board', async () => {
    const other = await makeCard(nadia, { ...first, prepared: { ...first.prepared, title: 'Write the deploy runbook (again)' } });
    expect((await record(nadia, { conceptPath: CONCEPT, index: 0, taskId: other })).status).toBe(409);
  });

  it('refuses a card somebody else made, a card that does not exist, and an action the item does not have', async () => {
    const second = (await actionsOf(nadia)).body.actions[1]!;
    const rafisCard = await makeCard(rafi, second);
    const notYours = await record(nadia, { conceptPath: CONCEPT, index: 1, taskId: rafisCard });
    expect(notYours.status).toBe(400);
    expect(JSON.stringify(notYours.body)).toContain('not one you made');
    expect((await record(nadia, { conceptPath: CONCEPT, index: 1, taskId: randomUUID() })).status).toBe(400);
    expect((await record(nadia, { conceptPath: CONCEPT, index: 9, taskId: rafisCard })).status).toBe(404);
    expect((await record(nadia, { conceptPath: 'memory/other.md', index: 0, taskId: rafisCard })).status).toBe(404);
    // and the right person can still record their own card for it
    expect((await record(rafi, { conceptPath: CONCEPT, index: 1, taskId: rafisCard })).status).toBe(201);
  });

  it('is for people who may post on the team’s board: not a stranger to the team, not a guest', async () => {
    const third = (await actionsOf(nadia)).body.actions[3]!;
    const card = await makeCard(nadia, third);
    expect((await record(sameera, { conceptPath: CONCEPT, index: 3, taskId: card })).status).toBeGreaterThanOrEqual(403);
    expect((await record(lena, { conceptPath: CONCEPT, index: 3, taskId: card })).status).toBe(403);
  });

  it('refuses a malformed request', async () => {
    expect((await record(nadia, { conceptPath: CONCEPT, index: -1, taskId: randomUUID() })).status).toBe(400);
    expect((await record(nadia, { conceptPath: CONCEPT, index: 0 })).status).toBe(400);
    expect((await record(nadia, { conceptPath: CONCEPT, index: 0, taskId: randomUUID(), extra: true })).status).toBe(400);
  });
});
