import { z } from 'zod';

// How the app looks for one person (P21-21): the colour theme and the message density. Stored as two columns on the person (kernel migration 0017), served in
// `GET /api/session` and changed by `PUT /api/me/appearance`. The web client draws them with attributes on <html> (clients/web/src/shell/appearance.ts).

/** `system` follows the device's light or dark setting until the person picks one. */
export const ThemeChoice = z.enum(['system', 'light', 'dark']);
export type ThemeChoice = z.infer<typeof ThemeChoice>;

/** How close messages sit in a channel, a direct message and the thread panel. */
export const Density = z.enum(['comfortable', 'compact']);
export type Density = z.infer<typeof Density>;

export const Appearance = z.object({ theme: ThemeChoice, density: Density });
export type Appearance = z.infer<typeof Appearance>;

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', density: 'comfortable' };
