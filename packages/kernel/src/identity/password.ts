import { hash, verify } from '@node-rs/argon2';

/** Minimum password length (SPEC §4, policy min 12). */
export const MIN_PASSWORD_LENGTH = 12;

/** argon2id hash in PHC format (`$argon2id$...`); @node-rs/argon2 defaults to Argon2id with a random salt. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** False for a wrong password or a malformed hash; never throws on bad input. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
