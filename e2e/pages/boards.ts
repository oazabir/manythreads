import type { Locator, Page } from '@playwright/test';
import { PageObject } from './base.ts';
import { TID } from './testids.ts';

/** The team boards (`/t/<team>/boards`): columns of cards, the Bot Board among them. */
export class BoardsPage extends PageObject {
  protected readonly landmark = TID.boardsScreen;
  constructor(page: Page, readonly team: string) {
    super(page);
  }
  async open(): Promise<this> {
    return this.goto(`/t/${this.team}/boards`);
  }
  get board(): Locator {
    return this.tid(TID.boardView);
  }
  get columns(): Locator {
    return this.tid(TID.boardColumn);
  }
  column(name: string | RegExp): Locator {
    return this.columns.filter({ hasText: name }).first();
  }
  cards(column?: Locator): Locator {
    return (column ?? this.board).getByTestId(TID.boardCard);
  }
  card(title: string | RegExp): Locator {
    return this.cards().filter({ hasText: title }).first();
  }
  /** Opens a card's panel. */
  async openCard(title: string | RegExp): Promise<Locator> {
    await this.card(title).click();
    const panel = this.tid(TID.cardPanel);
    await panel.waitFor();
    return panel;
  }
}
