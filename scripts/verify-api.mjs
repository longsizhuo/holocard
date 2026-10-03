/**
 * 端到端验证对外接口（/v1）和它带来的访问控制
 *
 * 要一个跑着的服务端（会真的分层，每张半分钟到一分钟），以及它用的数据库和产物目录。
 * 别对线上跑：会往库里插测试 key 和测试卡。核对：
 *   - 鉴权：没有 key、key 格式不对、吊销了 → 401 带 WWW-Authenticate；别的 key 的卡 → 404；Bearer 不分大小写
 *   - 私有：接口的卡在 /api/jobs、/api/layers、分享、导出、改配置、删卡上都当作不存在，/c 和不存在的 id 一样
 *   - 交付：做完能拿到 manifest 和每个文件（HEAD 也行），文件不让 CDN 缓存
 *   - 额度：一个 key 24 小时的上限，到了 429；删掉的照样算
 *   - 吊销：立即生效，排队中的卡不再处理、文件清掉
 *   - 处理途中删卡：状态保持 deleted、产物不留
 *   - 排队：网页任务插到接口任务前面
 *   - 分享：只有拿着删除口令的人能分享
 *   - 健壮：畸形请求行回 400 而不是把进程打崩；超过 16MB 回 413；路径和方法不对回 404 / 405
 *
 * 用法：
 *   HOLOCARD_DB=<服务端的库> HOLOCARD_OUT_DIR=<服务端的产物目录> node scripts/verify-api.mjs http://127.0.0.1:<端口>
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] ?? '').replace(/\/+$/, '');
const { HOLOCARD_DB: DB_PATH, HOLOCARD_OUT_DIR: OUT_DIR } = process.env;
if (!BASE || !DB_PATH || !OUT_DIR) {
  console.error('用法：HOLOCARD_DB=<库> HOLOCARD_OUT_DIR=<产物目录> node scripts/verify-api.mjs http://127.0.0.1:<端口>');
  process.exit(1);
}
const IMAGE = readFileSync(join(ROOT, 'scripts', 'fixtures', 'og-test.jpg'));
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const row = (id) => db.prepare('SELECT status, error FROM cards WHERE id = ?').get(id);

const apikey = (...args) =>
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'apikey.mjs'), ...args], { encoding: 'utf8', env: process.env });
function mint(name, limit) {
  const out = apikey('create', name, String(limit));
  const key = /hc_[A-Za-z0-9_-]{32}/.exec(out)?.[0];
  const id = /id (\w{8})/.exec(out)?.[1];
  assert.ok(key && id, `发 key 的输出不对：${out}`);
  return { key, id };
}

const call = (path, { key, method = 'GET', body, headers = {}, scheme = 'Bearer' } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    body,
    headers: { ...headers, ...(key ? { authorization: `${scheme} ${key}` } : {}) },
  });
const submit = (key) => call('/v1/cards', { key, method: 'POST', body: IMAGE, headers: { 'content-type': 'image/jpeg' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, check, seconds = 300) {
  for (let i = 0; i < seconds; i++) {
    const value = await check();
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`等了 ${seconds} 秒：${what}`);
}

/** 原样发一行请求，拿回状态行。fetch 会把畸形的地址先规范化，测不到 */
const rawStatus = (line) =>
  new Promise((done, fail) => {
    const { hostname, port } = new URL(BASE);
    const socket = connect(Number(port), hostname, () => socket.write(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let text = '';
    socket.on('data', (chunk) => (text += chunk));
    socket.on('end', () => done(text.split('\r\n')[0]));
    socket.on('error', fail);
  });

const a = mint('verify-a', 3);
const b = mint('verify-b', 5);

// ---------- 健壮 ----------
assert.match(await rawStatus('GET //[ HTTP/1.1'), / 400 /, '畸形请求行应当回 400');
assert.equal((await call('/api/health')).status, 200, '畸形请求之后服务应当还活着');
assert.equal((await call('/v1/cards', { key: a.key })).status, 405, 'GET /v1/cards 应当 405');
assert.equal((await call('/v1/cards', { key: a.key })).headers.get('allow'), 'POST');
assert.equal((await (await call('/v1/nope', { key: a.key })).json()).code, 'not_found');
const huge = await call('/v1/cards', { key: a.key, method: 'POST', body: Buffer.alloc(17 * 1024 * 1024), headers: { 'content-type': 'image/jpeg' } });
assert.equal(huge.status, 413, `超过 16MB 应当 413，实际 ${huge.status}`);

// ---------- 鉴权 ----------
const anonymous = await submit(undefined);
assert.equal(anonymous.status, 401, '没带 key 应当 401');
assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer');
assert.equal((await submit('hc_short')).status, 401, 'key 格式不对应当 401');
assert.equal((await submit(`hc_${'x'.repeat(32)}`)).status, 401, '不存在的 key 应当 401');
assert.equal((await call(`/v1/cards/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, { key: a.key, scheme: 'bearer' })).status, 404, '小写 bearer 也认');

// ---------- 提交，公开路由上看不到 ----------
const first = await submit(a.key);
assert.equal(first.status, 202, `提交应当 202，实际 ${first.status} ${await first.clone().text()}`);
const { id } = await first.json();

const missing = `${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}`;
const cardPage = await (await call(`/c/${id}`)).text();
assert.equal((await call(`/c/${id}`)).status, (await call(`/c/${missing}`)).status, '/c 上接口卡和不存在的 id 应当一样');
assert.ok(!cardPage.includes(`/api/layers/${id}`), '/c 不该给接口卡注入分享标签');
assert.equal((await call(`/v1/cards/${id}`, { key: b.key })).status, 404, '别的 key 应当 404');
assert.equal((await call(`/api/jobs/${id}`)).status, 404, '/api/jobs 上应当看不到');
assert.equal((await call(`/api/layers/${id}/original.jpg`)).status, 404, '/api/layers 上应当看不到');
assert.equal((await call(`/api/cards/${id}/share`, { method: 'POST' })).status, 404, '不能分享');
assert.equal((await call(`/api/cards/${id}/export/gif`, { method: 'POST' })).status, 404, '不能导出');
assert.equal((await call(`/api/cards/${id}`, { method: 'DELETE', headers: { 'x-holocard-token': 'x' } })).status, 404, '网页删卡接口上应当看不到');
assert.equal(
  (await call(`/api/cards/${id}/config`, { method: 'PUT', body: '{}', headers: { 'x-holocard-token': 'x' } })).status,
  404,
  '改配置接口上应当看不到',
);

// ---------- 做完，取文件 ----------
const done = await until('第一张做完', async () => {
  const body = await (await call(`/v1/cards/${id}`, { key: a.key })).json();
  return body.status === 'done' || body.status === 'failed' ? body : null;
});
assert.equal(done.status, 'done', `应当做完，实际 ${JSON.stringify(done)}`);
assert.ok(done.manifest?.layers?.length >= 1, 'manifest 应当有层');
assert.ok(Date.parse(done.expiresAt) - Date.now() < 24.1 * 3600 * 1000, '应当 24 小时内过期');
const head = await call(`/v1/cards/${id}`, { key: a.key, method: 'HEAD' });
assert.equal(head.status, 200, 'HEAD 应当能用');
assert.equal((await head.text()).length, 0, 'HEAD 不带响应体');
for (const [name, url] of Object.entries(done.files)) {
  const path = new URL(url).pathname;
  const res = await call(path, { key: a.key });
  assert.equal(res.status, 200, `${name} 应当能下载`);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/, `${name} 不该被缓存`);
  assert.ok((await res.arrayBuffer()).byteLength > 0, `${name} 不该是空的`);
  assert.equal((await call(path, { key: b.key })).status, 404, `别的 key 不该能下 ${name}`);
}
assert.equal((await call(`/v1/cards/${id}/files/preview.jpg`, { key: a.key })).status, 404, '只给清单、层图、原图');
const postFile = await call(`/v1/cards/${id}/files/manifest.json`, { key: a.key, method: 'POST' });
assert.equal(postFile.status, 405);
assert.equal(postFile.headers.get('allow'), 'GET, HEAD');

// ---------- 处理途中删卡 ----------
const second = await submit(a.key);
assert.equal(second.status, 202);
const secondId = (await second.json()).id;
await until('第二张开始处理', () => row(secondId)?.status === 'running');
assert.equal((await call(`/v1/cards/${secondId}`, { key: a.key, method: 'DELETE' })).status, 200);
assert.equal((await call(`/v1/cards/${secondId}`, { key: a.key })).status, 404, '删掉的应当 404');

// ---------- 额度：上限 3，交了 2 张（删掉的也算），第 3 张能交，第 4 张 429 ----------
const third = await submit(a.key);
assert.equal(third.status, 202, `第 3 张应当 202，实际 ${third.status}`);
const thirdId = (await third.json()).id;
const fourth = await submit(a.key);
assert.equal(fourth.status, 429, `第 4 张应当 429，实际 ${fourth.status}`);
assert.equal((await fourth.json()).code, 'quota_exceeded');

// ---------- 吊销立即生效：排着队的第 3 张不再处理 ----------
apikey('revoke', a.id);
assert.equal((await call(`/v1/cards/${id}`, { key: a.key })).status, 401, '吊销后应当 401');

// ---------- 排队：网页任务插到接口任务前面 ----------
assert.equal((await submit(b.key)).status, 202);
const web = await call('/api/jobs', { method: 'POST', body: IMAGE, headers: { 'content-type': 'image/jpeg' } });
assert.equal(web.status, 202);
const webJob = await web.json();
const apiAhead = db.prepare("SELECT COUNT(*) AS n FROM cards WHERE source = 'api' AND status = 'queued'").get().n;
assert.ok(apiAhead >= 1, '这时应当有接口任务在排队');
assert.equal(webJob.position, 1, `网页任务应当插到接口任务前面，实际排第 ${webJob.position}`);

// ---------- 分享只认删除口令 ----------
await until('网页任务做完', async () => {
  const body = await (await call(`/api/jobs/${webJob.id}`)).json();
  return body.state === 'done' || body.state === 'error';
});
const noToken = await call(`/api/cards/${webJob.id}/share`, { method: 'POST' });
assert.equal(noToken.status, 403, '没有口令不能分享');
assert.equal((await noToken.json()).code, 'share_forbidden');
const shared = await call(`/api/cards/${webJob.id}/share`, { method: 'POST', headers: { 'x-holocard-token': webJob.deleteToken } });
assert.equal(shared.status, 200, '拿着口令能分享');

// ---------- 收尾：删掉的、吊销的都没留下东西 ----------
await until('吊销 key 的那张被拒', () => row(thirdId)?.status === 'error');
assert.equal(row(thirdId).error, 'key_revoked');
assert.ok(!existsSync(join(OUT_DIR, thirdId)), '吊销 key 的卡不该留文件');
assert.equal(row(secondId).status, 'deleted', '处理途中删掉的卡应当保持 deleted');
assert.ok(!existsSync(join(OUT_DIR, secondId)), '处理途中删掉的卡不该留产物');

console.log('api ok');
