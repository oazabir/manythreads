// A sign-in method on the Security page is a chip with its name and a check mark; a screen reader hears it as "<name> is set up" (not "<name> ok").
export const signInMethodSentence = (label: string): string => `${label} is set up`;
