import { expect, type Locator, type Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** The approvals inbox (`/t/<team>/approvals`): what bots asked to do and a person must allow. */
export class ApprovalsPage extends PageObject {
  protected readonly landmark = TID.approvalsInbox;
  constructor(page: Page, readonly team: string) {
    super(page);
  }
  async open(): Promise<this> {
    return this.goto(`/t/${this.team}/approvals`);
  }
  get rows(): Locator {
    return this.tid(TID.approvalRow);
  }
  row(text: string | RegExp): Locator {
    return this.rows.filter({ hasText: text }).first();
  }
  /** Opens a request (its card appears on the right). */
  async select(text: string | RegExp): Promise<Locator> {
    await this.row(text).click();
    const card = this.tid(TID.approvalCard);
    await expect(card).toBeVisible();
    return card;
  }
  /** Approves the open request, with a note when given, and waits for the outcome line. */
  async approve(note?: string): Promise<void> {
    if (note !== undefined) await this.tid(TID.approvalNote).fill(note);
    await this.tid(TID.approvalApprove).click();
    await expect(this.tid(TID.approvalOutcome)).toBeVisible();
  }
  /** Declines the open request, with a note when given. */
  async deny(note?: string): Promise<void> {
    if (note !== undefined) await this.tid(TID.approvalNote).fill(note);
    await this.tid(TID.approvalDeny).click();
    await expect(this.tid(TID.approvalOutcome)).toBeVisible();
  }
}
