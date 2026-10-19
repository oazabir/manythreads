// rebuild-concepts.mjs — fill the OKF bundle's frontmatter index on the live site.
//
// The index is normally kept in step by the commit event; a repository seeded without one (a demo environment) leaves it
// empty and the Memory screen blind. This asks the server to rebuild it, as the workspace admin.
//
//   $env:DEMO_BASE='https://manythreads.kahf.to'
//   $env:DEMO_EMAIL='omar@kahf.example'; $env:DEMO_PASSWORD='...'
//   node tools/devbox/rebuild-concepts.mjs engineering customer-support marketing
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
    const m = /^manythreads_csrf=([^;]*)/.exec(set);
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

const teams = process.argv.slice(2);
if (teams.length === 0) teams.push('engineering', 'customer-support', 'marketing');
for (const team of teams) {
  const r = await api('POST', `/api/teams/${team}/memory/concepts/rebuild`);
  console.log(`${team}: HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
  // the rebuild is queued and runs as the system: poll until the index carries the team's concepts
  for (let i = 0; i < 30; i++) {
    const list = await api('GET', `/api/teams/${team}/memory/concepts`);
    const n = Array.isArray(list.json?.items) ? list.json.items.length : -1;
    if (n > 0) {
      console.log(`  listed: ${n}`);
      break;
    }
    if (i === 29) console.log(`  listed: ${n} (still empty after 30 tries)`);
    await new Promise((r2) => setTimeout(r2, 2000));
  }
}
