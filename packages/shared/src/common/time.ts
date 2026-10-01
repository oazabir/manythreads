import { z } from 'zod';

/** ISO-8601 date-time string; dates cross the wire as strings (B.2 rule 5). */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;
