/*
 * The small mark beside an author's name when the author is not a person or a bot. The server gives two kinds of sender the author kind `system`: an
 * incoming webhook, and the "Reminders" sender that delivers a reminder (P14-04); an imported person's placeholder is a third, with no marker and no badge. The server says which one in `author.sender` (it is never read from the
 * name, which a webhook's admin chooses), so a webhook called "Reminders" still shows "Webhook", and a reminder is not labelled as a webhook.
 */

export type AuthorMark = { label: 'Webhook' | 'System'; title: string };

export function authorMark(author: { kind: string; sender?: 'reminders' | 'webhook' | null } | null | undefined): AuthorMark | null {
  if (!author || author.kind !== 'system') return null;
  if (author.sender === 'reminders') return { label: 'System', title: 'Sent by manythreads, not by a person' };
  if (author.sender === 'webhook') return { label: 'Webhook', title: 'Posted by an incoming webhook, not by a person' };
  // a system author with no marker is neither (an imported person's placeholder, P14-13): its name already says "(imported)", so no badge guesses
  return null;
}
