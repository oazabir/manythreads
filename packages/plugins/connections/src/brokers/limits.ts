// How long a credential a broker issues may live (SPEC §11, PLAN P8-04): one hour at most, and one task at a time. Every broker clamps through this one
// function, and the tests assert it, so no kind can ask for a longer life.

/** The longest an issued certificate or token lives, in seconds. */
export const MAX_CREDENTIAL_SECONDS = 3600;
/** What is asked for when nobody says: ten minutes, which is also the least a Kubernetes API accepts for a token. */
export const DEFAULT_CREDENTIAL_SECONDS = 600;
/** The least a Kubernetes API accepts for a requested token. */
export const MIN_CREDENTIAL_SECONDS = 600;

/** A requested life, held between the least the services accept and one hour. */
export function clampLifetime(requested: number | undefined): number {
  const wanted = requested === undefined || !Number.isFinite(requested) ? DEFAULT_CREDENTIAL_SECONDS : Math.floor(requested);
  return Math.min(MAX_CREDENTIAL_SECONDS, Math.max(MIN_CREDENTIAL_SECONDS, wanted));
}
