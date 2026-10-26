import { NEVER_APPROVAL_GATED, NeverApprovalGatedError, RunEndedError, requestToolApproval, type ApprovalProvider, type BotRunHandle, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { previewArgs, fullArgs } from '@manythreads/shared';
import { describe, expect, it, vi } from 'vitest';
import { createApprovalProvider } from '../src/provider.ts';

// The open item of the P5-12 re-review: `memory.retain` must be refused by the approvals provider itself, not only by the SDK helper and the
// resume job. Without a database: the refusal comes before anything is written, so a transaction that must never be used proves it.

const neverUsed = {
  actor: { kind: 'system', id: 'x', workspaceId: 'w' },
  query: () => Promise.reject(new Error('the provider reached the database')),
} as unknown as PluginTx;

const request = (over: Record<string, unknown>) => ({
  runId: '00000000-0000-7000-8000-000000000001',
  source: 'grant',
  tool: 'pages.write',
  summary: 'Write a page',
  argsPreview: {},
  resume: { kind: 'tool', capability: 'pages.write', args: { path: 'pages/x.md' }, trigger: 'mention' },
  ...over,
});

describe('ApprovalProvider.request refuses a tool that may never wait', () => {
  const provider = createApprovalProvider({} as PluginContext);

  it.each(NEVER_APPROVAL_GATED)('%s: by the tool it names, whatever the source', async (tool) => {
    for (const source of ['grant', 'dlp', 'environment', 'dispatch']) {
      await expect(
        provider.request(neverUsed, request({ source, tool, resume: { kind: 'tool', capability: tool, args: {}, trigger: 'mention' } }) as never),
        `${tool} / ${source}`,
      ).rejects.toBeInstanceOf(NeverApprovalGatedError);
    }
  });

  it.each(NEVER_APPROVAL_GATED)('%s: by the capability its resume would re-run, even under another tool name', async (capability) => {
    await expect(
      provider.request(neverUsed, request({ tool: 'pages.write', resume: { kind: 'tool', capability, args: {}, trigger: 'mention' } }) as never),
    ).rejects.toBeInstanceOf(NeverApprovalGatedError);
  });

  it('says why, in the words the model is shown', async () => {
    await expect(provider.request(neverUsed, request({ tool: 'memory.retain', resume: { kind: 'tool', capability: 'memory.retain', args: {}, trigger: 'mention' } }) as never)).rejects.toThrow(/cannot wait for an approval/);
  });

  it('does not refuse what may wait: it goes on to the database', async () => {
    await expect(provider.request(neverUsed, request({}) as never)).rejects.toThrow('the provider reached the database');
    await expect(
      provider.request(neverUsed, request({ source: 'dlp', tool: 'llm.call', resume: { kind: 'handoff', payload: {} } }) as never),
    ).rejects.toThrow('the provider reached the database');
  });
});

describe('requestToolApproval turns the provider’s refusal into an answer for the model', () => {
  const run = { runId: 'r', botId: 'b', botActorId: 'a', teamId: 't', workspaceId: 'w', trigger: 'mention', askerActorId: null, expiresAt: '2030-01-01T00:00:00.000Z' } as BotRunHandle;

  it('with a provider that throws it, the answer is { refused }, not an exception', async () => {
    const provider = {
      id: 'approvals',
      request: () => Promise.reject(new NeverApprovalGatedError('memory.retain')),
      pendingForRun: () => Promise.resolve(0),
      claim: () => Promise.resolve(null),
    } as ApprovalProvider;
    const ctx = {
      providers: { get: () => provider },
      runs: { asBot: (_run: BotRunHandle, fn: (tx: PluginTx) => Promise<unknown>) => fn(neverUsed) },
    } as unknown as Pick<PluginContext, 'providers' | 'runs'>;
    // the helper's own list does not name this tool, so the call reaches the provider, which refuses it
    const answer = await requestToolApproval(ctx as never, run, 'pages.write', {});
    expect(answer).toEqual({ refused: expect.stringMatching(/cannot wait for an approval/) });
  });

  it('a call carrying a private note is refused, and nothing is filed (the approval row would keep the secret)', async () => {
    const request = vi.fn();
    const provider = { id: 'approvals', request, pendingForRun: () => Promise.resolve(0), claim: () => Promise.resolve(null) } as unknown as ApprovalProvider;
    const ctx = { providers: { get: () => provider }, runs: { asBot: (_run: BotRunHandle, fn: (tx: PluginTx) => Promise<unknown>) => fn(neverUsed) } } as unknown as Pick<PluginContext, 'providers' | 'runs'>;
    for (const key of ['privateNote', 'private_note', 'private-note']) {
      const answer = await requestToolApproval(ctx as never, run, 'tasks.handoff', { taskId: 't', [key]: 'hunter2' });
      expect(answer).toEqual({ refused: expect.stringMatching(/private note/) });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('the preview of any call hides a private note by name', () => {
    expect(JSON.stringify(previewArgs({ note: 'ok', privateNote: 'hunter2' }))).not.toContain('hunter2');
    expect(JSON.stringify(fullArgs({ note: 'ok', privateNote: 'hunter2' }))).not.toContain('hunter2');
  });

  it('a run that ended before the request is an answer for the model too, not an exception', async () => {
    const provider = {
      id: 'approvals',
      request: () => Promise.reject(new RunEndedError('r')),
      pendingForRun: () => Promise.resolve(0),
      claim: () => Promise.resolve(null),
    } as ApprovalProvider;
    const ctx = {
      providers: { get: () => provider },
      runs: { asBot: (_run: BotRunHandle, fn: (tx: PluginTx) => Promise<unknown>) => fn(neverUsed) },
    } as unknown as Pick<PluginContext, 'providers' | 'runs'>;
    expect(await requestToolApproval(ctx as never, run, 'pages.write', {})).toEqual({ refused: expect.stringMatching(/run has ended/) });
  });
});
