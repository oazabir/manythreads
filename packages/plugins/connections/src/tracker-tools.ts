import { ASANA_TOOLS } from './asana-tools.ts';
import { GITHUB_ISSUES_TOOLS } from './github-issues-tools.ts';
import { JIRA_TOOLS } from './jira-tools.ts';
import { LINEAR_TOOLS } from './linear-tools.ts';
import type { PersonToolDef } from './person-kit.ts';

// The tools of a person's work-tracker connections (PLAN P16-06): Jira, Linear, GitHub Issues and Asana. Each tracker has its own file; this is the list, joined to the
// other person tools in person-tools.ts. Every one that writes (create, comment, change status) waits for a person's approval, with a card that names the tracker, the
// target and the act first (tracker-kit.ts). None deletes: the catalog lists `jira.delete_issue` as left out.
export const TRACKER_TOOLS: PersonToolDef[] = [...JIRA_TOOLS, ...LINEAR_TOOLS, ...GITHUB_ISSUES_TOOLS, ...ASANA_TOOLS];
