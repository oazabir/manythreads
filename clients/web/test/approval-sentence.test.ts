import { describe, expect, it } from 'vitest';
import { MEMORY_DIGEST_SEND_TOOL } from '@manythreads/shared';
import { approvalAction, approvalSentence } from '../src/screens/approvals/sentence';

const base = { source: 'grant' as const, botName: 'Support responder', requesterName: 'Nadia', summary: '', argsPreview: {} };

describe('a request as one sentence', () => {
  it('names who asked, which bot and what for', () => {
    expect(approvalSentence({ ...base, tool: 'email.send', summary: 'email.send · reply to m.okafor', argsPreview: { to: 'm.okafor' } })).toBe('Nadia asked Support responder to send an email to m.okafor');
  });

  it('knows a page that is created and one that is changed', () => {
    expect(approvalAction({ ...base, tool: 'pages.write', argsPreview: { mode: 'create', path: 'pages/a.md' } })).toBe('create the page pages/a.md');
    expect(approvalAction({ ...base, tool: 'pages.write', argsPreview: { mode: 'replace', path: 'pages/a.md' } })).toBe('change the page pages/a.md');
    expect(approvalAction({ ...base, tool: 'pages.write', argsPreview: {} })).toBe('change a page');
  });

  it('leaves the target out when the preview has none, and clips a long one', () => {
    expect(approvalAction({ ...base, tool: 'email.send', argsPreview: {} })).toBe('send an email');
    const long = approvalAction({ ...base, tool: 'files.delete', argsPreview: { path: 'x'.repeat(200) } });
    expect(long.length).toBeLessThan(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('gives an unknown tool a plain sentence, with what the summary says it is about', () => {
    expect(approvalAction({ ...base, tool: 'crm.merge', summary: 'crm.merge · Acme and Acme Ltd' })).toBe('use crm.merge (Acme and Acme Ltd)');
    expect(approvalAction({ ...base, tool: 'crm.merge', summary: 'crm.merge' })).toBe('use crm.merge');
  });

  it('says a held message is going to the model, whatever the tool is called', () => {
    expect(approvalAction({ ...base, source: 'dlp', tool: 'llm.call' })).toBe('send a message to the model');
    expect(approvalAction({ ...base, source: 'dlp', tool: 'something.new' })).toBe('send a message to the model');
  });

  it('reads right when the bot asked for itself, or no bot is named', () => {
    expect(approvalSentence({ ...base, requesterName: 'Support responder', tool: 'email.send', argsPreview: { to: 'a@b.c' } })).toBe('Support responder wants to send an email to a@b.c');
    expect(approvalSentence({ ...base, botName: null, tool: 'files.write', argsPreview: { path: 'a.md' } })).toBe('Nadia asked a bot to write the file a.md');
  });

  it('does not describe a memory-sharing request as a bot call', () => {
    expect(approvalSentence({ ...base, botName: null, tool: MEMORY_DIGEST_SEND_TOOL, summary: 'Send the Monday digest' })).toBe('Nadia asked: Send the Monday digest');
  });

  it('never throws on odd input: a tool named like an object method, a missing preview or summary', () => {
    expect(approvalAction({ ...base, tool: 'constructor' })).toBe('use constructor');
    expect(approvalAction({ ...base, tool: 'toString', argsPreview: {} })).toBe('use toString');
    const odd = { ...base, tool: 'email.send', argsPreview: null as never, summary: undefined as never, requesterName: undefined as never };
    expect(approvalSentence(odd)).toBe('Support responder wants to send an email');
    expect(approvalAction({ ...odd, tool: 'crm.merge' })).toBe('use crm.merge');
  });
});
