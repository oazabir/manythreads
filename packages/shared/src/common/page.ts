import { z } from 'zod';

/** Opaque pagination cursor; clients echo it back unchanged. */
export const Cursor = z.string().min(1).max(2048).brand<'Cursor'>();
export type Cursor = z.infer<typeof Cursor>;

/** Page<T> schema factory: `Page(Message)` validates `{ items: Message[], nextCursor }`. */
export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: Cursor.nullable() });

export type Page<T> = { items: T[]; nextCursor: Cursor | null };
