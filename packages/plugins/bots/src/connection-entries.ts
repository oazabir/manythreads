import { nativeCoversTool } from '@manythreads/shared';

/**
 * The connections a definition asks for, in the shape the bots table keeps (`bots.connections`) and the connections plugin compiles into grants.
 * `needsApproval` of each entry is the tools of that entry which wait for a person: a name in `approvals.needsApproval` covers a tool when it is that tool or a
 * `namespace.*` wildcard over it, the same rule the rest of the definition uses (`nativeCoversTool`), so `needsApproval: [email.*]` covers `email.send`.
 */
export function connectionEntries(frontmatter: {
  capabilities?: { connections?: ReadonlyArray<{ name: string; tools: readonly string[] }> } | undefined;
  approvals?: { needsApproval?: readonly string[] | undefined } | undefined;
}): Array<{ connection: string; tools: string[]; needsApproval: string[] }> {
  const waits = frontmatter.approvals?.needsApproval ?? [];
  return (frontmatter.capabilities?.connections ?? []).map((c) => ({
    connection: c.name,
    tools: [...c.tools],
    needsApproval: c.tools.filter((t) => waits.some((w) => nativeCoversTool(w, t))),
  }));
}
