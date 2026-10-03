/**
 * 端到端验证对外接口（/v1）和它带来的访问控制
 *
 * 要一个跑着的服务端（会真的分层，每张半分钟到一分钟），以及它用的那个数据库（用 apikey.mjs 发测试 key）。
 * 别对线上跑：会往线上库里插测试 key 和测试卡。核对：
 *   - 鉴权：没有 key、key 格式不对、吊销了的 key → 401；别的 key 的卡 → 404
 *   - 私有：接口的卡在 /api/jobs、/api/layers、/c、分享、导出上都当作不存在
 *   - 交付：做完能拿到 manifest 和每个文件，文件不让 CDN 缓存
 *   - 额度：一个 key 24 小时的上限，到了 429；删掉的照样算
 *   - 排队：网页任务插到接口任务前面
 *   - 分享：只有拿着删除口令的人能分享
 *
 * 用法：
 *   HOLOCARD_DB=<服务端的库> node scripts/verify-api.mjs http://127.0.0.1:<端口>
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!BASE || !process.env.HOLOCARD_DB) {
  console.error('用法：HOLOCARD_DB=<服务端的库> node scripts/verify-api.mjs http://127.0.0.1:<端口>');
  process.exit(1);
}
const IMAGE = readFileSync(join(ROOT, 'scripts', 'fixtures', 'og-test.jpg'));

const apikey = (...args) =>
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'apikey.mjs'), ...args], { encoding: 'utf8' });
function mint(name, limit) {
  const out = apikey('create', name, String(limit));
  const key = /hc_[A-Za-z0-9_-]{32}/.exec(out)?.[0];
  const id = /id (\w{8})/.exec(out)?.[1];
  assert.ok(key && id, `发 key 的输出不对：${out}`);
  return { key, id };
}

const call = (path, { key, method = 'GET', body, headers = {} } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    body,
    headers: { ...headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
  });
const submit = (key) => call('/v1/cards', { key, method: 'POST', body: IMAGE, headers: { 'content-type': 'image/jpeg' } });

async function waitDone(path, opts, isDone) {
  for (let i = 0; i < 240; i++) {
    const body = await (await call(path, opts)).json();
    if (isDone(body)) return body;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`等了 4 分钟还没做完：${path}`);
}

const a = mint('verify-a', 2);
const b = mint('verify-b', 5);

// 鉴权
assert.equal((await submit(undefined)).status, 401, '没带 key 应当 401');
assert.equal((await submit('hc_short')).status, 401, 'key 格式不对应当 401');
assert.equal((await submit(`hc_${'x'.repeat(32)}`)).status, 401, '不存在的 key 应当 401');

// 提交
const first = await submit(a.key);
assert.equal(first.status, 202, `提交应当 202，实际 ${first.status} ${await first.clone().text()}`);
const { id } = await first.json();

// 别的 key、公开路由都看不到
assert.equal((await call(`/v1/cards/${id}`, { key: b.key })).status, 404, '别的 key 应当 404');
assert.equal((await call(`/api/jobs/${id}`)).status, 404, '/api/jobs 上应当看不到接口的卡');
assert.equal((await call(`/api/layers/${id}/original.jpg`)).status, 404, '/api/layers 上应当看不到接口的卡');
assert.equal((await call(`/c/${id}`)).status, 404, '卡片页应当 404');
assert.equal((await call(`/api/cards/${id}/share`, { method: 'POST' })).status, 404, '接口的卡不能分享');
assert.equal((await call(`/api/cards/${id}/export/gif`, { method: 'POST' })).status, 404, '接口的卡不能导出');

// 做完，取文件
const done = await waitDone(`/v1/cards/${id}`, { key: a.key }, (body) => body.status === 'done' || body.status === 'failed');
assert.equal(done.status, 'done', `应当做完，实际 ${JSON.stringify(done)}`);
assert.ok(done.manifest?.layers?.length >= 1, 'manifest 应当有层');
assert.ok(Date.parse(done.expiresAt) - Date.now() < 24.1 * 3600 * 1000, '应当 24 小时内过期');
for (const [name, url] of Object.entries(done.files)) {
  const path = new URL(url).pathname;
  const res = await call(path, { key: a.key });
  assert.equal(res.status, 200, `${name} 应当能下载`);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/, `${name} 不该被缓存`);
  assert.ok((await res.arrayBuffer()).byteLength > 0, `${name} 不该是空的`);
  assert.equal((await call(path, { key: b.key })).status, 404, `别的 key 不该能下 ${name}`);
}
assert.equal((await call(`/v1/cards/${id}/files/preview.jpg`, { key: a.key })).status, 404, '只给清单、层图、原图');

// 额度：上限 2，已经交了 1 张；再交 1 张，第 3 张 429。删掉的照样算
const second = await submit(a.key);
assert.equal(second.status, 202);
const secondId = (await second.json()).id;
const third = await submit(a.key);
assert.equal(third.status, 429, `第 3 张应当 429，实际 ${third.status}`);
assert.equal((await third.json()).code, 'quota_exceeded');
assert.equal((await call(`/v1/cards/${secondId}`, { key: a.key, method: 'DELETE' })).status, 200);
assert.equal((await call(`/v1/cards/${secondId}`, { key: a.key })).status, 404, '删掉的应当 404');
assert.equal((await submit(a.key)).status, 429, '删掉的也算额度');

// 吊销立即生效
apikey('revoke', a.id);
assert.equal((await call(`/v1/cards/${id}`, { key: a.key })).status, 401, '吊销后应当 401');

// 排队：先压一张接口任务在跑、一张在排，再交网页任务，网页的应当排第 1
const running = await submit(b.key);
const waiting = await submit(b.key);
assert.equal(running.status, 202);
assert.equal(waiting.status, 202);
const web = await call('/api/jobs', { method: 'POST', body: IMAGE, headers: { 'content-type': 'image/jpeg' } });
assert.equal(web.status, 202);
const webJob = await web.json();
assert.equal(webJob.position, 1, `网页任务应当插到接口任务前面，实际排第 ${webJob.position}`);

// 分享只认删除口令
await waitDone(`/api/jobs/${webJob.id}`, {}, (body) => body.state === 'done' || body.state === 'error');
assert.equal((await call(`/api/cards/${webJob.id}/share`, { method: 'POST' })).status, 403, '没有口令不能分享');
const shared = await call(`/api/cards/${webJob.id}/share`, { method: 'POST', headers: { 'x-holocard-token': webJob.deleteToken } });
assert.equal(shared.status, 200, '拿着口令能分享');

console.log('api ok');
