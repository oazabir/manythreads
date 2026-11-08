import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { appIdLabel, BUILT_PROVIDERS, callbackUrl, chatPlace, codeExpired, consoleSteps, failureWords, isBuilt, LATER_PROVIDERS, openableLink, PROVIDER_LABEL, STATUS_WORDS, tokenLabel, whatItDoes } from '../src/screens/bridges/words';
import { ACCOUNT_CHAT_APPS_READY } from '../src/screens/bridges/AccountChatApps';
import { ADMIN_CHAT_APPS_READY } from '../src/screens/bridges/AdminChatApps';
import { CHAT_BRIDGE_TAB_READY } from '../src/webhooks/ChatBridgeTab';

describe('the chat-app pages', () => {
  it('are switched on', () => {
    expect([ADMIN_CHAT_APPS_READY, ACCOUNT_CHAT_APPS_READY, CHAT_BRIDGE_TAB_READY]).toEqual([true, true, true]);
  });

  it('name every service and split built from later', () => {
    expect(Object.keys(PROVIDER_LABEL).sort()).toEqual(['slack', 'teams', 'telegram', 'whatsapp']);
    expect([...BUILT_PROVIDERS, ...LATER_PROVIDERS].sort()).toEqual(['slack', 'teams', 'telegram', 'whatsapp']);
    expect(isBuilt('telegram')).toBe(true);
    expect(isBuilt('slack')).toBe(true);
    expect(isBuilt('teams')).toBe(true);
    expect(LATER_PROVIDERS).toEqual([]);
    expect(STATUS_WORDS.attention).toBe('Needs attention');
  });

  it('explain WhatsApp’s 24 hour rule in plain words', () => {
    expect(whatItDoes('whatsapp')).toMatch(/24 hours/);
    expect(whatItDoes('telegram')).toMatch(/linked/);
  });

  it('say what to do in Slack’s and Teams’ own consoles, and what each asks for', () => {
    expect(consoleSteps('slack')?.note).toMatch(/Request URL/);
    expect(consoleSteps('teams')?.note).toMatch(/messaging endpoint/);
    expect(consoleSteps('telegram')).toBeNull();
    expect(tokenLabel('teams')).toBe('Client secret');
    expect(tokenLabel('slack')).toBe('Bot token');
    expect(appIdLabel('teams')?.label).toMatch(/client\) id/);
    expect(appIdLabel('slack')).toBeNull();
    for (const p of ['slack', 'teams'] as const) expect(whatItDoes(p)).toMatch(/linked/);
  });

  it('name the place a channel is joined to, open a link code only over https, and know when a code has run out', () => {
    expect(chatPlace('telegram')).toBe('group');
    expect(chatPlace('slack')).toBe('channel');
    expect(chatPlace('teams')).toBe('channel');
    expect(openableLink('https://t.me/some_bot?start=123456')).toBe('https://t.me/some_bot?start=123456');
    expect(openableLink('javascript:alert(1)')).toBeNull();
    expect(openableLink('http://t.me/x')).toBeNull();
    expect(openableLink('not a link')).toBeNull();
    expect(openableLink(null)).toBeNull();
    expect(codeExpired('2026-11-08T10:00:00.000Z', Date.parse('2026-11-08T09:59:59.000Z'))).toBe(false);
    expect(codeExpired('2026-11-08T10:00:00.000Z', Date.parse('2026-11-08T10:00:00.000Z'))).toBe(true);
    expect(codeExpired('garbage')).toBe(true);
  });

  it('say the server’s own sentence, else the fallback', () => {
    expect(failureWords(new Error('Plain words'), 'fallback')).toBe('Plain words');
    expect(failureWords({}, 'fallback')).toBe('fallback');
    expect(failureWords(new ApiError({ code: 'conflict', message: 'That already exists', status: 409 }), 'fallback')).toBe('That already exists');
  });

  it('build the address a chat service is given', () => {
    expect(callbackUrl('/hooks/bridges/whatsapp/abc', 'https://manythreads.example')).toBe('https://manythreads.example/hooks/bridges/whatsapp/abc');
  });
});
