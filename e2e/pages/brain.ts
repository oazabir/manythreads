import { expect, type Locator, type Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** The Chat screen: a person's conversation with one bot, Brain by default (`/t/<team>/chat?bot=brain`). */
export class BrainPage extends PageObject {
  protected readonly landmark = TID.chatScreen;
  constructor(page: Page, readonly team: string, readonly bot = 'brain') {
    super(page);
  }

  async open(bot = this.bot): Promise<this> {
    return this.goto(`/t/${this.team}/chat?bot=${bot}`);
  }

  get main(): Locator {
    return this.tid(TID.chatMain);
  }
  get input(): Locator {
    return this.main.locator('textarea').first();
  }
  /** What the person and the bot said, oldest first. */
  get messages(): Locator {
    return this.tid(TID.chatMessage);
  }
  get botMessages(): Locator {
    return this.page.locator(`[data-testid="${TID.chatMessage}"][data-role="bot"]`);
  }
  get thinking(): Locator {
    return this.tid(TID.chatThinking);
  }
  /** The example questions shown on an empty conversation. */
  get prompts(): Locator {
    return this.tid(TID.chatPrompts);
  }

  /** Types a question, sends it with Enter and waits until Brain has stopped working and an answer is on screen. */
  async ask(question: string, options: { timeoutMs?: number } = {}): Promise<Locator> {
    const before = await this.botMessages.count();
    await this.input.fill(question);
    await this.input.press('Enter');
    await expect(this.botMessages).toHaveCount(before + 1, { timeout: options.timeoutMs ?? 60_000 });
    await expect(this.thinking).toHaveCount(0, { timeout: options.timeoutMs ?? 60_000 });
    return this.botMessages.last();
  }

  /** The answer card inside a bot message, with its numbered sources. */
  answerOf(message: Locator): { card: Locator; citations: Locator; outside: Locator } {
    return { card: message.getByTestId(TID.answer), citations: message.getByTestId(TID.answerCitation), outside: message.getByTestId(TID.answerOutside) };
  }
}

/** A bot's conversation view (`/t/<team>/bots/<bot>/chat`): the older, per-bot screen. */
export class ConversationPage extends PageObject {
  protected readonly landmark = TID.conversationView;
  constructor(page: Page, readonly team: string) {
    super(page);
  }
  async open(bot: string): Promise<this> {
    return this.goto(`/t/${this.team}/bots/${bot}/chat`);
  }
}
