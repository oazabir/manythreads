export * from './ports.ts';
import { AUTH_DIR } from './ports.ts';

export const PERSONA_KEYS = ['omar', 'nadia', 'rafi', 'sameera', 'tariq', 'priya', 'lena'] as const;
export type PersonaKey = (typeof PERSONA_KEYS)[number];

export const personaEmail = (key: PersonaKey): string => `${key}@kahf.example`;
export { PERSONA_PASSWORD } from '@manythreads/test-utils';

/** Signed-in browser state of a persona, written by global-setup through the real password sign-in. */
export const authState = (key: PersonaKey): string => `${AUTH_DIR}${key}.json`;
