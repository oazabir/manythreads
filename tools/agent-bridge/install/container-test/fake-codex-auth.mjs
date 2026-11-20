// A made-up Codex sign-in file for the container test (P31-01): the shape of `auth.json` (a ChatGPT login, three tokens, the account in `tokens.account_id` and in the id token),
// with tokens that are not tokens. Nothing here reaches any service.
//   node fake-codex-auth.mjs <account> <refresh-tag> <last_refresh ISO time>
const [account = 'acct-1', refresh = 'rt-A', when = new Date().toISOString()] = process.argv.slice(2);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'none' })}.${b64({ exp: 4102444800, iat: Math.floor(Date.parse(when) / 1000), ...claims })}.c2lnbmF0dXJl`;
const doc = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: jwt({ email: 'bot@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'plus' } }),
    access_token: jwt({ tag: `access-${refresh}` }),
    refresh_token: refresh,
    account_id: account,
  },
  last_refresh: when,
};
process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
