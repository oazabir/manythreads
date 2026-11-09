import { expect, type Locator, type Page } from '@playwright/test';

/** Shared by every page object: it wraps one Playwright page and knows its screen's landmark. */
export abstract class PageObject {
  constructor(readonly page: Page) {}

  /** The testid or landmark that says "this screen is up". */
  protected abstract readonly landmark: string;

  protected tid(id: string): Locator {
    return this.page.getByTestId(id);
  }

  /** The landmark of this screen, as the harness checks it (`data-landmark` or `data-testid`). */
  get root(): Locator {
    return this.page.locator(`[data-landmark=${JSON.stringify(this.landmark)}],[data-testid=${JSON.stringify(this.landmark)}]`).first();
  }

  /** Waits until the screen's landmark is visible. */
  async expectLoaded(timeoutMs = 15_000): Promise<this> {
    await expect(this.root, `${this.constructor.name}: "${this.landmark}" is not visible at ${this.page.url()}`).toBeVisible({ timeout: timeoutMs });
    return this;
  }

  /** The path part of the current address. */
  get path(): string {
    const u = new URL(this.page.url());
    return `${u.pathname}${u.search}`;
  }

  protected async goto(path: string): Promise<this> {
    await this.page.goto(path);
    return this.expectLoaded();
  }
}
