import type { DlpDetectorSetting, DlpRuleSetting, TestDlpResponse } from '@manythreads/shared';

// Words and small conversions for Settings > Workspace > Data protection. Plain functions, so a test can read them without a browser.

/** What each setting is called on the screen. `preset` follows the workspace default, which is set under the model settings. */
export const DETECTOR_ACTION_LABELS: Record<DlpDetectorSetting, string> = {
  preset: 'Workspace default',
  allow: 'Do nothing',
  redact: 'Hide the match',
  require_approval: 'Ask a person first',
  block: 'Stop it',
};

export const RULE_ACTION_LABELS: Record<DlpRuleSetting, string> = {
  preset: 'Workspace default',
  redact: 'Hide the match',
  require_approval: 'Ask a person first',
  block: 'Stop it',
};

export const DETECTOR_ACTION_HINTS: Record<DlpDetectorSetting, string> = {
  preset: "Follows the workspace's model setting: stopped under the strictest one, hidden otherwise. Tool calls from bots always count as the standard setting, so there it is hidden.",
  allow: 'Not looked for.',
  redact: 'The text goes on with the match replaced by a marker.',
  require_approval: 'Nothing is sent until a person approves the version with the match hidden.',
  block: 'Nothing is sent, and the bot is told what kind of thing it carried.',
};

/** One sentence for the result of the test box. Never repeats the text that was tried. */
export function testOutcomeWords(result: TestDlpResponse): string {
  const found = result.findings.map((f) => `${f.rule}${f.count > 1 ? ` (${f.count})` : ''}`).join(', ');
  switch (result.outcome) {
    case 'allow':
      return result.findings.length === 0 ? 'Nothing was found. This text would go through as it is.' : `Found ${found}, and the policy lets it through.`;
    case 'redact':
      return `Found ${found}. The text would go on with each match replaced by a marker.`;
    case 'require_approval':
      return `Found ${found}. A person would have to approve the version with the matches hidden before anything is sent.`;
    case 'block':
      return `Found ${found}. This would be stopped and nothing would be sent.`;
  }
}

/** The hosts typed into the box: one per line or separated by commas or spaces, blanks dropped, repeats dropped. */
export function hostsFromText(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\s,]+/)) {
    const host = part.trim();
    if (host !== '') seen.add(host);
  }
  return [...seen];
}

export const hostsToText = (hosts: readonly string[]): string => hosts.join('\n');

/** The proxy field: blank means no proxy. */
export const proxyFromText = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/** A short line saying how many hosts a team may reach, for the team's heading. */
export function teamEgressSummary(enforce: boolean, hostCount: number): string {
  if (!enforce) return hostCount === 0 ? 'No limit set' : `Not limiting (${hostCount} saved)`;
  return hostCount === 0 ? 'Limited to the workspace list' : `Limited to ${hostCount} ${hostCount === 1 ? 'host' : 'hosts'} and the workspace list`;
}
