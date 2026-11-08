import type { PersonToolDef } from './person-kit.ts';

// Work package C (P16-05, decision D11): the person tool `calendar.find_free_time` ("when are Nadia and I both free?"). It resolves names to active people who share a team with
// the asker (the definer function `app.connections_resolve_people`), asks free/busy with the ASKER'S OWN grant, and answers free slots plus the names whose calendar is not shared.
// STUB: no tool is offered until C fills the list; `person-tools.ts` already spreads it into `PERSON_TOOL_DEFS`, so the manifest's capability list follows by itself.
export const FREE_TIME_TOOLS: PersonToolDef[] = [];
