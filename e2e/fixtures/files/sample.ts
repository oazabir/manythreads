import { z } from 'zod';

/** A release checklist item. */
export const Item = z.object({
  id: z.string(),
  title: z.string().min(1),
  done: z.boolean().default(false),
});
export type Item = z.infer<typeof Item>;

export function remaining(items: readonly Item[]): number {
  // count the ones still open
  return items.filter((i) => !i.done).length;
}
