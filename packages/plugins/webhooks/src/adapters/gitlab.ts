import { LIMITS, clip, compose, inline, link, plural, quote, safeUrl } from './md.ts';
import { dig, isObj, num, str, type Adapted, type Obj } from './types.ts';

// GitLab's webhook events, a small useful set: pushes, merge requests, pipelines, issues. The same rules as the GitHub adapter: outside text is
// escaped and cut, addresses must be http(s), anything else is left out with a note.

const project = (p: Obj): string => inline(dig(p, 'project', 'path_with_namespace') ?? dig(p, 'project', 'name') ?? 'a project', 100);
const projectLink = (p: Obj): string => link(`**${project(p)}**`, safeUrl(dig(p, 'project', 'web_url')));
const user = (p: Obj): string => {
  const n = inline(p['user_name'] ?? dig(p, 'user', 'name') ?? dig(p, 'user', 'username') ?? '', 60);
  return n === '' ? 'someone' : `**${n}**`;
};
const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;
const ignore = (reason: string): Adapted => ({ kind: 'ignore', reason });

export function adaptGitlab(event: string, p: unknown): Adapted {
  if (!isObj(p)) return { kind: 'reject', reason: 'The GitLab payload is not a JSON object.' };
  const kind = str(p['object_kind']) ?? event.toLowerCase().replace(/ hook$/, '').replace(/ /g, '_');
  const attrs = isObj(p['object_attributes']) ? p['object_attributes'] : {};
  switch (kind) {
    case 'push': {
      const ref = str(p['ref']);
      if (!ref?.startsWith('refs/heads/')) return ignore('A push to a ref that is not a branch is not shown.');
      const commits = Array.isArray(p['commits']) ? (p['commits'] as unknown[]) : [];
      if (commits.length === 0) return ignore('A push with no new commits is not shown.');
      const total = num(p['total_commits_count']) ?? commits.length;
      const lines = commits.slice(0, 5).map((c) => {
        const sha = String(dig(c, 'id') ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 7);
        const first = inline(String(dig(c, 'message') ?? '').split('\n')[0] ?? '', 120);
        const author = inline(dig(c, 'author', 'name') ?? '', 40);
        return `- ${sha ? `${link(code(sha), safeUrl(dig(c, 'url')))} ` : ''}${first}${author ? ` — ${author}` : ''}`;
      });
      if (commits.length > 5) lines.push(`- … and ${commits.length - 5} more`);
      return { kind: 'post', text: compose([`${projectLink(p)}: ${user(p)} pushed ${plural(Math.max(total, commits.length), 'commit')} to branch ${code(clip(ref.slice(11), 100))}`, lines.join('\n')]) };
    }
    case 'merge_request': {
      const action = str(attrs['action']);
      const verbs: Record<string, [string, string]> = { open: ['opened a merge request', '🔀'], reopen: ['reopened a merge request', '🔀'], merge: ['merged a merge request', '🟣'], close: ['closed a merge request without merging', '⚪'] };
      const found = action === undefined ? undefined : verbs[action];
      if (!found) return ignore(`Merge request action "${inline(action ?? '', 40)}" is not shown.`);
      const head = `${found[1]} ${projectLink(p)}: ${user(p)} ${found[0]}`;
      const title = link(`!${num(attrs['iid']) ?? '?'} ${inline(attrs['title'], LIMITS.title)}`, safeUrl(attrs['url']));
      const branches = `${code(clip(String(attrs['source_branch'] ?? '?'), 60))} → ${code(clip(String(attrs['target_branch'] ?? '?'), 60))}`;
      return { kind: 'post', text: compose([head, `${title}\n${branches}`, action === 'open' ? quote(attrs['description'], 400, 6) : null]) };
    }
    case 'pipeline': {
      const status = str(attrs['status']);
      const out = status === 'success' ? ['✅', 'succeeded'] : status === 'failed' ? ['❌', 'failed'] : status === 'canceled' ? ['⚪', 'was cancelled'] : null;
      if (out === null) return ignore('Only finished pipelines are shown.');
      const id = num(attrs['id']);
      const web = safeUrl(dig(p, 'project', 'web_url'));
      const url = web && id ? safeUrl(`${web}/-/pipelines/${id}`) : null;
      return { kind: 'post', text: compose([`${out[0]} ${projectLink(p)}: ${link(`pipeline #${id ?? '?'}`, url)} ${out[1]}`, `branch ${code(clip(String(attrs['ref'] ?? '?'), 60))}`]) };
    }
    case 'issue': {
      const action = str(attrs['action']);
      const verbs: Record<string, [string, string]> = { open: ['opened an issue', '🐛'], reopen: ['reopened an issue', '🐛'], close: ['closed an issue', '✅'] };
      const found = action === undefined ? undefined : verbs[action];
      if (!found) return ignore(`Issue action "${inline(action ?? '', 40)}" is not shown.`);
      return { kind: 'post', text: compose([`${found[1]} ${projectLink(p)}: ${user(p)} ${found[0]}`, link(`#${num(attrs['iid']) ?? '?'} ${inline(attrs['title'], LIMITS.title)}`, safeUrl(attrs['url'])), action === 'open' ? quote(attrs['description'], 400, 6) : null]) };
    }
    default:
      return ignore(`GitLab event "${inline(kind, 40)}" is not shown by this webhook.`);
  }
}
