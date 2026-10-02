/** Only same-origin absolute paths are accepted as a return target. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
}

export const signInUrl = (returnPath: string): string =>
  returnPath === '/' ? '/sign-in' : `/sign-in?return=${encodeURIComponent(returnPath)}`;

