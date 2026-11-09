import { expect, type Locator, type Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** Workspace members (`/settings/workspace/members`). */
export class MembersPage extends PageObject {
  protected readonly landmark = TID.membersSearch;
  constructor(page: Page) {
    super(page);
  }
  async open(): Promise<this> {
    return this.goto('/settings/workspace/members');
  }
  get rows(): Locator {
    return this.tid(TID.memberRow);
  }
  row(name: string | RegExp): Locator {
    return this.rows.filter({ hasText: name }).first();
  }
  async search(text: string): Promise<void> {
    await this.tid(TID.membersSearch).fill(text);
  }
}

/** Workspace LLM settings (`/settings/workspace/llm`): providers, aliases, budgets. */
export class AdminLlmPage extends PageObject {
  protected readonly landmark = TID.llmAliases;
  constructor(page: Page) {
    super(page);
  }
  async open(): Promise<this> {
    return this.goto('/settings/workspace/llm');
  }
  get providers(): Locator {
    return this.tid(TID.llmProviders);
  }
  get aliases(): Locator {
    return this.tid(TID.llmAliases);
  }
  get limits(): Locator {
    return this.tid(TID.llmLimits);
  }
}

/** The audit log (`/settings/workspace/audit`). */
export class AuditPage extends PageObject {
  protected readonly landmark = 'audit';
  constructor(page: Page) {
    super(page);
  }
  async open(): Promise<this> {
    return this.goto('/settings/workspace/audit');
  }
  get table(): Locator {
    return this.tid(TID.auditTable);
  }
  /** The audit rows that mention a piece of text. */
  rowsWith(text: string | RegExp): Locator {
    return this.table.locator('tr, [role="row"]').filter({ hasText: text });
  }
  get exportButton(): Locator {
    return this.tid(TID.auditExport);
  }
  async expectDenied(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: /You do not have access|Page not found/ })).toBeVisible();
  }
}

/** The Runners page (`/settings/workspace/runners`): where bots run. */
export class RunnersPage extends PageObject {
  protected readonly landmark = 'app-frame';
  constructor(page: Page) {
    super(page);
  }
  async open(): Promise<this> {
    await this.goto('/settings/workspace/runners');
    await expect(this.tid(TID.runnerList).or(this.tid('runner-empty')).first()).toBeVisible();
    return this;
  }
  get rows(): Locator {
    return this.tid(TID.runnerRow);
  }
  get addButton(): Locator {
    return this.tid(TID.runnerAdd);
  }
}
