/**
 * 网页用的接口（/api，处理在 server/routes/）返回的结构，前端（web/）和服务端共用这一份：
 * 服务端回之前用 satisfies 对上，前端按它解析，哪边改了字段另一边类型检查就过不去。
 * 对外接口 /v1 的结构以文档为准（docs-site/api/），不在这里。
 */

/** 出错时的返回体（server/http.ts 的 fail）。code 是稳定的错误类型，前端按它翻译；error 是中文原文 */
export interface ApiErrorBody {
  error: string;
  code?: string;
  params?: Record<string, string | number>;
}

/** POST /api/jobs → 202 */
export interface JobCreated {
  id: string;
  /** 排在第几 */
  position: number;
  /**
   * 删除口令，只在这一次给，丢了就再也拿不到。
   * 登录着做的卡没有口令（null）：它直接归到账号下，主人认的是登录状态
   */
  deleteToken: string | null;
}

/** GET /api/jobs/<id> */
export interface JobStatus {
  state: 'queued' | 'running' | 'done' | 'error';
  /** 流水线走到哪一步（src/segmenter 的阶段名），没开始或做完是 null */
  stage: string | null;
  /** 排在第几，不在排队是 0 */
  position: number;
  /** 估计还要多少秒，排队加处理（见 server/pipeline/eta.ts）；估不出来时没有 */
  eta?: number;
  /** 做好后 .layers 目录的地址 */
  layers?: string;
  /** 层数；库里这一列可空 */
  layerCount?: number | null;
  error?: string;
}

/** POST /api/cards/<id>/share → 200 */
export interface Shared {
  url: string;
  /** 毫秒时间戳；分享过的卡按访问续期，这是此刻算出的到期时间 */
  expiresAt: number;
}

export interface ExportedFile {
  url: string;
  /** 下载时的文件名 */
  name: string;
  type: string;
}

/** POST /api/cards/<id>/export/<格式> → 202，GET 同一地址查进度 */
export type ExportStatus =
  | { state: 'none' }
  | { state: 'queued'; position: number }
  | { state: 'running' }
  | { state: 'error'; error: string }
  | { state: 'done'; files: ExportedFile[] };

export interface Account {
  id: string;
  name: string;
  avatar: string | null;
}

/** GET /api/me */
export interface Me {
  /** 这个部署开没开登录 */
  login: boolean;
  user: Account | null;
  /** 账号名下还在的卡，最新的在前；没登录是空的 */
  cards: string[];
}

/** POST /api/me/claim → 200：认领成功的卡 */
export interface Claimed {
  claimed: string[];
}

/** 个人中心里的对外接口 key。key 本身只在申请那一次的响应里有 */
export interface MyKey {
  id: string;
  createdAt: string;
}

/** GET /api/me/keys：还能用的 key 和账号的额度，几个 key 共用，dailyLimit 为 null 是不限（管理员） */
export interface MyKeys {
  keys: MyKey[];
  used: number;
  dailyLimit: number | null;
}

/** POST /api/me/keys → 201 */
export interface KeyCreated {
  id: string;
  key: string;
}
