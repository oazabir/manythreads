import { expect, type Locator, type Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** A channel: the message list and the composer at its foot. */
export class ChannelPage extends PageObject {
  protected readonly landmark = TID.channelView;
  constructor(page: Page, readonly team: string) {
    super(page);
  }

  /** `/t/<team>/c/<channel>`. A persona who may not open it meets {@link expectNoAccess} instead. */
  async open(channel: string): Promise<this> {
    return this.goto(`/t/${this.team}/c/${channel}`);
  }

  /** Opens an address that is expected to be refused (a private channel, another team) and waits for the refusal instead of the channel. */
  async openExpectingRefusal(path: string): Promise<void> {
    await this.page.goto(path);
    await this.expectNoAccess();
  }

  async expectNoAccess(): Promise<void> {
    await expect(this.tid(TID.noAccess).or(this.page.getByRole('heading', { name: 'You do not have access' })).first()).toBeVisible();
  }

  get messages(): Locator {
    return this.tid(TID.message);
  }
  message(text: string | RegExp): Locator {
    return this.messages.filter({ hasText: text }).first();
  }
  get lastMessage(): Locator {
    return this.messages.last();
  }

  get composer(): Locator {
    return this.page.locator(`[data-testid="${TID.composer}"][data-landmark="composer"]`);
  }
  get input(): Locator {
    return this.composer.locator('textarea');
  }
  get sendButton(): Locator {
    return this.composer.getByTestId(TID.send);
  }
  /** True when the channel gives this person a message box (a guest and a read-only channel have none). */
  async hasComposer(): Promise<boolean> {
    return (await this.composer.count()) > 0;
  }

  /** Types a message and sends it with Enter; waits until it shows in the list. */
  async post(text: string): Promise<Locator> {
    await this.input.fill(text);
    await this.input.press('Enter');
    const posted = this.message(text.slice(0, 40));
    await expect(posted).toBeVisible();
    return posted;
  }

  /** Opens the thread panel on a message (hover, then "Reply in thread"). */
  async openThread(message: Locator): Promise<ThreadPanel> {
    await message.hover();
    await message.getByRole('button', { name: 'Reply in thread' }).click();
    const panel = new ThreadPanel(this.page);
    await panel.expectLoaded();
    return panel;
  }

  /** Reacts to a message with an emoji (hover, "Add reaction", the emoji). */
  async react(message: Locator, emoji: string): Promise<void> {
    await message.hover();
    await message.getByRole('button', { name: 'Add reaction' }).click();
    await this.page.getByRole('menuitem', { name: `React with ${emoji}` }).click();
  }
}

/** The thread panel on the right of a channel (or the full thread view on a phone). */
export class ThreadPanel extends PageObject {
  protected readonly landmark = TID.threadView;
  constructor(page: Page) {
    super(page);
  }

  get replies(): Locator {
    return this.root.getByTestId(TID.message);
  }
  get composer(): Locator {
    return this.page.locator(`[data-testid="${TID.composer}"][data-landmark="reply-composer"]`);
  }
  get input(): Locator {
    return this.composer.locator('textarea');
  }

  /** Types a reply and sends it with Enter; waits until it shows in the thread. */
  async reply(text: string): Promise<void> {
    await this.input.fill(text);
    await this.input.press('Enter');
    await expect(this.replies.filter({ hasText: text.slice(0, 40) }).first()).toBeVisible();
  }
}

/** The Threads inbox (`/t/<team>/threads`): the threads the person follows, newest first, with the open thread on the right. */
export class ThreadsInboxPage extends PageObject {
  protected readonly landmark = TID.threadsInbox;
  constructor(page: Page, readonly team: string) {
    super(page);
  }
  async open(): Promise<this> {
    return this.goto(`/t/${this.team}/threads`);
  }
}
