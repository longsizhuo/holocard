/**
 * 端到端验证用 IH 账号登录（server/auth.ts）和卡片归属
 *
 * 自己起一个假的 IH（授权页直接放行、换码按协议校验 secret、一次性、PKCE），
 * 再用临时目录起一个服务端去连它，会真的分一张卡（半分钟到一分钟）。核对：
 *   - 登录：state cookie、换码、会话 cookie 的属性；state 对不上、码用第二次都登不进；next 只认本站路径
 *   - 归属：登录着做的卡不给口令、归到账号下；兄弟子域借会话传的图不归；认会话改东西只认本站页面发的
 *   - 认领：凭口令认领、认领后旧口令作废；口令不对、别人的卡不认
 *   - 别的账号动不了；退出后会话作废
 *   - 个人中心的 API key：要登录、只认本站页面发的、同时只有一个、别人吊销不了、吊销立即生效、
 *     额度按账号算（吊销了再申请不重新计数）
 *   - 假登录开关在正式地址下拒绝启动
 *
 * 用法（要 Node 22，node:sqlite）：/opt/holocard/node22/bin/node scripts/verify-auth.mjs
 * 先 pnpm build:server。模型目录默认 /srv/holocard-models，可用 HOLOCARD_MODEL_DIR 改
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'dist-server', 'holocard-server.mjs');
const IMAGE = readFileSync(join(ROOT, 'scripts', 'fixtures', 'og-test.jpg'));
const SECRET = randomBytes(24).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ---------- 假的 IH ----------
/** 授权页下一次放行谁 */
let ihUser = { sub: '101', username: 'alice', displayName: 'Alice', avatarUrl: 'https://avatars.example/a.png' };
const codes = new Map();
const ih = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://ih');
  if (req.method === 'GET' && url.pathname === '/sso/authorize') {
    const q = Object.fromEntries(url.searchParams);
    assert.equal(q.client_id, 'holocard');
    assert.equal(q.code_challenge_method, 'S256');
    assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    const code = b64url(randomBytes(32));
    codes.set(code, { user: ihUser, redirectUri: q.redirect_uri, challenge: q.code_challenge });
    res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}` }).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/internal/sso/token') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const reply = (status, data, message = 'ok') => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: status === 200, message, data }));
    };
    if (body.clientId !== 'holocard' || body.clientSecret !== SECRET) return reply(401, null, 'invalid_client');
    const grant = codes.get(body.code);
    codes.delete(body.code);
    const challenge = createHash('sha256').update(String(body.codeVerifier)).digest('base64url');
    if (!grant || grant.redirectUri !== body.redirectUri || grant.challenge !== challenge) {
      return reply(400, null, 'invalid_grant');
    }
    return reply(200, grant.user);
  }
  res.writeHead(404).end();
});
await new Promise((r) => ih.listen(0, '127.0.0.1', r));
const IH = `http://127.0.0.1:${ih.address().port}`;

// ---------- 服务端 ----------
const port = await new Promise((done) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});
const BASE = `http://127.0.0.1:${port}`;
const work = mkdtempSync(join(tmpdir(), 'holocard-auth-'));
const env = {
  ...process.env,
  HOLOCARD_PORT: String(port),
  HOLOCARD_PUBLIC_ORIGIN: BASE,
  HOLOCARD_OUT_DIR: join(work, 'layers'),
  HOLOCARD_DB: join(work, 'holocard.db'),
  HOLOCARD_MODEL_DIR: process.env.HOLOCARD_MODEL_DIR ?? '/srv/holocard-models',
  HOLOCARD_MIN_FREE_GB: '0',
  HOLOCARD_RATE_LIMIT: '1000',
  HOLOCARD_SELF_SERVE_DAILY_LIMIT: '2',
  HOLOCARD_SSO_SECRET: SECRET,
  HOLOCARD_SSO_AUTHORIZE_URL: `${IH}/sso/authorize`,
  HOLOCARD_SSO_TOKEN_URL: `${IH}/internal/sso/token`,
};
const server = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

function cleanup() {
  server.kill();
  ih.close();
  rmSync(work, { recursive: true, force: true });
}
process.on('exit', cleanup);

for (let i = 0; ; i++) {
  if (i > 60) throw new Error(`服务端没起来：\n${log}`);
  if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) break;
  await sleep(1000);
}

// ---------- 一个带 cookie 的「浏览器」 ----------
function browser() {
  const jar = new Map();
  const call = async (path, { method = 'GET', body, headers = {}, site = 'same-origin' } = {}) => {
    const res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
      method,
      body,
      redirect: 'manual',
      headers: {
        ...headers,
        ...(site ? { 'sec-fetch-site': site } : {}),
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (/Max-Age=0/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
  return { jar, call };
}

/** 走一遍登录：/auth/login → 假 IH → /auth/callback。返回最后那个响应 */
async function login(b, next = '/') {
  const start = await b.call(`/auth/login?next=${encodeURIComponent(next)}`, { site: 'none' });
  assert.equal(start.status, 302, '登录入口应当 302 到 IH');
  const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith('__Host-hc_state='));
  assert.ok(stateCookie, '应当种 state cookie');
  assert.match(stateCookie, /HttpOnly/);
  assert.match(stateCookie, /Secure/);
  assert.match(stateCookie, /SameSite=Lax/);
  assert.match(stateCookie, /Path=\//);
  assert.doesNotMatch(stateCookie, /Domain=/i, '__Host- cookie 不能带 Domain');
  const authorize = await fetch(start.headers.get('location'), { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  return b.call(authorize.headers.get('location'), { site: 'cross-site' });
}

const upload = (b, site = 'same-origin') =>
  b.call('/api/jobs', { method: 'POST', body: IMAGE, headers: { 'content-type': 'image/jpeg' }, site });
const me = async (b) => (await b.call('/api/me')).json();

// ---------- 没登录 ----------
const alice = browser();
assert.deepEqual(await me(alice), { login: true, user: null, cards: [] });
const anon = await upload(alice);
assert.equal(anon.status, 202);
const cardA = await anon.json();
assert.match(cardA.deleteToken, /^[0-9a-f-]{36}$/, '没登录时照常给口令');

// ---------- 登录 ----------
const done = await login(alice, '/c/abc?x=1#albums');
assert.equal(done.status, 302, `回调应当 302，实际 ${done.status}`);
assert.equal(done.headers.get('location'), '/c/abc?x=1#albums', '回到登录前的地方');
assert.equal(done.headers.get('referrer-policy'), 'no-referrer');
const sessionCookie = done.headers.getSetCookie().find((c) => c.startsWith('__Host-hc_session='));
assert.ok(sessionCookie, '应当发会话 cookie');
assert.match(sessionCookie, /HttpOnly/);
assert.match(sessionCookie, /Secure/);
assert.ok(!alice.jar.has('__Host-hc_state'), '登录完 state cookie 应当清掉');
const aliceMe = await me(alice);
assert.deepEqual(aliceMe.user, { id: '101', name: 'Alice', avatar: 'https://avatars.example/a.png' });

// 登录 CSRF：state 对不上
const mallory = browser();
const start = await mallory.call('/auth/login', { site: 'none' });
const authorize = await fetch(start.headers.get('location'), { redirect: 'manual' });
const forged = new URL(authorize.headers.get('location'));
forged.searchParams.set('state', 'not-the-state');
assert.equal((await mallory.call(forged.toString())).status, 400, 'state 对不上应当登不进');
assert.ok(!mallory.jar.has('__Host-hc_session'));
// 同一个码用第二次（真 IH 那边是一次性的，这里假 IH 也是）：连 state cookie 一起重放也登不进
const replay = browser();
const s2 = await replay.call('/auth/login', { site: 'none' });
const savedState = replay.jar.get('__Host-hc_state');
const a2 = await fetch(s2.headers.get('location'), { redirect: 'manual' });
const callback = a2.headers.get('location');
assert.equal((await replay.call(callback)).status, 302);
const replay2 = browser();
replay2.jar.set('__Host-hc_state', savedState);
assert.equal((await replay2.call(callback)).status, 400, '码用第二次应当登不进');
assert.ok(!replay2.jar.has('__Host-hc_session'));
// next 只认本站路径
for (const next of ['//evil.example/x', '/\\evil.example', 'https://evil.example/']) {
  const b = browser();
  assert.equal((await login(b, next)).headers.get('location'), '/', `next=${next} 应当回首页`);
}

// ---------- 登录着做卡 ----------
const sibling = await upload(alice, 'same-site');
assert.equal(sibling.status, 202);
const cardB = await sibling.json();
assert.match(cardB.deleteToken, /^[0-9a-f-]{36}$/, '兄弟子域借会话传的图不归到账号下');
// 删掉，别让它占着队列（下面要等一张卡真做完）
assert.equal(
  (await browser().call(`/api/cards/${cardB.id}`, { method: 'DELETE', headers: { 'x-holocard-token': cardB.deleteToken } })).status,
  200,
);
const mine = await upload(alice);
assert.equal(mine.status, 202);
const cardC = await mine.json();
assert.equal(cardC.deleteToken, null, '登录着做的卡不给口令');
assert.deepEqual((await me(alice)).cards, [cardC.id]);

// ---------- 认领 ----------
const claimBody = JSON.stringify({ cards: [{ id: cardA.id, token: cardA.deleteToken }] });
const claimHeaders = { 'content-type': 'application/json' };
assert.equal(
  (await alice.call('/api/me/claim', { method: 'POST', body: claimBody, headers: claimHeaders, site: 'same-site' })).status,
  401,
  '认领只认本站页面发的',
);
const wrong = JSON.stringify({ cards: [{ id: cardA.id, token: '00000000-0000-0000-0000-000000000000' }] });
assert.deepEqual(
  await (await alice.call('/api/me/claim', { method: 'POST', body: wrong, headers: claimHeaders })).json(),
  { claimed: [] },
  '口令不对不认',
);
assert.deepEqual(
  await (await alice.call('/api/me/claim', { method: 'POST', body: claimBody, headers: claimHeaders })).json(),
  { claimed: [cardA.id] },
);
assert.deepEqual(new Set((await me(alice)).cards), new Set([cardA.id, cardC.id]));
const stranger = browser();
assert.equal(
  (await stranger.call(`/api/cards/${cardA.id}`, { method: 'DELETE', headers: { 'x-holocard-token': cardA.deleteToken } })).status,
  403,
  '认领后旧口令作废',
);

// ---------- 别的账号 ----------
const bob = browser();
ihUser = { sub: '202', username: 'bob', displayName: '', avatarUrl: 'http://insecure.example/b.png' };
await login(bob);
const bobMe = await me(bob);
assert.deepEqual(bobMe.user, { id: '202', name: 'bob', avatar: null }, '没有展示名用用户名；非 https 头像不要');
assert.deepEqual(bobMe.cards, []);
assert.deepEqual(
  await (await bob.call('/api/me/claim', { method: 'POST', body: claimBody, headers: claimHeaders })).json(),
  { claimed: [] },
  '别人认领过的卡不能再认领',
);
assert.equal((await bob.call(`/api/cards/${cardA.id}`, { method: 'DELETE' })).status, 403, '别的账号删不了');
assert.equal((await alice.call(`/api/cards/${cardA.id}`, { method: 'DELETE', site: 'same-site' })).status, 403, '兄弟子域借会话删不了');
assert.equal((await alice.call(`/api/cards/${cardA.id}`, { method: 'DELETE' })).status, 200, '认领来的卡主人登录着能删');
assert.deepEqual((await me(alice)).cards, [cardC.id]);

// ---------- 认会话改东西：分享、改配置、删卡 ----------
const status = async (id) => (await (await fetch(`${BASE}/api/jobs/${id}`)).json()).state;
for (let i = 0; ; i++) {
  const state = await status(cardC.id);
  if (state === 'done') break;
  if (state === 'error' || i > 300) throw new Error(`卡没做出来：${state}\n${log.slice(-2000)}`);
  await sleep(1000);
}
const share = (b, site) => b.call(`/api/cards/${cardC.id}/share`, { method: 'POST', site });
assert.equal((await share(bob)).status, 403, '别的账号不能分享');
assert.equal((await share(alice, 'same-site')).status, 403, '兄弟子域借会话不能分享');
assert.equal((await share(alice, null)).status, 403, '没有 Sec-Fetch-Site 的不认会话');
assert.equal((await share(alice)).status, 200, '主人登录着能分享');
const manifest = await (await fetch(`${BASE}/api/layers/${cardC.id}/manifest.json`)).json();
const valid = JSON.stringify({
  foils: manifest.layers.map(() => ({ type: 'holo', intensity: 0.5 })),
  halo: { intensity: 1, sharpness: 400 },
  parallax: { enabled: false, amplitude: 0.1 },
});
const config = (b, site) =>
  b.call(`/api/cards/${cardC.id}/config`, { method: 'PUT', body: valid, headers: { 'content-type': 'application/json' }, site });
assert.equal((await config(bob)).status, 403);
assert.equal((await config(alice, 'same-site')).status, 403);
assert.equal((await config(alice)).status, 200, '主人登录着能改配置');

// ---------- 个人中心的 API key ----------
const keys = (b, method = 'GET', site = 'same-origin', path = '/api/me/keys') => b.call(path, { method, site });
assert.equal((await keys(browser())).status, 401, '没登录看不到');
assert.deepEqual(await (await keys(alice)).json(), { keys: [], used: 0, dailyLimit: 2 });
assert.equal((await keys(alice, 'POST', 'same-site')).status, 401, '申请只认本站页面发的');
const granted = await keys(alice, 'POST');
assert.equal(granted.status, 201);
const first = await granted.json();
assert.match(first.key, /^hc_[A-Za-z0-9_-]{32}$/);
assert.equal((await keys(alice, 'POST')).status, 409, '同时只能有一个能用的 key');
const listed = await (await keys(alice)).json();
assert.equal(listed.keys.length, 1);
assert.equal(listed.keys[0].id, first.id);
assert.equal(listed.keys[0].revokedAt, null);
assert.ok(!JSON.stringify(listed).includes(first.key), '列表里不该有 key 本身');
const v1 = (key, path = '/v1/cards', init = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
assert.equal((await v1(first.key, `/v1/cards/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`)).status, 404, 'key 能用');
assert.equal((await bob.call(`/api/me/keys/${first.id}`, { method: 'DELETE' })).status, 404, '别人吊销不了');
// 额度按账号算：上限 2，交两张（交完就删，删掉的也算），第三张 429；吊销了再申请，还是 429
const submitV1 = (key) => v1(key, '/v1/cards', { method: 'POST', body: IMAGE, headers: { 'content-type': 'image/jpeg' } });
for (let i = 0; i < 2; i++) {
  const r = await submitV1(first.key);
  assert.equal(r.status, 202, `第 ${i + 1} 张应当 202，实际 ${r.status}`);
  assert.equal((await v1(first.key, `/v1/cards/${(await r.json()).id}`, { method: 'DELETE' })).status, 200);
}
assert.equal((await submitV1(first.key)).status, 429, '到额度了');
assert.equal((await alice.call(`/api/me/keys/${first.id}`, { method: 'DELETE' })).status, 200);
assert.equal((await v1(first.key, `/v1/cards/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`)).status, 401, '吊销立即生效');
const second = await (await keys(alice, 'POST')).json();
assert.ok(second.key && second.key !== first.key);
const again = await submitV1(second.key);
assert.equal(again.status, 429, '吊销了再申请，额度不重新计数');
assert.equal((await again.json()).code, 'quota_exceeded');
assert.equal((await keys(alice)).status, 200);
assert.equal((await (await keys(alice)).json()).used, 2);

// ---------- 退出 ----------
assert.equal((await alice.call('/auth/logout', { method: 'POST', site: 'same-site' })).status, 403);
const oldSession = alice.jar.get('__Host-hc_session');
assert.equal((await alice.call('/auth/logout', { method: 'POST' })).status, 204);
assert.equal((await me(alice)).user, null);
const replayed = browser();
replayed.jar.set('__Host-hc_session', oldSession);
assert.equal((await me(replayed)).user, null, '退出后旧会话作废');
assert.equal((await replayed.call(`/api/cards/${cardC.id}`, { method: 'DELETE' })).status, 403);

// 再登录回来删掉
ihUser = { sub: '101', username: 'alice', displayName: 'Alice', avatarUrl: null };
await login(alice);
assert.equal((await alice.call(`/api/cards/${cardC.id}`, { method: 'DELETE' })).status, 200, '主人登录着能删');
assert.deepEqual((await me(alice)).cards, []);

// ---------- 假登录不能在正式地址开 ----------
const fake = spawn(process.execPath, [SERVER], {
  env: { ...env, HOLOCARD_PORT: '0', HOLOCARD_PUBLIC_ORIGIN: 'https://holocard.longsizhuo.com', HOLOCARD_AUTH_FAKE: '1' },
  stdio: 'ignore',
});
const code = await Promise.race([new Promise((r) => fake.on('exit', r)), sleep(20000).then(() => 'still running')]);
fake.kill();
assert.notEqual(code, 'still running', '正式地址开假登录应当拒绝启动');
assert.notEqual(code, 0);

console.log('auth ok');
process.exit(0);
