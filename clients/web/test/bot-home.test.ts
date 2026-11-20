// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { BotSummary } from '@manythreads/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P29-13: opening a bot from the sidebar opens its chat; a bot that allows none says so, with the way to its settings only for the people who may change them; an old
// `?tab=` address goes to the settings.

const state: { bot: Partial<BotSummary>; canEdit: boolean } = { bot: {}, canEdit: false };
vi.mock('../src/screens/bots/store', () => ({
  useBot: () => ({ slug: 'engineering', canEdit: state.canEdit, q: { status: 'ok', data: { bot: { name: 'Coder', slug: 'coder', kind: 'agent', avatar: null, status: 'active', conversational: true, ...state.bot } }, reload: () => undefined } }),
}));
vi.mock('../src/shell/topic', () => ({ useCrumbTail: () => undefined, useOwnsPageTitle: () => undefined, useHeaderTitleSlot: () => null, useHeaderActionsSlot: () => null }));
const { BotHome, allowsChat, whyNoChat } = await import('../src/screens/bots/BotHome');
const { botChatPath, botSettingsPath } = await import('../src/screens/bots/botPaths');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Where() {
  const l = useLocation();
  return createElement('p', { 'data-testid': 'at' }, `${l.pathname}${l.search}`);
}

let host: HTMLDivElement;
let root: Root;
const visit = async (url: string): Promise<void> => {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [url] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/t/:team/bots/:botSlug', element: createElement(BotHome) }),
          createElement(Route, { path: '*', element: createElement(Where) }),
        ),
      ),
    );
  });
};
const q = (sel: string) => host.querySelector(sel);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.bot = {};
  state.canEdit = false;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('opening a bot', () => {
  it('goes to the chat when the bot allows chatting', async () => {
    await visit('/t/engineering/bots/coder');
    expect(q('[data-testid="at"]')?.textContent).toBe('/t/engineering/bots/coder/chat');
  });

  it("Brain's chat is in Chat", async () => {
    state.bot = { slug: 'brain', name: 'Brain' };
    await visit('/t/engineering/bots/brain');
    expect(q('[data-testid="at"]')?.textContent).toBe('/t/engineering/chat?bot=brain');
  });

  it('says there is no chat, and offers Bot settings to a person who may change them', async () => {
    state.bot = { conversational: false };
    state.canEdit = true;
    await visit('/t/engineering/bots/coder');
    expect(q('[data-testid="bot-no-chat-title"]')?.textContent).toBe('No chat is available with Coder.');
    expect(q('[data-testid="bot-no-chat-why"]')?.textContent).toContain('no one-to-one chat');
    const button = q('[data-testid="bot-settings-button"]') as HTMLAnchorElement;
    expect(button.textContent).toBe('Bot settings');
    expect(button.getAttribute('href')).toBe('/t/engineering/bots/coder/settings');
  });

  it('shows no button to a person who may not, and says who can', async () => {
    state.bot = { conversational: false };
    await visit('/t/engineering/bots/coder');
    expect(q('[data-testid="bot-no-chat"]')).not.toBeNull();
    expect(q('[data-testid="bot-settings-button"]')).toBeNull();
    expect(q('[data-testid="bot-no-chat-who"]')?.textContent).toContain('team lead');
  });

  it('a bot that is turned off has no chat either, and says why', async () => {
    state.bot = { status: 'disabled' };
    await visit('/t/engineering/bots/coder');
    expect(q('[data-testid="bot-no-chat-why"]')?.textContent).toBe('Coder is turned off.');
  });

  it('an old address with ?tab= goes to the settings, keeping the tab', async () => {
    await visit('/t/engineering/bots/coder?tab=placement');
    expect(q('[data-testid="at"]')?.textContent).toBe('/t/engineering/bots/coder/settings?tab=placement');
  });
});

describe('the words and the addresses', () => {
  it('allows chat only for a bot that is on and has a conversation trigger', () => {
    expect(allowsChat({ status: 'active', conversational: true })).toBe(true);
    expect(allowsChat({ status: 'active', conversational: false })).toBe(false);
    expect(allowsChat({ status: 'invalid', conversational: true })).toBe(false);
    expect(allowsChat({ status: 'disabled', conversational: true })).toBe(false);
  });

  it('gives each reason in one line', () => {
    expect(whyNoChat({ name: 'Coder', status: 'invalid', conversational: true })).toContain('has a mistake');
    expect(whyNoChat({ name: 'Coder', status: 'active', conversational: false })).toContain('mentions, schedules or events');
  });

  it('keeps the three places apart', () => {
    expect(botChatPath('engineering', 'coder')).toBe('/t/engineering/bots/coder/chat');
    expect(botSettingsPath('engineering', 'coder', 'safety')).toBe('/t/engineering/bots/coder/settings?tab=safety');
  });
});
