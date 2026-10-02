import { createHash, randomBytes } from 'node:crypto';

/** A one-time link token: 256 random bits, base64url. Shown once (mail or log), stored only as its hash. */
export const newLinkToken = (): string => randomBytes(32).toString('base64url');

export const hashLinkToken = (token: string): Buffer => createHash('sha256').update(token).digest();
