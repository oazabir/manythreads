import { z } from 'zod';

// How the app looks for one person (P21-21, P28-04): the colour mode, the palette and the message density. Stored as columns on the person (kernel migrations 0017 and 0018), served in
// `GET /api/session` and changed by `PUT /api/me/appearance`. The web client draws them with attributes on <html> (clients/web/src/shell/appearance.ts).

/** `system` follows the device's light or dark setting until the person picks one. */
export const ThemeChoice = z.enum(['system', 'light', 'dark']);
export type ThemeChoice = z.infer<typeof ThemeChoice>;

/** How close messages sit in a channel, a direct message and the thread panel. */
export const Density = z.enum(['comfortable', 'compact']);
export type Density = z.infer<typeof Density>;

/**
 * The look of the app (P28, docs/design/themes.md): `classic` is the look the app had before themes, the default; `graphite`, `linen` and `harbor` are the
 * three themes, each with a light and a dark version (the `theme` field above picks which one is drawn).
 */
export const Palette = z.enum(['classic', 'graphite', 'linen', 'harbor']);
export type Palette = z.infer<typeof Palette>;

/** A palette missing from an older server's answer or an older browser copy is the classic one. */
export const Appearance = z.object({ theme: ThemeChoice, density: Density, palette: Palette.default('classic') });
export type Appearance = z.infer<typeof Appearance>;

export const DEFAULT_PALETTE: Palette = 'classic';
export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', density: 'comfortable', palette: DEFAULT_PALETTE };
