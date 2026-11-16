import { afterEach, describe, expect, it } from 'vitest';
import { journeyAnswer } from '../src/journey.ts';
import { startFakeLlm, type FakeLlm } from '../src/server.ts';

// P27-19: what the setup wizard's tests need from a model. The journey scenario answers a Brain-shaped turn with a search, then a cited answer; the
// provider keys make the stand-in refuse a bad key (401) and a key without quota (429) the way a provider does behind LiteLLM.

const MSG = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const TOOLS = [{ type: 'function', function: { name: 'messages_search' } }, { type: 'function', function: { name: 'answer_post' } }];

let fake: FakeLlm | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('the journey scenario', () => {
  it('searches first, then posts one answer that cites the first hit, then stops', () => {
    const q = [{ role: 'user', content: 'What did we decide about the release process?' }];
    const first = journeyAnswer(q, TOOLS);
    expect(first).toMatchObject({ toolCalls: [{ name: 'messages_search' }] });
    const query = JSON.parse((first as { toolCalls: Array<{ arguments: string }> }).toolCalls[0]!.arguments) as { query: string };
    expect(query.query).toContain('release');

    const withHits = [...q, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'messages_search', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ hits: [{ id: MSG }] }) }];
    const second = journeyAnswer(withHits, TOOLS) as { toolCalls: Array<{ name: string; arguments: string }> };
    expect(second.toolCalls[0]!.name).toBe('answer_post');
    const args = JSON.parse(second.toolCalls[0]!.arguments) as { body: string; citations: unknown[] };
    expect(args.body).toContain('[1]');
    expect(args.citations).toEqual([{ kind: 'message', messageId: MSG }]);

    const done = [...withHits, { role: 'assistant', content: null, tool_calls: [{ id: 'c2', function: { name: 'answer_post', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c2', content: '{"ok":true}' }];
    expect(journeyAnswer(done, TOOLS)).toEqual({ text: 'Done.' });
  });

  it('says it found nothing, with no citation, when the search had no hit', () => {
    const msgs = [
      { role: 'user', content: 'Anything?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'messages_search', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"hits":[]}' },
    ];
    const answer = journeyAnswer(msgs, TOOLS) as { toolCalls: Array<{ arguments: string }> };
    const args = JSON.parse(answer.toolCalls[0]!.arguments) as { body: string; citations?: unknown[] };
    expect(args.citations).toBeUndefined();
    expect(args.body).toMatch(/could not find/);
  });

  it('answers one plain sentence with the marker when no tool is offered (the wizard test turn)', () => {
    const answer = journeyAnswer([{ role: 'user', content: 'Say hello.' }], undefined);
    expect(answer).toEqual({ text: expect.stringContaining('journey-ok') });
  });

  it('serves it over the wire, plain and streamed', async () => {
    fake = await startFakeLlm({ scenario: 'journey' });
    const ask = (stream: boolean) => fetch(`${fake!.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'smart', stream, tools: TOOLS, messages: [{ role: 'user', content: 'Where is the runbook?' }] }) });
    const plain = (await (await ask(false)).json()) as { choices: Array<{ finish_reason: string; message: { tool_calls: Array<{ function: { name: string } }> } }> };
    expect(plain.choices[0]!.finish_reason).toBe('tool_calls');
    expect(plain.choices[0]!.message.tool_calls[0]!.function.name).toBe('messages_search');
    const streamed = await (await ask(true)).text();
    expect(streamed).toContain('"tool_calls"');
    expect(streamed).toContain('[DONE]');
  });
});

describe('provider keys', () => {
  const push = async (key: string): Promise<void> => {
    const res = await fetch(`${fake!.url}/model/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model_name: 'smart', litellm_params: { model: 'openai/gpt-x', api_key: key }, model_info: { id: 'mt-smart' } }) });
    expect(res.status).toBe(200);
  };
  const ask = (model = 'smart') => fetch(`${fake!.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });

  it('answers a good key, refuses a bad key with 401 and a key without quota with 429', async () => {
    fake = await startFakeLlm({ providerKeys: { good: ['sk-good'], noQuota: ['sk-empty'] } });
    await push('sk-good');
    expect((await ask()).status).toBe(200);
    await push('sk-empty').catch(() => undefined);
    fake.state.models.set('mt-smart', { id: 'mt-smart', model_name: 'smart', litellm_params: { api_key: 'sk-empty' } });
    const quota = await ask();
    expect(quota.status).toBe(429);
    expect(JSON.stringify(await quota.json())).toContain('quota');
    fake.state.models.set('mt-smart', { id: 'mt-smart', model_name: 'smart', litellm_params: { api_key: 'sk-wrong' } });
    const bad = await ask();
    expect(bad.status).toBe(401);
    expect(JSON.stringify(await bad.json())).toContain('Incorrect API key');
    expect((await ask('nothing')).status).toBe(400);
  });

  it('never echoes the key it was given', async () => {
    fake = await startFakeLlm({ providerKeys: { good: ['sk-good'] } });
    await push('sk-secret-value');
    const body = await (await ask()).text();
    expect(body).not.toContain('sk-secret-value');
  });
});
