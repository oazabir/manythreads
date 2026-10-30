import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { DlpRuleId, TeamId } from '../ids.ts';

// Workspace > Data protection (PLAN P10-04, SPEC §15). Two things an admin sets: what the data-loss check does when it finds something in text that
// is about to leave (per kind of finding, plus patterns the admin writes), and where each team's bots may reach (a per-team list of hosts, an
// optional proxy). Neither carries the text that was matched: a finding is a name and a count everywhere it is recorded.

/** What happens to text that holds a finding. `block` stops the call, `require_approval` holds it for a person (the held copy is redacted), `redact` swaps the finding for a marker and goes on, `allow` ignores it. */
export const DlpAction = z.enum(['allow', 'redact', 'require_approval', 'block']);
export type DlpAction = z.infer<typeof DlpAction>;

/** A detector's setting: one of the four actions, or `preset` — do what the workspace's guard preset says (`standard` redacts, `customer-facing` refuses). */
export const DlpDetectorSetting = z.enum(['preset', 'allow', 'redact', 'require_approval', 'block']);
export type DlpDetectorSetting = z.infer<typeof DlpDetectorSetting>;

/** The setting of a custom rule: it can follow the preset too, but never `allow` (a rule that does nothing is a disabled rule). */
export const DlpRuleSetting = z.enum(['preset', 'redact', 'require_approval', 'block']);
export type DlpRuleSetting = z.infer<typeof DlpRuleSetting>;

export const DLP_DETECTOR_GROUPS = ['secrets', 'personal'] as const;
export const DlpDetectorGroup = z.enum(DLP_DETECTOR_GROUPS);
export type DlpDetectorGroup = z.infer<typeof DlpDetectorGroup>;

export interface DlpDetectorInfo {
  name: string;
  label: string;
  description: string;
  group: DlpDetectorGroup;
  /** What the detector does until an admin chooses: the secret kinds follow the preset, the personal-data kinds are off. */
  defaultSetting: DlpDetectorSetting;
}

/** The built-in detectors, in the order the screen lists them. The names are what an event or a redaction marker carries. */
export const DLP_DETECTORS: readonly DlpDetectorInfo[] = [
  { name: 'private-key', label: 'Private keys', description: 'A block that starts with "BEGIN … PRIVATE KEY" (the whole block is covered, not just the header).', group: 'secrets', defaultSetting: 'preset' },
  { name: 'api-key', label: 'API keys and tokens', description: 'Keys that look like OpenAI or Anthropic keys, AWS access keys, GitHub tokens and Slack tokens.', group: 'secrets', defaultSetting: 'preset' },
  { name: 'bearer-token', label: 'Bearer tokens', description: 'The word "Bearer" followed by a long token, as found in request headers.', group: 'secrets', defaultSetting: 'preset' },
  { name: 'credential-url', label: 'Web addresses with a password', description: 'Addresses of the form scheme://user:password@host, as found in connection strings.', group: 'secrets', defaultSetting: 'preset' },
  { name: 'secret-assignment', label: 'Passwords and secrets in code', description: 'A line that sets a name such as password, secret, token or api_key to a long value, as in a config file or an .env file.', group: 'secrets', defaultSetting: 'allow' },
  { name: 'card-number', label: 'Payment card numbers', description: 'Thirteen to nineteen digits that pass the card checksum.', group: 'personal', defaultSetting: 'preset' },
  { name: 'email-address', label: 'Email addresses', description: 'Anything shaped like name@example.com.', group: 'personal', defaultSetting: 'allow' },
  { name: 'phone-number', label: 'Phone numbers', description: 'International numbers that start with a plus sign and hold at least eight digits.', group: 'personal', defaultSetting: 'allow' },
  { name: 'iban', label: 'Bank account numbers (IBAN)', description: 'International bank account numbers that pass the IBAN checksum.', group: 'personal', defaultSetting: 'allow' },
];
export const DLP_DETECTOR_NAMES = DLP_DETECTORS.map((d) => d.name) as [string, ...string[]];
export const DlpDetectorName = z.enum(DLP_DETECTOR_NAMES);
export type DlpDetectorName = z.infer<typeof DlpDetectorName>;

/** Custom rules per workspace, and the longest pattern. A rule is a pattern in the small, linear-time subset the bot gate lists use (no look-ahead, no back-references). */
export const DLP_CUSTOM_RULES_MAX = 20;
export const DLP_PATTERN_MAX_LENGTH = 190;
/** Text the test box accepts. */
export const DLP_TEST_TEXT_MAX = 20_000;

/** Names a custom rule cannot take: the built-in detectors' (an event or a marker would not tell them apart) and the two the check itself writes. */
export const DLP_RESERVED_NAMES: readonly string[] = [...DLP_DETECTOR_NAMES, 'scan-limit', 'unnamed'];

/** A rule's name: what an event and a marker carry in place of the matched text. */
export const DlpRuleName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Use 1 to 40 lower-case letters, digits, dashes or underscores, starting with a letter or digit.')
  .refine((name) => !DLP_RESERVED_NAMES.includes(name), 'That name is used by the system; pick another.');

export const DlpCustomRule = z.object({
  id: DlpRuleId,
  name: DlpRuleName,
  pattern: z.string().min(1).max(DLP_PATTERN_MAX_LENGTH),
  ignoreCase: z.boolean(),
  action: DlpRuleSetting,
  enabled: z.boolean(),
  updatedAt: IsoDateTime,
});
export type DlpCustomRule = z.infer<typeof DlpCustomRule>;

export const DlpDetectorState = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  group: DlpDetectorGroup,
  /** What the admin chose, or the detector's default when nothing was chosen. */
  action: DlpDetectorSetting,
  /** True once an admin has chosen. */
  custom: z.boolean(),
});
export type DlpDetectorState = z.infer<typeof DlpDetectorState>;

export const DlpPolicy = z.object({
  detectors: z.array(DlpDetectorState),
  rules: z.array(DlpCustomRule),
});
export type DlpPolicy = z.infer<typeof DlpPolicy>;

export const SetDlpDetectorRequest = z.strictObject({ action: DlpDetectorSetting });
export type SetDlpDetectorRequest = z.infer<typeof SetDlpDetectorRequest>;

export const CreateDlpRuleRequest = z.strictObject({
  name: DlpRuleName,
  pattern: z.string().min(1).max(DLP_PATTERN_MAX_LENGTH),
  ignoreCase: z.boolean().default(false),
  action: DlpRuleSetting.default('redact'),
  enabled: z.boolean().default(true),
});
export type CreateDlpRuleRequest = z.infer<typeof CreateDlpRuleRequest>;

export const UpdateDlpRuleRequest = z
  .strictObject({
    name: DlpRuleName.optional(),
    pattern: z.string().min(1).max(DLP_PATTERN_MAX_LENGTH).optional(),
    ignoreCase: z.boolean().optional(),
    action: DlpRuleSetting.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateDlpRuleRequest = z.infer<typeof UpdateDlpRuleRequest>;

/**
 * Try the policy on a piece of text without saving anything. The text is judged in memory, answered and forgotten: it is not stored, logged or put in an
 * event. `rule` is an unsaved custom rule to try as well (so a pattern can be checked before it is kept).
 */
export const TestDlpRequest = z.strictObject({
  text: z.string().max(DLP_TEST_TEXT_MAX),
  rule: z.strictObject({ name: DlpRuleName.default('test'), pattern: z.string().min(1).max(DLP_PATTERN_MAX_LENGTH), ignoreCase: z.boolean().default(false), action: DlpRuleSetting.default('redact') }).optional(),
  /** The preset to judge under; the workspace's own when left out is not read here, so the screen sends the one it shows. */
  preset: z.enum(['standard', 'strict-egress', 'air-gapped', 'customer-facing']).default('standard'),
});
export type TestDlpRequest = z.infer<typeof TestDlpRequest>;

export const TestDlpResponse = z.object({
  outcome: z.enum(['allow', 'redact', 'require_approval', 'block']),
  /** The text with each finding replaced by its marker; the original text when nothing was found or the call would be blocked. */
  text: z.string(),
  findings: z.array(z.object({ rule: z.string(), count: z.number().int().min(1) })),
});
export type TestDlpResponse = z.infer<typeof TestDlpResponse>;

// ---- per-team egress ------------------------------------------------------------------------------------------------------------------------------

/** Hosts one team may list, and the longest host name. */
export const TEAM_EGRESS_HOSTS_MAX = 200;
export const EGRESS_HOST_MAX_LENGTH = 253;

/**
 * A host as an admin types it, made into the form the list keeps: lower case, no scheme, port, path or trailing dot. Null when it is not a host name or a
 * numeric address (so `https://api.example.com/v1` is `api.example.com`, and `not a host` is refused).
 */
export function normalizeEgressHost(input: string): string | null {
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.replace(/[/?#].*$/, '');
  host = host.replace(/:\d{1,5}$/, '');
  host = host.replace(/\.$/, '');
  if (host === '' || host.length > EGRESS_HOST_MAX_LENGTH) return null;
  const labels = host.split('.');
  const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  return labels.every((l) => label.test(l)) ? host : null;
}

/**
 * Model providers' own domains. A team cannot allowlist them: a model call is judged by the workspace's model setup and its preset, so listing one here
 * would let a bot send text to a hosted model past the model guard. A host matches when it is one of these or a subdomain of one.
 */
export const LLM_PROVIDER_DOMAINS: readonly string[] = [
  'openai.com',
  'anthropic.com',
  'openrouter.ai',
  'mistral.ai',
  'cohere.com',
  'cohere.ai',
  'groq.com',
  'together.ai',
  'together.xyz',
  'deepseek.com',
  'x.ai',
  'perplexity.ai',
  'fireworks.ai',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'openai.azure.com',
  'huggingface.co',
  'replicate.com',
  'ai21.com',
  'bedrock-runtime.amazonaws.com',
  'cerebras.ai',
  'sambanova.ai',
  'moonshot.ai',
  'moonshot.cn',
  'minimax.io',
  'z.ai',
  'integrate.api.nvidia.com',
  'inference.ai.azure.com',
  'models.inference.ai.azure.com',
  'cognitiveservices.azure.com',
];

/** A cloud provider's per-region model host, which no suffix of a fixed name can describe (`bedrock-runtime.us-east-1.amazonaws.com`). */
const REGIONAL_PROVIDER_HOST = /^(bedrock|bedrock-runtime|bedrock-agent-runtime)(-fips)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** Whether `host` is a model provider's domain: one of the built-in names, one of `extra` (the hosts of the workspace's own model providers), or a subdomain of either. */
export function isProviderHost(host: string, extra: readonly string[] = []): boolean {
  const h = host.toLowerCase();
  if (REGIONAL_PROVIDER_HOST.test(h)) return true;
  return [...LLM_PROVIDER_DOMAINS, ...extra].some((d) => {
    const domain = d.toLowerCase();
    return h === domain || h.endsWith(`.${domain}`);
  });
}

/** A proxy a team's outgoing requests go through: http or https, no user name or password in the address, no path. */
export const EgressProxyUrl = z
  .string()
  .max(300)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '' && u.hostname !== '' && (u.pathname === '/' || u.pathname === '') && u.search === '' && u.hash === '';
    } catch {
      return false;
    }
  }, 'Use an http:// or https:// address with a host (and a port if needed), without a user name, password or path.');

export const TeamEgress = z.object({
  teamId: TeamId,
  teamName: z.string(),
  /** On: this team's bots may reach only the hosts below (and the workspace list), whatever the preset. Off: the list adds nothing the preset does not already decide. */
  enforce: z.boolean(),
  hosts: z.array(z.string()),
  proxyUrl: z.string().nullable(),
  /** Null until an admin saves the team's list once. */
  updatedAt: IsoDateTime.nullable(),
});
export type TeamEgress = z.infer<typeof TeamEgress>;

export const ListTeamEgressResponse = z.object({
  teams: z.array(TeamEgress),
  /** The workspace-wide list (set under Models > Guard), shown for context; it applies to every team under `strict-egress`. */
  workspaceHosts: z.array(z.string()),
  preset: z.string(),
  /** Model providers' domains that no team list may hold. */
  providerDomains: z.array(z.string()),
});
export type ListTeamEgressResponse = z.infer<typeof ListTeamEgressResponse>;

export const SetTeamEgressRequest = z.strictObject({
  enforce: z.boolean(),
  hosts: z.array(z.string().min(1).max(300)).max(TEAM_EGRESS_HOSTS_MAX),
  proxyUrl: EgressProxyUrl.nullable(),
});
export type SetTeamEgressRequest = z.infer<typeof SetTeamEgressRequest>;

export const SetTeamEgressResponse = z.object({ team: TeamEgress });
export type SetTeamEgressResponse = z.infer<typeof SetTeamEgressResponse>;

// ---- the change event ----------------------------------------------------------------------------------------------------------------------------

export const GuardrailsPolicyKind = z.enum(['dlp', 'egress']);
export type GuardrailsPolicyKind = z.infer<typeof GuardrailsPolicyKind>;
export const GuardrailsPolicyChange = z.enum(['detector', 'rule_added', 'rule_changed', 'rule_removed', 'team_list']);
export type GuardrailsPolicyChange = z.infer<typeof GuardrailsPolicyChange>;
