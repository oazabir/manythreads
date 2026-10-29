import { LIMITS, compose, inline, link, linkWithHost, safeUrl } from './md.ts';
import { MARKS, markFromWord, type Mark } from './status.ts';
import { dig, isObj, str, type Adapted, type Obj } from './types.ts';

// Alert managers. Prometheus Alertmanager (`version`, `status`, `alerts[]`) and Sentry (an issue alert or an issue event) each have a fixed
// shape, so they are read here; any other tool sends the generic shape. Labels and annotations come from monitored systems, so they are escaped.

const severityMark = (sev: string | undefined): Mark => {
  const m = markFromWord(sev);
  return m === 'none' ? 'bad' : m;
};

export function isAlertmanager(o: Obj): boolean {
  return Array.isArray(o['alerts']) && ('receiver' in o || 'groupKey' in o || 'version' in o);
}

export function adaptAlertmanager(o: Obj): Adapted {
  const alerts = (o['alerts'] as unknown[]).filter(isObj);
  if (alerts.length === 0) return { kind: 'ignore', reason: 'The alert group has no alerts.' };
  const firing = alerts.filter((a) => str(a['status']) !== 'resolved');
  const resolved = alerts.length - firing.length;
  const overall = str(o['status']) === 'resolved' || firing.length === 0 ? 'resolved' : 'firing';
  const worst = firing.map((a) => severityMark(str(dig(a, 'labels', 'severity')))).includes('bad') ? 'bad' : firing.length > 0 ? 'warn' : 'good';
  const head = `${overall === 'resolved' ? MARKS.good : MARKS[worst]} **${overall === 'resolved' ? 'Resolved' : 'Firing'}**: ${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}${overall === 'firing' && resolved > 0 ? ` (${resolved} resolved)` : ''}`;
  const lines = alerts.slice(0, LIMITS.items).map((a) => {
    const labels = isObj(a['labels']) ? a['labels'] : {};
    const name = inline(labels['alertname'] ?? 'alert', 100);
    const sev = str(labels['severity']);
    const summary = inline(dig(a, 'annotations', 'summary') ?? dig(a, 'annotations', 'description') ?? dig(a, 'annotations', 'message') ?? '', 200);
    const where = ['instance', 'job', 'service', 'namespace', 'pod', 'cluster']
      .map((k) => (str(labels[k]) ? `${k} ${inline(labels[k], 60)}` : null))
      .filter((x) => x !== null)
      .slice(0, 3)
      .join(', ');
    const url = safeUrl(a['generatorURL']);
    const state = str(a['status']) === 'resolved' ? MARKS.good : MARKS[severityMark(sev)];
    return `- ${state} ${link(`**${name}**`, url)}${sev ? ` (${inline(sev, 20)})` : ''}${summary ? ` — ${summary}` : ''}${where ? ` · ${where}` : ''}`;
  });
  if (alerts.length > LIMITS.items) lines.push(`- … and ${alerts.length - LIMITS.items} more`);
  const ext = safeUrl(o['externalURL']);
  return { kind: 'post', text: compose([head, lines.join('\n'), ext ? linkWithHost('Open Alertmanager', ext) : null]) };
}

export function isSentry(o: Obj, headers: Readonly<Record<string, string | undefined>>): boolean {
  return headers['sentry-hook-resource'] !== undefined || (isObj(o['data']) && (isObj(dig(o, 'data', 'issue')) || isObj(dig(o, 'data', 'event')))) || ('project_name' in o && 'culprit' in o);
}

export function adaptSentry(o: Obj): Adapted {
  const issue = dig(o, 'data', 'issue');
  const event = dig(o, 'data', 'event');
  const legacy = 'project_name' in o;
  const issueObj = isObj(issue) ? issue : isObj(event) ? event : legacy ? o : null;
  if (issueObj === null) return { kind: 'ignore', reason: 'The Sentry payload has no issue or event to show.' };
  const title = inline(issueObj['title'] ?? issueObj['message'] ?? 'A Sentry event', LIMITS.title);
  const level = str(issueObj['level']);
  const mark = markFromWord(level);
  const url = safeUrl(issueObj['web_url'] ?? issueObj['permalink'] ?? issueObj['url'] ?? issueObj['issue_url']);
  const action = str(o['action']);
  const resolved = action === 'resolved';
  const project = inline(dig(issueObj, 'project', 'slug') ?? dig(issueObj, 'project', 'name') ?? issueObj['project_name'] ?? issueObj['project'] ?? '', 60);
  const head = `${resolved ? MARKS.good : MARKS[mark === 'none' ? 'bad' : mark]} **Sentry${project ? ` · ${project}` : ''}**${action ? `: issue ${inline(action, 30)}` : ''}`;
  const culprit = inline(issueObj['culprit'] ?? '', 150);
  return { kind: 'post', text: compose([head, link(`**${title}**`, url), culprit ? `in \`${culprit.replace(/[`\\]/g, '')}\`` : null, level ? `level ${inline(level, 20)}` : null]) };
}

