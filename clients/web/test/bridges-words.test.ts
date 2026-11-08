import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { BUILT_PROVIDERS, callbackUrl, failureWords, isBuilt, LATER_PROVIDERS, PROVIDER_LABEL, STATUS_WORDS, whatItDoes } from '../src/screens/bridges/words';
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
    expect(isBuilt('slack')).toBe(false);
    expect(STATUS_WORDS.attention).toBe('Needs attention');
  });

  it('explain WhatsApp’s 24 hour rule in plain words', () => {
    expect(whatItDoes('whatsapp')).toMatch(/24 hours/);
    expect(whatItDoes('telegram')).toMatch(/linked/);
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
