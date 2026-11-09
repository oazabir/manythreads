// Every `data-testid` / `data-landmark` the page objects use, in one place, so a renamed testid is one line here and a failing unit test
// (e2e/personas/harness/test/pages.test.ts) that greps the web client for each value, not a journey that fails at 3 a.m.
export const TID = {
  frame: 'app-frame',
  // shell
  topic: 'channel-topic',
  bottomBar: 'bottom-bar',
  barSearch: 'bar-search',
  barYou: 'bar-you',
  accountSheet: 'account-sheet',
  menuMyMemory: 'menu-my-memory',
  menuMyKnowledge: 'menu-my-knowledge',
  // channel and composer
  channelView: 'channel-view',
  noAccess: 'no-access',
  readOnly: 'read-only',
  channelStart: 'channel-start',
  botBoardLink: 'bot-board-link',
  message: 'message',
  composer: 'composer',
  send: 'send',
  // thread panel and inbox
  threadView: 'thread-view',
  threadsInbox: 'threads-inbox',
  // Brain conversation (the Chat screen) and a bot's conversation
  chatScreen: 'chat-screen',
  chatMain: 'chat-main',
  chatMessage: 'chat-message',
  chatThinking: 'chat-thinking',
  chatEmpty: 'chat-empty',
  chatPrompts: 'chat-prompts',
  chatBotName: 'chat-bot-name',
  answer: 'answer',
  answerCitations: 'answer-citations',
  answerCitation: 'answer-citation',
  answerOutside: 'answer-outside',
  conversationView: 'conversation-view',
  // bots
  botsRoster: 'bots-roster',
  botRow: 'bot-row',
  botPage: 'bot-page',
  botTalk: 'bot-talk',
  // approvals
  approvalsInbox: 'approvals-inbox',
  approvalRow: 'approval-row',
  approvalCard: 'approval-card',
  approvalApprove: 'approval-approve',
  approvalDeny: 'approval-deny',
  approvalNote: 'approval-note',
  approvalOutcome: 'approval-outcome',
  // boards
  boardsScreen: 'boards-screen',
  boardView: 'board-view',
  boardColumn: 'board-column',
  boardCard: 'board-card',
  cardPanel: 'card-panel',
  // files
  filesScreen: 'files-screen',
  fileRow: 'file-row',
  fileView: 'file-view',
  filesDenied: 'files-denied',
  // members, admin, audit, runners
  membersSearch: 'members-search',
  memberRow: 'member-row',
  llmProviders: 'llm-providers',
  llmAliases: 'llm-aliases',
  llmLimits: 'llm-limits',
  auditTable: 'audit-table',
  auditExport: 'audit-export',
  runnerList: 'runner-list',
  runnerRow: 'runner-row',
  runnerAdd: 'runner-add',
  // search
  searchResults: 'search-results',
  searchHit: 'search-hit',
  searchEmpty: 'search-empty',
  // memory and the team inbox
  memoryTabs: 'memory-tabs',
  conceptList: 'concept-list',
  conceptRow: 'concept-row',
  conceptDetail: 'concept-detail',
  inboxTab: 'inbox-tab',
  inboxList: 'inbox-list',
  inboxItem: 'inbox-item',
  inboxDropzone: 'inbox-dropzone',
} as const;

export type TestId = (typeof TID)[keyof typeof TID];
