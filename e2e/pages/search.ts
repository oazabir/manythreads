import { expect, type Locator, type Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** Search (`/t/<team>/search?q=...`): messages, threads, files and pages the person may see. */
export class SearchPage extends PageObject {
  protected readonly landmark = TID.searchResults;
  constructor(page: Page, readonly team: string) {
    super(page);
  }
  async open(query: string): Promise<this> {
    return this.goto(`/t/${this.team}/search?q=${encodeURIComponent(query)}`);
  }
  get hits(): Locator {
    return this.tid(TID.searchHit);
  }
  hit(text: string | RegExp): Locator {
    return this.hits.filter({ hasText: text }).first();
  }
  get empty(): Locator {
    return this.tid(TID.searchEmpty);
  }
  /** Types a query into the search box of the rail and presses Enter. */
  async searchFromRail(query: string): Promise<void> {
    const box = this.page.locator('[data-landmark="search"] input').first();
    await box.fill(query);
    await box.press('Enter');
    await expect(this.root).toBeVisible();
  }
}
