import { expect, type Locator, type Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** The team's memory (`/t/<team>/memory`): concepts, their trust and provenance, and the inbox where files are dropped. */
export class MemoryPage extends PageObject {
  protected readonly landmark = TID.memoryTabs;
  constructor(page: Page, readonly team: string) {
    super(page);
  }
  async open(): Promise<this> {
    return this.goto(`/t/${this.team}/memory`);
  }
  get concepts(): Locator {
    return this.tid(TID.conceptRow);
  }
  concept(name: string | RegExp): Locator {
    return this.concepts.filter({ hasText: name }).first();
  }
  async openConcept(name: string | RegExp): Promise<Locator> {
    await this.concept(name).click();
    const detail = this.tid(TID.conceptDetail);
    await expect(detail).toBeVisible();
    return detail;
  }
  /** The Inbox tab: what was dropped in and what became of it. */
  async openInbox(): Promise<void> {
    await this.tid(TID.inboxTab).click();
    await expect(this.tid(TID.inboxList).or(this.tid(TID.inboxDropzone)).first()).toBeVisible();
  }
  get inboxItems(): Locator {
    return this.tid(TID.inboxItem);
  }
}
