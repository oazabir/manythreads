import { startFakeK8s, type FakeK8s } from '@manythreads/test-utils';
import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * Workspace → Runners → Machine (PLAN P19-08) end to end, with no real cluster. A local double of the Kubernetes API (packages/test-utils `startFakeK8s`) answers
 * the node, pod and volume-claim lists, and the real node-lister of the hermes-pods plugin reads it. The operator's list (the Helm value botRunners.allowedNodes)
 * is set to three of the four machines the double holds.
 *
 * A workspace admin opens the Machine dialog of the team pod runner, picks a machine, sees the plain state line, is asked to confirm a move that makes the work
 * volumes again, cannot pick a machine that is not Ready, and on a one-machine install sees its one machine and the line that says so. A plain member cannot
 * read the machines. The page is read at 390 px.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const PATH = '/settings/workspace/runners';
const POD_LABELS = { 'app.kubernetes.io/component': 'hermes-pod', 'app.kubernetes.io/managed-by': 'manythreads-hermes-pods' };

let stack: Stack;
let k8s: FakeK8s;
let teamId = '';

const machine = (name: string, ready = true): Record<string, unknown> => ({
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name, labels: { 'kubernetes.io/hostname': name } },
  spec: {},
  status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }], allocatable: { cpu: '4', memory: '16Gi' }, nodeInfo: { architecture: 'amd64' } },
});
const row = (page: Page) => page.locator('[data-testid="runner-row"][data-runner="team-pods"]');
const machines = (...nodes: Array<Record<string, unknown>>): void => void k8s.nodes.splice(0, k8s.nodes.length, ...nodes);

test.beforeAll(async () => {
  k8s = await startFakeK8s();
  machines(machine('ubuntu-vm'), machine('worker-2'), machine('worker-3', false), machine('hidden-4'));
  stack = await startStack({
    MANYTHREADS_STACK_SEED: 'repo',
    MANYTHREADS_HERMES_PODS_TEST_K8S_URL: k8s.url,
    MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES: 'ubuntu-vm,worker-2,worker-3',
  });
  teamId = (await stack.sql<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'"))[0]!.id;
});
test.afterAll(async () => {
  await stack?.stop();
  await k8s?.stop();
});

test('an admin picks a machine from the operator\'s list; a machine that is not Ready cannot be picked, and one the operator left out is not shown', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'omar');
  try {
    await api.post('/api/admin/bot-runners', { name: 'team-pods', label: 'Team pods', kind: 'hermes_pod', teams: { teams: [teamId] } });
  } finally {
    await api.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await expect(row(page)).toBeVisible();
    await expect(row(page).getByTestId('runner-place')).toHaveText('The cluster chooses the machine. No team pod has started yet.');

    // from the keyboard: Enter opens it, focus lands inside, Esc closes it and focus goes back to the button
    const open = row(page).getByTestId('runner-node-open');
    await open.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Machine for Team pods' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(':focus')).toHaveCount(1);
    const select = dialog.getByTestId('runner-node-select');
    await expect(select.locator('option')).toHaveText([
      'Let the cluster choose',
      'ubuntu-vm (amd64, offers 4 CPUs and 16 GiB of memory)',
      'worker-2 (amd64, offers 4 CPUs and 16 GiB of memory)',
      'worker-3 (not Ready, amd64, offers 4 CPUs and 16 GiB of memory)',
    ]);
    // a machine the operator did not list is nowhere on the page, and a machine that is not Ready cannot be chosen
    expect(await page.content()).not.toContain('hidden-4');
    await expect(select.locator('option', { hasText: 'worker-3' })).toBeDisabled();
    await expect(dialog.getByTestId('runner-node-save')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(open).toBeFocused();

    // choosing one saves it with no question (no work volume is anywhere yet)
    await open.click();
    await page.getByTestId('runner-node-select').selectOption('ubuntu-vm');
    await page.getByTestId('runner-node-save').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('runner-status')).toContainText('Team pods will run on ubuntu-vm.');
    await expect(row(page).getByTestId('runner-place')).toHaveText('Set to run on ubuntu-vm. No team pod has started yet.');
  } finally {
    await context.close();
  }
  const rows = await stack.sql<{ node: string | null }>("SELECT node FROM app.bot_runners WHERE name = 'team-pods'");
  expect(rows[0]?.node).toBe('ubuntu-vm');
});

test('a running pod is shown with its machine, and a move to another machine asks first in plain words', async ({ browser, playwright }) => {
  k8s.pods.push({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'hermes-eng-a', namespace: 'manythreads-bots', labels: { ...POD_LABELS, 'manythreads.io/team-id': teamId } }, spec: { nodeName: 'ubuntu-vm' }, status: { phase: 'Running' } });
  k8s.claims.push({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'hermes-eng-workspace', namespace: 'manythreads-bots', labels: { ...POD_LABELS, 'manythreads.io/team-id': teamId }, annotations: { 'volume.kubernetes.io/selected-node': 'ubuntu-vm' } },
  });
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await expect(row(page).getByTestId('runner-place')).toHaveText('Running on ubuntu-vm');
    await expect(row(page).getByTestId('runner-place')).toHaveAttribute('data-state', 'running');

    await row(page).getByTestId('runner-node-open').click();
    const dialog = page.getByRole('dialog', { name: 'Machine for Team pods' });
    await expect(dialog.getByTestId('runner-node-state')).toHaveText('Running on ubuntu-vm');
    await expect(dialog.getByTestId('runner-node-select').locator('option', { hasText: 'ubuntu-vm' })).toContainText('has the work volume');
    await dialog.getByTestId('runner-node-select').selectOption('worker-2');
    await dialog.getByTestId('runner-node-save').click();

    // the question names what is lost and what is kept; Back goes back without saving
    const sure = page.getByRole('dialog', { name: 'Move Team pods to worker-2?' });
    await expect(sure).toBeVisible();
    await expect(sure.getByTestId('runner-node-warning')).toContainText('deleted and made again, empty, on worker-2');
    await expect(sure.getByTestId('runner-node-warning')).toContainText('not yet pushed');
    await expect(sure.getByTestId('runner-node-warning')).toContainText('The keys are kept');
    await sure.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('dialog', { name: 'Machine for Team pods' })).toBeVisible();
    expect((await stack.sql<{ node: string | null }>("SELECT node FROM app.bot_runners WHERE name = 'team-pods'"))[0]?.node).toBe('ubuntu-vm');

    await page.getByTestId('runner-node-save').click();
    await page.getByTestId('runner-node-confirm').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('runner-status')).toContainText('Team pods will run on worker-2. Its work volumes are being made again there.');
  } finally {
    await context.close();
  }
  expect((await stack.sql<{ node: string | null }>("SELECT node FROM app.bot_runners WHERE name = 'team-pods'"))[0]?.node).toBe('worker-2');
  // the change is one event, and it holds no machine name
  const events = await stack.sql<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'bot_runner.node.changed' ORDER BY id");
  expect(events).toHaveLength(2);
  expect(events[1]!.payload).toMatchObject({ wasPinned: true, isPinned: true, recreatesWorkVolume: true });
  expect(JSON.stringify(events)).not.toMatch(/ubuntu-vm|worker-2/);
});

test('a chosen machine that stops being Ready is said so on the row, and the Pending pod is not blamed on anything it said', async ({ browser, playwright }) => {
  machines(machine('ubuntu-vm'), machine('worker-2', false), machine('worker-3', false));
  k8s.pods.length = 0;
  k8s.pods.push({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'hermes-eng-b', namespace: 'manythreads-bots', labels: { ...POD_LABELS, 'manythreads.io/team-id': teamId } },
    spec: {},
    status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'node 10.1.2.3 had an untolerated taint' }] },
  });
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await expect(row(page).getByTestId('runner-place')).toHaveText('Waiting: node worker-2 is not Ready');
    await expect(row(page).getByTestId('runner-place')).toHaveAttribute('data-state', 'waiting');
    expect(await page.content()).not.toContain('10.1.2.3');
    // the machine already chosen stays in the select, though it is not Ready, so the dialog does not show a choice nobody made
    await row(page).getByTestId('runner-node-open').click();
    await expect(page.getByTestId('runner-node-select')).toHaveValue('worker-2');
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

test('a machine changed by something else waits for the admin: nothing is moved, the row says so, and the Machine dialog confirms it', async ({ browser, playwright }) => {
  machines(machine('ubuntu-vm'), machine('worker-2'), machine('worker-3', false));
  k8s.pods.length = 0;
  const claim = k8s.claims[0] as { metadata: { annotations: Record<string, string> } };
  delete claim.metadata.annotations['manythreads.io/move-confirmed'];
  // what the controller leaves on the Deployment while the volumes are on another machine and nobody confirmed the move
  k8s.deployments.push({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'hermes-eng', namespace: 'manythreads-bots', labels: { ...POD_LABELS, 'manythreads.io/team-id': teamId }, annotations: { 'manythreads.io/move-held': 'worker-2' } },
  });
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await expect(row(page).getByTestId('runner-place')).toHaveText('Waiting: the machine for this pod changed, and nothing has been moved. Open Machine and confirm the move.');
    await row(page).getByTestId('runner-node-open').click();
    const dialog = page.getByRole('dialog', { name: 'Machine for Team pods' });
    // the machine in the select is the one already saved, yet the button is there: it opens the question
    await expect(dialog.getByTestId('runner-node-select')).toHaveValue('worker-2');
    await expect(dialog.getByTestId('runner-node-save')).toHaveText('Review the move');
    await dialog.getByTestId('runner-node-save').click();
    const sure = page.getByRole('dialog', { name: 'Move Team pods to worker-2?' });
    await expect(sure.getByTestId('runner-node-warning')).toContainText('deleted and made again, empty, on worker-2');
    // focus goes to the button that goes on when the select is gone, and back to the select on Back
    await expect(sure.getByTestId('runner-node-confirm')).toBeFocused();
    await sure.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByTestId('runner-node-select')).toBeFocused();
    expect(claim.metadata.annotations['manythreads.io/move-confirmed']).toBeUndefined();

    await page.getByTestId('runner-node-save').click();
    await page.getByTestId('runner-node-confirm').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await context.close();
  }
  // the confirmation is on the claim, for the machine named and no other
  expect(claim.metadata.annotations['manythreads.io/move-confirmed']).toMatch(/^worker-2@\d+$/);
});

test('a one-machine install shows its one machine and says there is nothing to choose', async ({ browser, playwright }) => {
  machines(machine('ubuntu-vm'));
  k8s.pods.length = 0;
  k8s.claims.length = 0;
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await row(page).getByTestId('runner-node-open').click();
    const dialog = page.getByRole('dialog', { name: 'Machine for Team pods' });
    await expect(dialog.getByTestId('runner-node-select').locator('option')).toHaveCount(3); // the cluster's choice, the one machine, and the one saved earlier that is gone
    await expect(dialog).toContainText('This install has one machine, ubuntu-vm. There is nothing to choose; every pod runs there.');
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

test('with no cluster answering, the dialog says so in a sentence and offers nothing it cannot do', async ({ browser, playwright }) => {
  machines(machine('ubuntu-vm'));
  k8s.failNext(2);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await row(page).getByTestId('runner-node-open').click();
    const dialog = page.getByRole('dialog', { name: 'Machine for Team pods' });
    await expect(dialog.getByTestId('runner-node-note')).toContainText('The cluster did not answer');
    expect(await page.content()).not.toContain('forced failure');
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

test('a plain member cannot read the machines or choose one', async ({ playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    expect([403, 404]).toContain(await nadia.status('GET', '/api/admin/bot-runners/nodes'));
  } finally {
    await nadia.ctx.dispose();
  }
});

test('at 390 px nothing scrolls sideways, on the row and in the Machine dialog', async ({ browser, playwright }) => {
  machines(machine('ubuntu-vm'), machine('worker-2'));
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH, { viewport: PHONE, mobile: true });
  try {
    await expect(row(page)).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await row(page).getByTestId('runner-node-open').click();
    await expect(page.getByRole('dialog', { name: 'Machine for Team pods' })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    const box = await page.getByRole('dialog').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});
