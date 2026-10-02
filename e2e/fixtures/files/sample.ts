/** A release checklist item. */
export interface Item {
  id: string;
  title: string;
  done: boolean;
}

export function remaining(items: readonly Item[]): number {
  // count the ones still open
  return items.filter((i) => !i.done).length;
}

export const defaults: Item[] = [
  { id: 'tag', title: 'Tag the release', done: false },
  { id: 'notes', title: 'Update the changelog', done: true },
];
