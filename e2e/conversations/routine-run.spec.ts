import { expect, test } from '@playwright/test';
import { PERSONAL_ROUTINE_STOP_WORDS } from '@manythreads/shared';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { channelsOf, openOn } from '../support/stack-browser.ts';
import { uploadAs } from '../files/personal-support.ts';
import { addKeeper, listRoutines, makeDue, makeRoutine, messageOf, patchRoutine, personalText, routineStackEnv, runRoutine, settledRun, tick } from '../settings/routine-support.ts';
import { apiOn } from './support.ts';

/*
 * What a personal routine's run may do (PLAN P20-14, D10), through the real gateway and a stand-in Hermes (fake-hermes-routine.mjs), with the routine's prompt as the
 * script. A routine is a run of a bot with the person asking, in the person's own conversation:
 *   - what it reads is what the OWNER could read, and nobody else's;
 *   - a write other than the notes (memory.write, memory.retain) waits for the owner as a pending approval and is not made;
 *   - it has a budget of tool calls for one run;
 *   - when the owner's spending allowance for the month is used up it is stopped, and refused again until the allowance is raised.
 *
 * Gap, on purpose: memory.write and memory.retain (the two writes a routine may make without asking) need the memory service (Hindsight), which no e2e stack runs; that
 * the gateway lets exactly those two through is a unit test (gateway-mcp/test/personal-routine.test.ts). A live check is in docs/testing.md.
 */
test.skip(({ isMobile }) => isMobile, 'a server-side rule; no layout is under test (the routines screen has its own specs)');
test.describe.configure({ mode: 'serial' });

const NADIA_SECRET = 'ZEBRA-N-4471';
const RAFI_SECRET = 'ZEBRA-R-9023';
const RAFI_ONLY = 'OKAPI-R-5512';

let stack: Stack;
let keeperId = '';
test.beforeAll(async ({ playwright }) => {
  stack = await startStack(routineStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  const nadia = await apiOn(playwright, stack, 'nadia');
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    keeperId = await addKeeper(stack, omar, [nadia, rafi]);
    await uploadAs(nadia, 'Notes', 'espresso.md', `# Espresso\n\nThe grinder setting is ${NADIA_SECRET}.\n`);
    await uploadAs(rafi, 'Notes', 'espresso.md', `# Espresso\n\nThe grinder setting is ${RAFI_SECRET}.\n`);
    await uploadAs(rafi, 'Notes', 'rafi-only.md', `# Private\n\nThe code word is ${RAFI_ONLY}.\n`);
  } finally {
    await omar.ctx.dispose();
    await nadia.ctx.dispose();
    await rafi.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

/** The text a routine's run saved in its output file, once it is there. */
async function outputOf(api: Awaited<ReturnType<typeof apiOn>>, path: string): Promise<string> {
  let text: string | null = null;
  await expect
    .poll(
      async () => {
        text = await personalText(api, path);
        return text !== null;
      },
      { timeout: 30_000, message: `the output file ${path}` },
    )
    .toBe(true);
  return text!;
}

test('a routine reads what its owner could read and nothing of anyone else’s', async ({ playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    const mine = await makeRoutine(nadia, 'Read mine', { botSlug: 'keeper', prompt: 'ROUTINE-READ Notes/espresso.md TAG-n1', outputPath: 'Routines/read-mine/output.md' });
    const his = await makeRoutine(rafi, 'Read his', { botSlug: 'keeper', prompt: 'ROUTINE-READ Notes/espresso.md TAG-r1', outputPath: 'Routines/read-his/output.md' });
    // Nadia asks her routine for a file that only Rafi has
    const reach = await makeRoutine(nadia, 'Read his file', { botSlug: 'keeper', prompt: 'ROUTINE-READ Notes/rafi-only.md TAG-n2', outputPath: 'Routines/read-his-file/output.md' });
    for (const [api, r] of [[nadia, mine], [rafi, his], [nadia, reach]] as const) {
      const res = await runRoutine(api, r.id);
      expect(res.status(), await res.text()).toBe(202);
      expect((await settledRun(api, r.id)).status).toBe('done');
    }

    const nadiaOut = await outputOf(nadia, mine.outputPath);
    expect(nadiaOut).toContain('ROUTINE-OUT TAG-n1');
    expect(nadiaOut).toContain(NADIA_SECRET);
    expect(nadiaOut).not.toContain(RAFI_SECRET);

    const rafiOut = await outputOf(rafi, his.outputPath);
    expect(rafiOut).toContain('ROUTINE-OUT TAG-r1');
    expect(rafiOut).toContain(RAFI_SECRET);
    expect(rafiOut).not.toContain(NADIA_SECRET);

    // a path that exists only in his space is simply not there for her routine
    const reachOut = await outputOf(nadia, reach.outputPath);
    expect(reachOut).toContain('ROUTINE-OUT TAG-n2');
    expect(reachOut).not.toContain(RAFI_ONLY);

    // and the run says what it read, as kinds and counts, never the text
    const run = await settledRun(nadia, mine.id);
    expect(JSON.stringify(run.sourcesUsed)).not.toContain(NADIA_SECRET);
  } finally {
    await nadia.ctx.dispose();
    await rafi.ctx.dispose();
  }
});

test('a routine without the owner’s yes to Personal reads none of it, and is stopped on the next tick', async ({ playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    const r = await makeRoutine(nadia, 'Read then withdrawn', { botSlug: 'keeper', prompt: 'ROUTINE-READ Notes/espresso.md TAG-n3', outputPath: 'Routines/withdrawn/output.md' });
    const res = await nadia.ctx.put(`/api/me/bot-consents/${keeperId}`, { data: { allowed: false }, headers: await nadia.headers() });
    expect(res.status()).toBe(200);
    try {
      // the run is refused up front, with the sentence of the reason
      const blocked = await runRoutine(nadia, r.id);
      expect(blocked.status()).toBe(409);
      expect(await messageOf(blocked)).toContain('cannot read your Personal space');
      await makeDue(stack, r.id);
      await tick(stack);
      expect((await listRoutines(nadia)).items.find((x) => x.id === r.id)).toMatchObject({ enabled: false, stoppedReason: 'consent_withdrawn' });
      expect(await personalText(nadia, r.outputPath)).toBeNull();
    } finally {
      const back = await nadia.ctx.put(`/api/me/bot-consents/${keeperId}`, { data: { allowed: true }, headers: await nadia.headers() });
      expect(back.status()).toBe(200);
    }
  } finally {
    await nadia.ctx.dispose();
  }
});

/*
 * OPEN (needs an owner decision, found by P20-RUN): the plan says the held write becomes a pending approval for the owner. It does not: the run is in the owner's own
 * private conversation, the requester never decides her own approval, and nobody else can read that conversation, so `app.approvals_request` refuses it (AP001,
 * "Nobody but you could decide this call"). The write is still not made (the property below), but the owner gets no card to approve. Making her able to decide a card of her
 * own routine changes the approvals rule "the requester never decides"; until that is decided the card half is a fixme.
 */
test('a write other than the notes is not made by a routine', async ({ playwright }) => {
  test.setTimeout(120_000);
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    const dev = (await channelsOf(nadia))['dev']!;
    const r = await makeRoutine(nadia, 'Post for me', { botSlug: 'keeper', prompt: `ROUTINE-POST ${dev} routine-posted-this TAG-p1`, outputPath: 'Routines/post/output.md' });
    const res = await runRoutine(nadia, r.id);
    expect(res.status(), await res.text()).toBe(202);
    const run = await settledRun(nadia, r.id);
    expect(run.runId).not.toBeNull();

    // the call was turned away, and the run saw that (its output carries the refusal, not a posted message)
    expect(await outputOf(nadia, r.outputPath)).toContain('"ok":false');
    const posted = await stack.sql<{ n: string }>(`SELECT count(*) AS n FROM app.messages WHERE channel_id = $1 AND body LIKE '%routine-posted-this%'`, [dev]);
    expect(Number(posted[0]!.n)).toBe(0);
  } finally {
    await nadia.ctx.dispose();
  }
});

test.fixme('a write other than the notes waits for the owner: it becomes a pending approval and is not made', async ({ playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    const dev = (await channelsOf(nadia))['dev']!;
    const r = await makeRoutine(nadia, 'Post for me too', { botSlug: 'keeper', prompt: `ROUTINE-POST ${dev} routine-posted-that TAG-p2`, outputPath: 'Routines/post2/output.md' });
    const res = await runRoutine(nadia, r.id);
    expect(res.status(), await res.text()).toBe(202);
    const run = await settledRun(nadia, r.id);
    // the call was filed for her to approve, naming the tool
    await expect
      .poll(async () => (await stack.sql<{ status: string }>(`SELECT status FROM app.approvals WHERE run_id = $1 AND tool = 'messages.post'`, [run.runId]))[0]?.status, {
        timeout: 30_000,
        message: 'a pending approval for the held write',
      })
      .toBe('pending');
    expect((await stack.sql<{ status: string }>('SELECT status FROM app.bot_runs WHERE id = $1', [run.runId]))[0]?.status).toBe('stopped');
  } finally {
    await nadia.ctx.dispose();
  }
});

test('a run has a budget of 40 tool calls; the next one is turned away with a sentence', async ({ playwright }) => {
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    const r = await makeRoutine(rafi, 'Busy one', { botSlug: 'keeper', prompt: 'ROUTINE-TOOLS 45 TAG-b1', outputPath: 'Routines/busy/output.md' });
    const res = await runRoutine(rafi, r.id);
    expect(res.status(), await res.text()).toBe(202);
    const run = await settledRun(rafi, r.id, 180_000);
    expect(run.status, run.reason).toBe('done');
    const out = await outputOf(rafi, r.outputPath);
    expect(out).toContain('ROUTINE-OUT TAG-b1');
    expect(out).toContain('This routine has used its 40 tool calls for one run.');
    const calls = await stack.sql<{ n: string }>(`SELECT count(*) AS n FROM app.run_decisions WHERE run_id = $1 AND kind = 'tool'`, [run.runId]);
    expect(Number(calls[0]!.n)).toBeGreaterThanOrEqual(40);
    expect(Number(calls[0]!.n)).toBeLessThanOrEqual(41);
  } finally {
    await rafi.ctx.dispose();
  }
});

test('when the month’s allowance is used up the routine is stopped, refused again, and runs once the allowance is raised', async ({ browser, playwright }) => {
  const rafi = await apiOn(playwright, stack, 'rafi');
  const omar = await apiOn(playwright, stack, 'omar');
  let spendId: string | null = null;
  try {
    const r = await makeRoutine(rafi, 'Spender', { botSlug: 'keeper', prompt: 'Write me a short note.', outputPath: 'Routines/spender/output.md' });
    expect((await runRoutine(rafi, r.id)).status()).toBe(202);
    const run = await settledRun(rafi, r.id);
    expect(run.runId).not.toBeNull();

    // the run cost more than the $5 each person has by default
    spendId = (
      await stack.sql<{ id: string }>(`INSERT INTO app.llm_spend (workspace_id, run_id, alias, cost_usd) SELECT workspace_id, id, 'smart', 6 FROM app.bot_runs WHERE id = $1 RETURNING id`, [run.runId])
    )[0]!.id;
    await makeDue(stack, r.id);
    await tick(stack);
    expect((await listRoutines(rafi)).items.find((x) => x.id === r.id)).toMatchObject({ enabled: false, stoppedReason: 'spend_cap' });

    // the page says why, in words
    const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/account/routines');
    try {
      const row = page.getByTestId('routine').filter({ has: page.getByTestId('routine-name-text').filter({ hasText: 'Spender' }) });
      await expect(row.getByTestId('routine-state')).toHaveText('Stopped');
      await expect(row.getByTestId('routine-stop-reason')).toHaveText(`This routine was turned off because ${PERSONAL_ROUTINE_STOP_WORDS.spend_cap}.`);
      await expect(page.getByTestId('routine-allowance')).toContainText('$6.00 of your $5.00 allowance used this month, $0.00 left.');
    } finally {
      await context.close();
    }

    // refused again, by hand and by turning it back on, with the same sentence
    const sentence = 'Your routines have used up this month’s allowance.';
    const again = await runRoutine(rafi, r.id);
    expect(again.status()).toBe(409);
    expect(await messageOf(again)).toBe(sentence);
    const on = await patchRoutine(rafi, r.id, { enabled: true });
    expect(on.status()).toBe(409);
    expect(await messageOf(on)).toBe(sentence);

    // an admin raises the allowance: it turns back on and the stop is cleared
    expect((await omar.ctx.put('/api/workspace/routine-settings', { data: { monthlyCapUsd: 10 }, headers: await omar.headers() })).status()).toBe(200);
    const raised = await patchRoutine(rafi, r.id, { enabled: true });
    expect(raised.status(), await raised.text()).toBe(200);
    expect((await listRoutines(rafi)).items.find((x) => x.id === r.id)).toMatchObject({ enabled: true, stoppedReason: null });
  } finally {
    if (spendId) await stack.sql('DELETE FROM app.llm_spend WHERE id = $1', [spendId]);
    await omar.ctx.put('/api/workspace/routine-settings', { data: { monthlyCapUsd: 5 }, headers: await omar.headers() });
    await rafi.ctx.dispose();
    await omar.ctx.dispose();
  }
});
