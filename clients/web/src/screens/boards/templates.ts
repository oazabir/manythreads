import { CreateBoardRequest, MAX_BOARD_COLUMNS, TaskState, type NewBoardColumn } from '@manythreads/shared';

/*
 * The three boards an empty Boards page offers (PLAN P21-15). A template is only a name and a list of columns for the existing "create a
 * board" call; nothing new is stored. Each one has a column for every task state: a card in a state the board has no column for would
 * not be drawn at all, so a template never leaves one out.
 */

export type BoardTemplateId = 'delivery' | 'support' | 'content';

export type BoardTemplate = {
  id: BoardTemplateId;
  name: string;
  /** One line that says what the board is for. */
  line: string;
  columns: readonly NewBoardColumn[];
};

export const BOARD_TEMPLATES: readonly BoardTemplate[] = [
  {
    id: 'delivery',
    name: 'Delivery',
    line: 'Follow work from an idea to shipped, with a review step before it counts as done.',
    columns: [
      { name: 'Backlog', state: 'open' },
      { name: 'Building', state: 'in_progress' },
      { name: 'In review', state: 'verify' },
      { name: 'Blocked', state: 'waiting_on_person' },
      { name: 'Shipped', state: 'done' },
    ],
  },
  {
    id: 'support',
    name: 'Support queue',
    line: 'Keep every customer question in one line, from first reply to solved.',
    columns: [
      { name: 'New', state: 'open' },
      { name: 'Being answered', state: 'in_progress' },
      { name: 'Checking', state: 'verify' },
      { name: 'Waiting on the customer', state: 'waiting_on_person' },
      { name: 'Solved', state: 'done' },
    ],
  },
  {
    id: 'content',
    name: 'Content calendar',
    line: 'Plan posts and pages: from an idea to written, edited and published.',
    columns: [
      { name: 'Ideas', state: 'open' },
      { name: 'Writing', state: 'in_progress' },
      { name: 'Editing', state: 'verify' },
      { name: 'Ready to publish', state: 'waiting_on_person' },
      { name: 'Published', state: 'done' },
    ],
  },
];

/** What "Start from this template" sends: the template's name and its columns, in the shape the create-board call takes. */
export function templateRequest(template: BoardTemplate): CreateBoardRequest {
  return CreateBoardRequest.parse({ name: template.name, columns: template.columns.map((c) => ({ ...c })) });
}

/** True when every task state has a column and the list fits the board's limit: what each template above promises. */
export function coversEveryState(columns: readonly NewBoardColumn[]): boolean {
  return columns.length <= MAX_BOARD_COLUMNS && TaskState.options.every((state) => columns.some((c) => c.state === state));
}
