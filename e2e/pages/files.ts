import { expect, type Locator, type Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** Files (`/t/<team>/files`): the team's repository as a person sees it. */
export class FilesPage extends PageObject {
  protected readonly landmark = TID.filesScreen;
  constructor(page: Page, readonly team: string) {
    super(page);
  }
  async open(path = ''): Promise<this> {
    return this.goto(`/t/${this.team}/files${path}`);
  }
  get rows(): Locator {
    return this.tid(TID.fileRow);
  }
  row(name: string | RegExp): Locator {
    return this.rows.filter({ hasText: name }).first();
  }
  /** Opens a file or folder from the list. */
  async openRow(name: string | RegExp): Promise<void> {
    await this.row(name).click();
  }
  get viewer(): Locator {
    return this.tid(TID.fileView);
  }
  async expectDenied(): Promise<void> {
    await expect(this.tid(TID.filesDenied)).toBeVisible();
  }
}
