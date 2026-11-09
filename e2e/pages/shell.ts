import { expect, type Locator, type Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** The frame around every signed-in screen: the left rail (team switch, search, sidebar, account) and the header. */
export class ShellPage extends PageObject {
  protected readonly landmark = TID.frame;
  constructor(page: Page, readonly team: string) {
    super(page);
  }

  get rail(): Locator {
    return this.page.locator('[data-landmark="sidebar"]');
  }
  get header(): Locator {
    return this.page.locator('[data-landmark="header"]');
  }
  get content(): Locator {
    return this.page.locator('[data-landmark="content"]').first();
  }
  /** The page title in the header (the `h1`). */
  get title(): Locator {
    return this.page.locator('[data-landmark="header"] h1, [data-landmark="content"] h1').first();
  }
  get bottomBar(): Locator {
    return this.tid(TID.bottomBar);
  }

  /** Opens an address of the app and waits for the frame. */
  async open(path: string): Promise<this> {
    return this.goto(path);
  }

  /** The sidebar row for a channel, found by where it goes (its name starts with "#", so a text match is brittle). */
  channelLink(channel: string): Locator {
    return this.rail.locator(`a[href$="/c/${channel}"]`).first();
  }

  /** Clicks a channel in the sidebar (the way a person opens it). */
  async openChannelFromSidebar(channel: string): Promise<void> {
    await this.channelLink(channel).click();
    await expect(this.tid(TID.channelView)).toBeVisible();
  }

  /** The sidebar link to any address of the app: `linkTo('/bots')` matches `/t/engineering/bots`. */
  linkTo(hrefEnd: string): Locator {
    return this.page.locator(`[data-landmark="sidebar"] a[href$="${hrefEnd}"]`).first();
  }

  /** The account menu in the foot of the rail (or the "You" sheet on a phone). */
  async openAccountMenu(): Promise<void> {
    const bar = this.bottomBar;
    if (await bar.isVisible()) await this.tid(TID.barYou).click();
    else await this.page.getByRole('button', { name: 'Account menu' }).click();
  }

  /** The search box of the rail. */
  get searchBox(): Locator {
    return this.page.locator('[data-landmark="search"] input').first();
  }
}
