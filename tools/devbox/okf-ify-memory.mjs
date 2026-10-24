// okf-ify-memory.mjs — give the live demo's memory facts their OKF frontmatter.
//
// The demo was seeded before the OKF bundle existed, so its `memory/facts/*.md` and `memory/journal/*.md` files are plain Markdown
// with no frontmatter. A concept is a file that opens with a `---` frontmatter block and carries a `type`, so the platform's index
// (and the writer, which refuses a file that is not OKF) rightly leaves them out: the Memory screen shows nothing.
//
// This re-commits each of those files with the frontmatter a concept needs, keeping its body exactly as it was. The commit is a
// normal repo commit by the workspace admin, so the writer validates it, stamps it and the index fills from the commit event.
//
//   $env:DEMO_BASE='https://manythreads.kahf.to'
//   $env:DEMO_EMAIL='omar@kahf.example'; $env:DEMO_PASSWORD='...'
//   node tools/devbox/okf-ify-memory.mjs engineering customer-support marketing
const BASE = (process.env['DEMO_BASE'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const EMAIL = process.env['DEMO_EMAIL'] ?? '';
const PASSWORD = process.env['DEMO_PASSWORD'] ?? '';
if (!EMAIL || !PASSWORD) {
  console.error('DEMO_EMAIL and DEMO_PASSWORD must be set');
  process.exit(2);
}

let cookies = [];
let csrf = null;
const store = (res) => {
  for (const set of res.headers.getSetCookie()) {
    cookies.push(set.split(';')[0]);
    const m = /^(?:__Host-)?manythreads_csrf=([^;]+)/.exec(set);
    if (m) csrf = decodeURIComponent(m[1]);
  }
};
const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookies.length > 0 ? { cookie: cookies.join('; ') } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  store(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
};

const signin = await api('POST', '/api/auth/password/sign-in', { email: EMAIL, password: PASSWORD });
if (signin.status !== 200) {
  console.error(`signin failed: HTTP ${signin.status}`);
  process.exit(1);
}

/** The frontmatter a concept needs, with the title the body's first heading carries. */
const frontmatter = (type, title, description) =>
  ['---', `type: ${type}`, `title: ${JSON.stringify(title)}`, ...(description ? [`description: ${JSON.stringify(description)}`] : []), '---', ''].join('\n');

const isConcept = (text) => text.trimStart().startsWith('---');

/** Every markdown file under a folder, the tree walked folder by folder. */
const mdFiles = async (team, folder) => {
  const out = [];
  const tree = await api('GET', `/api/teams/${team}/repo/tree?path=${encodeURIComponent(folder)}`);
  for (const entry of tree.json?.entries ?? []) {
    if (entry.kind === 'dir') {
      out.push(...(await mdFiles(team, entry.path)));
      continue;
    }
    if (!entry.path?.endsWith('.md')) continue;
    out.push(entry.path);
  }
  return out;
};

for (const team of process.argv.slice(2)) {
  const changes = [];
  for (const path of await mdFiles(team, 'memory')) {
    if (path.endsWith('index.md') || path.endsWith('log.md')) continue;
    const blob = await api('GET', `/api/teams/${team}/repo/blob?path=${encodeURIComponent(path)}`);
    const text = blob.json?.content ?? '';
    if (typeof text !== 'string' || text === '' || isConcept(text)) continue;
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    const title = heading ?? path.split('/').pop()?.replace(/\.md$/, '') ?? path;
    const type = path.includes('/journal/') ? 'Journal' : 'Fact';
    const body = text.replace(/^#\s+.+$/m, '').replace(/^\n+/, '');
    changes.push({ op: 'put', path, content: frontmatter(type, title) + body });
  }
  if (changes.length === 0) {
    console.log(`${team}: nothing to convert`);
    continue;
  }
  const commit = await api('POST', `/api/teams/${team}/repo/commit`, {
    message: 'Give the memory concepts their OKF frontmatter',
    changes,
  });
  console.log(`${team}: ${changes.length} file(s) -> HTTP ${commit.status} ${JSON.stringify(commit.json)?.slice(0, 200)}`);
  for (const c of changes) console.log(`  ${c.path}`);
}
