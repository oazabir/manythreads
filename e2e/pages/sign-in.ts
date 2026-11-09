import { expect, type Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** The sign-in screen (`/sign-in`). The two fields and the button are found by their label: this is the one screen that has no testids, because a person finds them that way too. */
export class SignInPage extends PageObject {
  protected readonly landmark = TID.frame;
  constructor(page: Page) {
    super(page);
  }

  get email() {
    return this.page.getByLabel('Email');
  }
  get password() {
    return this.page.getByLabel('Password', { exact: true });
  }
  get submit() {
    return this.page.getByRole('button', { name: 'Sign in' });
  }

  async open(): Promise<this> {
    await this.page.goto('/sign-in');
    await this.expectLoaded();
    return this;
  }

  /** Types the address and password through the real form and waits for the app to open. When the screen offers company sign-in first, it chooses the password form. */
  async signInWithPassword(email: string, password: string): Promise<void> {
    if (!(await this.email.isVisible())) await this.page.getByRole('button', { name: 'sign in with a password' }).click();
    await this.email.fill(email);
    await this.password.fill(password);
    await this.submit.click();
    await expect(this.page).not.toHaveURL(/\/sign-in/);
  }
}
