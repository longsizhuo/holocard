/**
 * 请求和响应的小工具：JSON 与错误响应、读请求体、来源 IP、请求语言、限流、同源判断、HTML 转义
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isLang, langFromAcceptLanguage, langFromCookie, type Lang } from '../src/i18n/core';

/**
 * 限流按什么记。IPv6 按 /64 记：一个用户手上通常是一整段 /64，逐个地址记的话每个请求换个地址就绕过去了。
 * IPv4（含 ::ffff:1.2.3.4 这种映射写法）照旧按地址
 */
function limitKey(ip: string): string {
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const [head = '', tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = tail === undefined ? h : [...h, ...new Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${full.slice(0, 4).join(':')}::/64`;
}

/** 简单的滑动窗口限流。单进程、内存态，够用；真被大规模刷再上 Cloudflare 的规则 */
export function makeLimiter(limit: number, windowMs: number): (ip: string) => boolean {
  const hits = new Map<string, number[]>();
  let sweptAt = 0;
  return (ip) => {
    const key = limitKey(ip);
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    // 已经超限的不再记账：不然一个 IP 狂刷时数组越来越长，被挡掉的请求也越来越费 CPU
    if (recent.length >= limit) {
      hits.set(key, recent);
      return true;
    }
    recent.push(now);
    hits.set(key, recent);
    // 过期条目每个窗口清一次。以前是超过 5000 条就每个请求全表扫一遍，被刷时正好最慢
    if (now - sweptAt >= windowMs) {
      sweptAt = now;
      for (const [k, times] of hits) {
        if (times.every((t) => now - t >= windowMs)) hits.delete(k);
      }
    }
    return false;
  };
}

/**
 * 定长字符串比较。长度不同时先比一个等长的占位串，让耗时与输入无关，
 * 不给「试出口令有多长」留侧信道。
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** 取真实来源 IP。前面隔着 Cloudflare 和 Caddy，socket 地址永远是 127.0.0.1 */
export function clientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0]?.trim() ?? 'unknown';
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * 认会话来改东西的请求，只收本站页面发的。
 * holocard-staging、invite 这些兄弟子域和这里同站（same-site），它们发来的请求照样带着会话 cookie，
 * SameSite=Lax 拦不住；浏览器给每个请求标的 Sec-Fetch-Site 能分出来
 */
export function sameOrigin(req: IncomingMessage): boolean {
  return req.headers['sec-fetch-site'] === 'same-origin';
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 出错响应。code 是稳定的错误类型，前端按它翻译成当前语言（src/i18n/messages.ts 里的 error.*）；
 * error 是中文原文，给日志、给没升级的旧页面看。
 */
export function fail(
  res: ServerResponse,
  status: number,
  code: string,
  error: string,
  params?: Record<string, string | number>,
): void {
  // 限流、排满、盘满这几种拒绝记一行：不记的话，被刷的时候日志里什么都看不出来
  if (status === 429 || status === 503 || status === 507) console.warn(`[reject] ${status} ${code}`);
  json(res, status, { error, code, ...(params ? { params } : {}) });
}

/**
 * 这次请求用哪种语言：地址上的 ?lang= → 接口请求头 x-holocard-lang（前端已经定好的语言）
 * → cookie → Accept-Language → 中文。和前端 src/i18n 的规则一致，
 * 页面一出来就是对的语言，不会先闪一下中文再变。
 */
export function requestLang(req: IncomingMessage, url: URL): Lang {
  const fromUrl = url.searchParams.get('lang');
  if (isLang(fromUrl)) return fromUrl;
  const fromHeader = req.headers['x-holocard-lang'];
  if (isLang(fromHeader)) return fromHeader;
  return (
    langFromCookie(req.headers.cookie) ?? langFromAcceptLanguage(req.headers['accept-language']) ?? 'zh'
  );
}

export function text(res: ServerResponse, type: string, body: string, method: string): void {
  res.writeHead(200, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    // 给爬虫的文件，一小时够了；改了之后不至于太久才生效
    'cache-control': 'public, max-age=3600',
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

/**
 * 读完请求体。超过 limit 就拒绝。
 * 给了 res：超了不立刻断开，等调用方回完错误（413）再断——先断开的话对方只看到连接被重置，
 * 隔着 Caddy 就成了 502，分不清是传太大还是服务挂了。没给（埋点、存配置这些几 KB 的）就照旧立刻断开
 */
export function readBody(req: IncomingMessage, limit: number, res?: ServerResponse): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`超过上限 ${Math.round(limit / 1024 / 1024)}MB`));
        if (res) {
          req.removeAllListeners('data');
          req.pause();
          res.setHeader('connection', 'close');
          res.once('finish', () => req.destroy());
        } else {
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** HTML 属性转义。卡片 id 是我们自己生成的 UUID，但注入前仍然一律转义 */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function unauthorized(res: ServerResponse): void {
  res.setHeader('www-authenticate', 'Bearer');
  fail(res, 401, 'unauthorized', '缺少 API key，或者 key 无效、已吊销');
}

export function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('allow', allow);
  fail(res, 405, 'method_not_allowed', '不支持的请求方法');
}
