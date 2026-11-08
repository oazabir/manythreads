import { describe, expect, it } from 'vitest';
import { addressOf, clockOf, originSummary, parseKinds, receivedLine, safeHref } from '../src/webhooks/providerModel';

// The plain words and the guards behind the "Work apps" tab and the card "What started this run" (P16-10). Pure: no screen.

describe('safeHref', () => {
  it('lets a web address through and nothing else', () => {
    expect(safeHref('https://example.zendesk.com/agent/tickets/4512')).toBe('https://example.zendesk.com/agent/tickets/4512');
    expect(safeHref('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', '//evil.example', 'not a link', '']) expect(safeHref(bad), bad).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});

describe('parseKinds', () => {
  it('splits on commas and spaces, lower-cases and drops repeats', () => {
    expect(parseKinds('ticket.created, Issue.*  ticket.created')).toEqual(['ticket.created', 'issue.*']);
    expect(parseKinds('')).toEqual([]);
  });
});

describe('the words', () => {
  it('names the address with this site’s own origin', () => {
    expect(addressOf({ path: '/hooks/apps/abc' }, 'https://manythreads.example/')).toBe('https://manythreads.example/hooks/apps/abc');
  });
  it('says what the last delivery was', () => {
    const now = Date.parse('2026-11-02T10:00:00Z');
    expect(receivedLine({ hasSecret: false, lastReceivedAt: null }, now)).toMatch(/No signing secret yet/);
    expect(receivedLine({ hasSecret: true, lastReceivedAt: null }, now)).toBe('Nothing received yet');
    expect(receivedLine({ hasSecret: true, lastReceivedAt: '2026-11-02T09:55:00Z' }, now)).toBe('Last event 5 minutes ago');
  });
  it('summarises the card on one line: the app and the title, or the kind when there is no title', () => {
    expect(originSummary({ provider: 'zendesk', kind: 'ticket.created', title: 'Printer on fire' })).toBe('What started this run · Zendesk · Printer on fire');
    expect(originSummary({ provider: 'generic', kind: 'deploy.finished', title: null })).toBe('What started this run · Any other app · deploy.finished');
  });
  it('shows a time and survives a bad one', () => {
    expect(clockOf('2026-11-02T14:05:00Z')).toMatch(/^\d\d:\d\d$/);
    expect(clockOf('nonsense')).toBe('');
  });
});
