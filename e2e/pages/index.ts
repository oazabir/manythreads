// Page objects (PLAN P12-02, "Extract page objects into e2e/pages"): the steps five specs repeated (sign in, open a channel, ask Brain), once. Journeys are built
// from these. Every locator goes through a `data-testid` or a landmark (testids.ts); a journey that has to find a button by its label is a UX finding in waiting.
import type { Page } from '@playwright/test';
import { AdminLlmPage, AuditPage, MembersPage, RunnersPage } from './admin.ts';
import { ApprovalsPage } from './approvals.ts';
import { BoardsPage } from './boards.ts';
import { BotPage, BotsRosterPage } from './bots.ts';
import { BrainPage, ConversationPage } from './brain.ts';
import { ChannelPage, ThreadPanel, ThreadsInboxPage } from './channel.ts';
import { FilesPage } from './files.ts';
import { MemoryPage } from './memory.ts';
import { SearchPage } from './search.ts';
import { ShellPage } from './shell.ts';
import { SignInPage } from './sign-in.ts';

export * from './base.ts';
export * from './testids.ts';
export { AdminLlmPage, AuditPage, MembersPage, RunnersPage, ApprovalsPage, BoardsPage, BotPage, BotsRosterPage, BrainPage, ConversationPage, ChannelPage, ThreadPanel, ThreadsInboxPage, FilesPage, MemoryPage, SearchPage, ShellPage, SignInPage };

/** All the page objects bound to one page. Built on first use, so a journey pays only for what it touches. */
export class Pages {
  constructor(readonly page: Page, readonly team = 'engineering') {}
  get signIn(): SignInPage { return new SignInPage(this.page); }
  get shell(): ShellPage { return new ShellPage(this.page, this.team); }
  get channel(): ChannelPage { return new ChannelPage(this.page, this.team); }
  get thread(): ThreadPanel { return new ThreadPanel(this.page); }
  get threads(): ThreadsInboxPage { return new ThreadsInboxPage(this.page, this.team); }
  get brain(): BrainPage { return new BrainPage(this.page, this.team); }
  get conversation(): ConversationPage { return new ConversationPage(this.page, this.team); }
  get bots(): BotsRosterPage { return new BotsRosterPage(this.page, this.team); }
  get bot(): BotPage { return new BotPage(this.page, this.team); }
  get approvals(): ApprovalsPage { return new ApprovalsPage(this.page, this.team); }
  get boards(): BoardsPage { return new BoardsPage(this.page, this.team); }
  get files(): FilesPage { return new FilesPage(this.page, this.team); }
  get members(): MembersPage { return new MembersPage(this.page); }
  get llm(): AdminLlmPage { return new AdminLlmPage(this.page); }
  get audit(): AuditPage { return new AuditPage(this.page); }
  get runners(): RunnersPage { return new RunnersPage(this.page); }
  get search(): SearchPage { return new SearchPage(this.page, this.team); }
  get memory(): MemoryPage { return new MemoryPage(this.page, this.team); }
  /** The same pages for another team (Priya has two). */
  inTeam(team: string): Pages { return new Pages(this.page, team); }
}
