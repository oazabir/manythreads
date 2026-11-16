import { expect, type Locator, type Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** The bot roster of a team (`/t/<team>/bots`). */
export class BotsRosterPage extends PageObject {
  protected readonly landmark = TID.botsRoster;
  constructor(page: Page, readonly team: string) {
    super(page);
  }
  async open(): Promise<this> {
    return this.goto(`/t/${this.team}/bots`);
  }
  get rows(): Locator {
    return this.tid(TID.botRow);
  }
  row(name: string | RegExp): Locator {
    return this.rows.filter({ hasText: name }).first();
  }
  /** Opens one bot's settings from the roster (its Configure button; the name opens its chat). */
  async openBot(name: string | RegExp): Promise<BotPage> {
    await this.row(name).getByTestId(TID.botConfigure).click();
    const bot = new BotPage(this.page, this.team);
    await bot.expectLoaded();
    return bot;
  }
}

/** One bot's settings page (`/t/<team>/bots/<slug>/settings`): its definition, runs, tests and audit. */
export class BotPage extends PageObject {
  protected readonly landmark = TID.botPage;
  constructor(page: Page, readonly team: string) {
    super(page);
  }
  async open(slug: string): Promise<this> {
    return this.goto(`/t/${this.team}/bots/${slug}/settings`);
  }
  /** "Talk to" the bot, when the page offers it. */
  get talk(): Locator {
    return this.tid(TID.botTalk);
  }
  async expectRefusal(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: /You do not have access|Page not found/ }).or(this.tid(TID.noAccess)).first()).toBeVisible();
  }
}
