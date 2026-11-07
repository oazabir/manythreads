import { z } from 'zod';
import { Appearance, Density, ThemeChoice } from '../../entities/appearance.ts';

// The person's own look (P21-21): the avatars plugin keeps it beside the profile picture, since both are a setting of the person's own row.

/** Change the theme, the density, or both; a field left out stays as it was. At least one is required. */
export const SetMyAppearanceRequest = z
  .strictObject({ theme: ThemeChoice.optional(), density: Density.optional() })
  .refine((v) => v.theme !== undefined || v.density !== undefined, { message: 'Send a theme, a density or both.' });
export type SetMyAppearanceRequest = z.infer<typeof SetMyAppearanceRequest>;
export const setMyAppearanceRoute = { method: 'PUT', path: '/api/me/appearance' } as const;

/** What is stored now. */
export const MyAppearanceResponse = Appearance;
export type MyAppearanceResponse = z.infer<typeof MyAppearanceResponse>;
