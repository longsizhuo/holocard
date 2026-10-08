/**
 * 服务的配置：环境变量和由它们推出来的值。别的模块都从这里取，不各自读 process.env。
 * 导入时就生效的两件事也在这里：模型只从本地目录加载，以及正式地址下拒绝开假登录。
 * 各变量的说明见 docs-site/deploy/index.md「环境变量」
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { env } from '@huggingface/transformers';
import { MATTE_MODEL_ID, matteWeightsFile, type MatteModelConfig } from '../src/segmenter/matte';

export const PORT = Number(process.env.HOLOCARD_PORT ?? 8791);
export const OUT_DIR = process.env.HOLOCARD_OUT_DIR ?? '/srv/holocard-layers';
export const MODEL_DIR = process.env.HOLOCARD_MODEL_DIR ?? '/srv/holocard-models';
/** 卡片数据库。默认放在产物目录的旁边，线上就是 /srv/holocard-data/holocard.db */
export const DB_PATH =
  process.env.HOLOCARD_DB ?? join(dirname(resolve(OUT_DIR)), 'holocard-data', 'holocard.db');
/** 上传体积上限。手机直出的照片通常 3~8MB */
export const MAX_UPLOAD = Number(process.env.HOLOCARD_MAX_UPLOAD ?? 16 * 1024 * 1024);
/** 同时处理几张。这台机器 4 核且已有其他负载，多了只会互相拖慢并吃满内存 */
export const CONCURRENCY = Number(process.env.HOLOCARD_CONCURRENCY ?? 1);
/** 队列排到这么长就直接拒绝，让用户立刻知道，而不是排十分钟。只数网页的，对外接口另算（MAX_API_QUEUE） */
export const MAX_QUEUE = Number(process.env.HOLOCARD_MAX_QUEUE ?? 12);
/**
 * 对外接口（/v1）在队列里最多同时有几张。网页任务总是插在接口任务前面（见 enqueue），
 * 再加这个上限，接口怎么刷都挤不掉网页用户
 */
export const MAX_API_QUEUE = Number(process.env.HOLOCARD_MAX_API_QUEUE ?? 6);
/** 一个 key 同时最多几张在排队或处理中 */
export const API_KEY_IN_FLIGHT = 3;
/**
 * 所有 key 加起来每 24 小时最多几张。单机一张半分钟到一分钟，一天安全能做一千出头，
 * 网页实际只用掉百分之一左右；这个上限保证接口最多占两成
 */
export const API_DAILY_LIMIT = Number(process.env.HOLOCARD_API_DAILY_LIMIT ?? 500);
/** 登录用户在个人中心自己申请的 key，每个账号 24 小时最多几张。要更多的找站长用 scripts/apikey.mjs 发 */
export const SELF_SERVE_DAILY_LIMIT = Number(process.env.HOLOCARD_SELF_SERVE_DAILY_LIMIT ?? 20);
/** 一个账号同时能有几个没吊销的 key。会忘记手上有哪个，就再申请一个，额度是账号共用的 */
export const MAX_KEYS_PER_ACCOUNT = 10;
/**
 * 产物目录所在的盘剩下不到这么多就不收上传。和 Postgres 等别的服务共用根分区，
 * 有人持续上传把盘写满，挂的不只是这个服务
 */
export const MIN_FREE_BYTES = Number(process.env.HOLOCARD_MIN_FREE_GB ?? 5) * 1024 ** 3;
/**
 * 保留策略。
 *
 * 没分享过的：从生成算起 7 天，到点就删——多半是试一下就走了。
 * 分享过的：从**最后一次被访问**算起，窗口长度随访问量翻倍地涨。
 *   访问 1 次   → 7 天      （第一次分享出去、有人点开，就再留 7 天）
 *   访问 2-3 次 → 14 天
 *   访问 4-7 次 → 28 天
 *   ……每翻一番加一档，封顶 112 天（7 × 2^4，KEEP_DOUBLINGS_CAP = 5 档）
 *
 * 「从最后一次访问算起」是关键：一直有人看的卡窗口不断续期，一直留着；
 * 彻底没人看了才开始倒计时。这样热门内容留得久、冷内容自然退场，
 * 磁盘占用有上界，不需要人工清理。放进账号的卡、对外接口的卡另有规则，见 cards.ts 的 expiresAt。
 */
export const TTL_MS = Number(process.env.HOLOCARD_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
/** 分享过的卡每翻一番访问量多留一档，最多翻几番 */
export const KEEP_DOUBLINGS_CAP = 5;
/** 每个 IP 在窗口内最多提交几次，挡住把这里当图床刷的人 */
export const RATE_LIMIT = Number(process.env.HOLOCARD_RATE_LIMIT ?? 10);
export const RATE_WINDOW_MS = Number(process.env.HOLOCARD_RATE_WINDOW_MS ?? 10 * 60 * 1000);
/** 站点对外的地址，用来拼分享链接里的绝对 URL（OG 标签必须是绝对地址） */
export const PUBLIC_ORIGIN = process.env.HOLOCARD_PUBLIC_ORIGIN ?? 'https://holocard.longsizhuo.com';
/**
 * 用 IH 账号登录（见 auth.ts）。secret 是 IH 后端给 holocard 这个 client 发的，没配就不开登录。
 * 换码直连同机的 IH 后端，不走公网
 */
export const SSO_SECRET = process.env.HOLOCARD_SSO_SECRET ?? '';
/** 在 IH 登记的 client。staging 单独一个（holocard-staging），secret 和回跳地址都和线上分开 */
export const SSO_CLIENT_ID = process.env.HOLOCARD_SSO_CLIENT_ID ?? 'holocard';
export const SSO_AUTHORIZE_URL = process.env.HOLOCARD_SSO_AUTHORIZE_URL ?? 'https://involutionhell.com/sso/authorize';
export const SSO_TOKEN_URL = process.env.HOLOCARD_SSO_TOKEN_URL ?? 'http://127.0.0.1:8080/internal/sso/token';
/**
 * 假登录：/auth/login 直接登进一个测试账号，不经过 IH。只给 staging 用：要能在手机上试登录后的界面，
 * 而 staging 的 IH client 密钥得由站长配（见 deploy/README.md「登录」）。staging 的地址上没配密钥时自动打开，
 * 别处要显式设 HOLOCARD_AUTH_FAKE=1（本地开发）。正式站开着它谁都能登进同一个账号，所以正式地址下拒绝启动
 */
export const AUTH_FAKE =
  process.env.HOLOCARD_AUTH_FAKE === '1' ||
  (PUBLIC_ORIGIN === 'https://holocard.staging.longsizhuo.com' && SSO_SECRET === '');
if (AUTH_FAKE && PUBLIC_ORIGIN === 'https://holocard.longsizhuo.com') {
  throw new Error('HOLOCARD_AUTH_FAKE 只能在 staging 用，正式站不能开');
}
export const LOGIN_ENABLED = AUTH_FAKE || SSO_SECRET !== '';

/**
 * 前端静态文件目录。留空则不发静态文件（开发时由 vite dev 发）。
 *
 * 由这个服务自己发而不是交给上游的 Caddy，有两个原因：
 * 一是那台机器的 Caddy 跑在容器里，加一个目录挂载要重建容器、会让同机的其他站点瞬断；
 * 二是自己能发才算自包含，别人拿去单跑一个 Node 进程就是完整的站点。
 */
export const WEB_DIR = process.env.HOLOCARD_WEB_DIR ?? '';

// 权重随服务一起部署，不在运行时去 Hugging Face 拉——这台机器未必连得上，
// 而且首个用户不该为下载权重等着
env.localModelPath = MODEL_DIR;
env.allowRemoteModels = false;

/**
 * 抠主体的权重（BiRefNet_lite，214MB，下载见 deploy/README.md）。
 * 没放就不抠，照旧只按深度切层：开发机、没下权重的环境照样能跑。
 *
 * 还要看这个进程的内存上限（systemd 的 MemoryMax）。抠一张峰值约 7GB，上限不够的话一抠就被 cgroup 杀掉，
 * 重启后续跑同一张又被杀，整个服务反复崩。权重在共享目录里、代码随 PR 自动上 staging、unit 文件要另外装，
 * 三样不是同一步到位的，所以在这里自己挡住：上限不够就当没有权重。
 */
const MATTE_MIN_MEMORY = 8 * 2 ** 30;
/**
 * 抠图模型，默认 lite。换型号、做盲评对比时用环境变量指定，不用改代码（流程见 docs-site/develop/index.md「双盲对比」）：
 *   HOLOCARD_MATTE_MODEL  模型名，比如 onnx-community/BiRefNet_512x512-ONNX
 *   HOLOCARD_MATTE_SIZE   输入边长，要和这份 ONNX 导出时的尺寸一致
 *   HOLOCARD_MATTE_DTYPE  fp32 / fp16 / q8
 */
export const MATTE_MODEL: MatteModelConfig = {
  id: process.env.HOLOCARD_MATTE_MODEL ?? MATTE_MODEL_ID,
  size: Number(process.env.HOLOCARD_MATTE_SIZE ?? 1024),
  dtype: (process.env.HOLOCARD_MATTE_DTYPE ?? 'fp32') as MatteModelConfig['dtype'],
};
export const MATTE_WEIGHTS = existsSync(join(MODEL_DIR, matteWeightsFile(MATTE_MODEL)));
// 没有限制时是 0（或者一个天文数字）
export const MEMORY_CAP = process.constrainedMemory();
export const MATTE_READY = MATTE_WEIGHTS && (MEMORY_CAP === 0 || MEMORY_CAP >= MATTE_MIN_MEMORY);

/**
 * 导出动图：同时排队的上限，和每个 IP 在限流窗口内最多导出几次。
 * 一次导出要十几到几十秒的 CPU（无头浏览器软件渲染 + 视频编码），比分层还重。
 */
export const MAX_EXPORT_QUEUE = Number(process.env.HOLOCARD_MAX_EXPORT_QUEUE ?? 6);
export const EXPORT_RATE_LIMIT = Number(process.env.HOLOCARD_EXPORT_RATE_LIMIT ?? 8);

export const DAY_MS = 24 * 60 * 60 * 1000;
