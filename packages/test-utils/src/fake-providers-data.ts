// What the fake Google, Microsoft and Notion accounts hold by default: a small, Kahf-shaped set of files, mail, events and pages, so a screen, a bot or a test has
// something real-looking to search and read. Every text carries one distinctive fact that a test can look for. Nothing here is a credential.

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  modified: string;
  text: string;
}

export interface FakeMail {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  /** The body as plain text. */
  text: string;
  /** Gmail label ids on it (default: INBOX). */
  labels?: string[];
  /** Gmail's conversation id (default: the mail's own id). */
  threadId?: string;
  /** Outlook: the folder it is in (default `inbox`). */
  folder?: string;
  /** Outlook: the colour categories on it (default none). */
  categories?: string[];
  /** Outlook: read or not (default: unread). */
  isRead?: boolean;
}

export interface FakeEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  guests?: string[];
}

export interface FakeNotionPage {
  id: string;
  title: string;
  /** One block per entry: `# ` and `## ` lines become headings, `- ` lines bullets, the rest paragraphs. */
  blocks: string[];
}

/** A Gmail label of an account. The built-in ones (INBOX, UNREAD, STARRED, IMPORTANT, TRASH, SPAM, SENT, DRAFT) are always there. */
export interface FakeLabel {
  id: string;
  name: string;
}

/** An Outlook colour category of an account. */
export interface FakeCategory {
  name: string;
  color: string;
}

export interface FakeAccountData {
  /** The address the provider reports for the account. */
  email: string;
  /** The account's own Gmail labels; default: Invoices and Offsite. */
  labels?: FakeLabel[];
  /** The account's Outlook categories; default: Customer, Urgent and Offsite. */
  categories?: FakeCategory[];
  /** Files in SharePoint sites the account can open (found by the Microsoft search and read by drive and item id); default none. */
  siteFiles?: FakeFile[];
  files: FakeFile[];
  mails: FakeMail[];
  events: FakeEvent[];
  pages: FakeNotionPage[];
}

export const DOC = 'application/vnd.google-apps.document';
export const SHEET = 'application/vnd.google-apps.spreadsheet';

/** The default account: the owner of the seeded workspace, with documents, mail, a week of events and two Notion pages. */
export function defaultAccount(email = 'omar@kahf.example'): FakeAccountData {
  return {
    email,
    labels: [
      { id: 'Label_invoices', name: 'Invoices' },
      { id: 'Label_offsite', name: 'Offsite' },
    ],
    files: [
      {
        id: 'file-roadmap',
        name: 'Q4 roadmap',
        mimeType: DOC,
        modified: '2026-10-28T09:30:00.000Z',
        text: 'Q4 roadmap\n\nThe launch of the Lantern release is set for the 18th of November.\nThe owner of the migration work is Nadia.\n',
      },
      {
        id: 'file-budget',
        name: 'Hosting budget',
        mimeType: SHEET,
        modified: '2026-10-20T14:00:00.000Z',
        text: 'item,monthly cost\nservers,420\nbackups,65\nmonitoring,38\n',
      },
      { id: 'file-notes', name: 'Customer call notes.txt', mimeType: 'text/plain', modified: '2026-10-30T16:45:00.000Z', text: 'Call with the Harbour Grain team: they want the export in CSV by the end of the month.\n' },
      { id: 'file-photo', name: 'Office photo.png', mimeType: 'image/png', modified: '2026-09-01T08:00:00.000Z', text: '' },
    ],
    mails: [
      {
        id: 'mail-invoice',
        from: 'billing@harbourgrain.example',
        to: email,
        subject: 'Invoice 2041 is overdue',
        labels: ['INBOX', 'UNREAD', 'Label_invoices'],
        date: 'Fri, 30 Oct 2026 10:12:00 +0000',
        text: 'Hello,\n\nInvoice 2041 for 1,980 dollars was due on the 25th. Please confirm the payment date.\n\nHarbour Grain billing\n',
      },
      {
        id: 'mail-offsite',
        from: 'nadia@kahf.example',
        to: email,
        subject: 'Offsite venue',
        date: 'Thu, 29 Oct 2026 17:20:00 +0000',
        text: 'The venue for the offsite is the old mill in Aldergrove. Booking closes on Friday.\n',
      },
    ],
    events: [
      { id: 'event-standup', title: 'Team stand-up', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T09:15:00.000Z', location: 'Room Cedar', guests: ['nadia@kahf.example'] },
      { id: 'event-review', title: 'Roadmap review', start: '2026-11-04T13:00:00.000Z', end: '2026-11-04T14:00:00.000Z', location: 'Video call', guests: ['nadia@kahf.example', 'tariq@kahf.example'] },
    ],
    pages: [
      { id: 'page-handbook', title: 'Team handbook', blocks: ['# Team handbook', 'Support hours are 8 to 6, Monday to Friday.', '## Escalation', '- Page the on-call engineer first', '- Then message the team lead'] },
      { id: 'page-ideas', title: 'Ideas shelf', blocks: ['Ideas for next quarter.', '- A weekly digest for customers'] },
    ],
  };
}
