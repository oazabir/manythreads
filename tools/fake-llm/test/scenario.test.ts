import { afterEach, describe, expect, it } from 'vitest';
import { demoScenarioCompletion } from '../src/scenario.ts';
import { startFakeLlm, type FakeLlm } from '../src/server.ts';

/*
 * The demo scenario: one deterministic completion per persona, so the bot
 * chain (orchestrator -> coder -> tester -> orchestrator) and the brain's
 * memory answers can be exercised through the UI with no provider.
 */

let fake: FakeLlm | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const ask = async (url: string, messages: Array<{ role: string; content: string }>): Promise<string> => {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'smart', messages }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return body.choices[0]?.message.content ?? '';
};

const user = (content: string): Array<{ role: string; content: string }> => [{ role: 'user', content }];

describe('demoScenarioCompletion', () => {
  it('orchestrator kickoff delegates step 1 to coder', () => {
    const text = demoScenarioCompletion({ model: 'smart', messages: user('orchestrator: plan the task add login form'), authorized: true });
    expect(text).toContain('Orchestrator here');
    expect(text).toContain('@coder');
  });

  it('kickoff mentions only coder, so no tester run opens on it', () => {
    const text = demoScenarioCompletion({ model: 'smart', messages: user('orchestrator: plan the task add login form'), authorized: true });
    expect(text).not.toContain('@tester');
  });

  it('the next step is terminal: no mention wakes another run', () => {
    const text = demoScenarioCompletion({
      model: 'smart',
      messages: user('@tester confirmed PASS, reporting to @orchestrator'),
      authorized: true,
    });
    expect(text).toContain('Next step');
    expect(text).not.toContain('@coder');
    expect(text).not.toContain('@tester');
  });

  it('a bot\'s own instructions never read as a confirmation of its work', () => {
    // Tester SOUL says "mark each PASS … to the orchestrator role": with a
    // bare-orchestrat confirmation check that self-matches and the tester run
    // answers as the orchestrator. The handle keeps its @, so this routes on.
    const text = demoScenarioCompletion({
      model: 'smart',
      messages: [
        { role: 'system', content: 'You are Tester. Mark each check PASS or FAIL, and confirm the outcome to the orchestrator role.' },
        { role: 'user', content: 'Coder in #dev:\nNext: @tester please verify the diff and confirm to @orchestrator' },
      ],
      authorized: true,
    });
    expect(text).toContain('Tester here');
  });

  it('the live chain answers in its own voice at every step', () => {
    const kickoff = demoScenarioCompletion({ model: 'smart', messages: user('@orchestrator plan the release checklist work'), authorized: true });
    expect(kickoff).toContain('Orchestrator here');
    const code = demoScenarioCompletion({ model: 'smart', messages: user(`Orchestrator in #dev:\n\n${kickoff}`), authorized: true });
    expect(code).toContain('Coder here');
    const test = demoScenarioCompletion({ model: 'smart', messages: user(`Coder in #dev:\n\n${code}`), authorized: true });
    expect(test).toContain('Tester here');
    const next = demoScenarioCompletion({ model: 'smart', messages: user(`Tester in #dev:\n\n${test}`), authorized: true });
    expect(next).toContain('Orchestrator here');
    expect(next).toContain('Next step');
  });

  it('coder implements and hands to tester', () => {
    const text = demoScenarioCompletion({ model: 'smart', messages: user('@coder please implement add login form') , authorized: true });
    expect(text).toContain('Coder here');
    expect(text).toContain('@tester');
    expect(text).toContain('```diff');
  });

  it('tester verifies and confirms to orchestrator', () => {
    const text = demoScenarioCompletion({
      model: 'smart',
      messages: user('@tester verify add login form: coder diff ready, please confirm to @orchestrator'),
      authorized: true,
    });
    expect(text).toContain('Tester here');
    expect(text).toContain('PASS');
    expect(text).toContain('@orchestrator');
  });

  it('orchestrator plans the next step after a tester confirmation', () => {
    const text = demoScenarioCompletion({
      model: 'smart',
      messages: [
        { role: 'user', content: '@coder implement add login form' },
        { role: 'assistant', content: 'Coder here — diff ready, @tester verify' },
        { role: 'user', content: '@tester confirmed PASS, reporting to @orchestrator' },
      ],
      authorized: true,
    });
    expect(text).toContain('Orchestrator here');
    expect(text).toContain('Next step');
  });

  it('brain answers from the seeded memory bank', () => {
    const text = demoScenarioCompletion({ model: 'smart', messages: user('brain: what do you know about the deploy command?'), authorized: true });
    expect(text).toContain('Brain here');
    expect(text).toContain('memory://bank/');
  });

  it('quotes the task without the prompt wrapper\'s author header', () => {
    const text = demoScenarioCompletion({
      model: 'smart',
      messages: user('Omar:\n@orchestrator plan the release checklist work'),
      authorized: true,
    });
    expect(text).toContain('Plan for "plan the release checklist work"');
  });

  it('routes past the prompt wrapper author header to the @persona', () => {
    const text = demoScenarioCompletion({
      model: 'smart',
      messages: user('Omar:\n@coder\nPlease implement the release checklist work and hand to @tester when the diff is ready.'),
      authorized: true,
    });
    expect(text).toContain('Coder here');
    expect(text).toContain('Please implement the release checklist work');
  });

  it('is deterministic: the same messages answer the same text', () => {
    const messages = user('@coder implement add login form');
    expect(demoScenarioCompletion({ model: 'smart', messages, authorized: true })).toBe(
      demoScenarioCompletion({ model: 'smart', messages, authorized: true }),
    );
  });
});

describe('demo scenario over HTTP', () => {
  it('serves the full chain through /v1/chat/completions', async () => {
    fake = await startFakeLlm({ scenario: 'demo' });
    const kickoff = await ask(fake.url, user('orchestrator: plan add login form'));
    expect(kickoff).toContain('@coder');
    const code = await ask(fake.url, user(`@coder ${kickoff}`));
    expect(code).toContain('@tester');
    const test = await ask(fake.url, user(`@tester ${code}`));
    expect(test).toContain('@orchestrator');
    const next = await ask(fake.url, [
      { role: 'user', content: '@coder implement it' },
      { role: 'assistant', content: code },
      { role: 'user', content: `@tester says PASS, confirming to @orchestrator` },
    ]);
    expect(next).toContain('Next step');
    const brain = await ask(fake.url, user('brain: recall the lesson about proxy keys'));
    expect(brain).toContain('memory://bank/');
  });

  it('an explicit completion still wins over the scenario', async () => {
    fake = await startFakeLlm({ scenario: 'demo', completion: () => 'pinned' });
    expect(await ask(fake.url, user('@coder implement it'))).toBe('pinned');
  });
});
