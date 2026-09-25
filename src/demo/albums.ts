/**
 * 卡册（issue #3 第 5 条）
 *
 * 这个站没有账号，卡册只存在这台设备的浏览器里（localStorage），和删除口令一个待遇。
 * 所以 PRD 里的「可见性」「登录后云端同步」先不做：没有服务端存储，卡册本来就只有自己看得见。
 * 卡册里只存卡片 id，不存图——卡片本身在服务端，过期了卡册里就显示「已过期」。
 *
 * 这里只管数据，不碰界面，界面在 albums-ui.ts。
 */

export interface Album {
  id: string;
  name: string;
  /** 署名 */
  author: string;
  /** 简介 */
  intro: string;
  /** 预设分类的键（见 CATEGORIES），或者用户自己填的分类名 */
  category: string;
  /** 封面用哪张卡。null 表示自动取第一张 */
  cover: string | null;
  archived: boolean;
  /** 卡片 id，按加入的先后排 */
  cards: string[];
  createdAt: number;
  updatedAt: number;
}

/** 预设分类。存的是键，显示时按当前语言翻译；不在这里面的就是用户自定义的分类名 */
export const CATEGORIES = ['idol', 'pet', 'travel', 'original'] as const;

const KEY = 'holocard:albums';

/** 卡片 id 就是服务端生成的 UUID。卡片 id 会拼进图片地址和链接里，格式不对的一律丢掉 */
const CARD_ID = /^[0-9a-f-]{36}$/;

/**
 * 把读出来的一条按当前结构规范一遍。数据存在用户的浏览器里，旧版本写的、被手改坏的都可能出现：
 * 缺的字段补默认值，连 id 都没有的整条丢掉——不能因为一条坏数据让整个卡册窗口打不开。
 */
function normalize(raw: unknown): Album | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const id = a['id'];
  if (typeof id !== 'string' || id === '') return null;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const time = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cards = Array.isArray(a['cards'])
    ? a['cards'].filter((c): c is string => typeof c === 'string' && CARD_ID.test(c))
    : [];
  const cover = a['cover'];
  return {
    id,
    name: text(a['name']),
    author: text(a['author']),
    intro: text(a['intro']),
    category: text(a['category']),
    cover: typeof cover === 'string' && cards.includes(cover) ? cover : null,
    archived: a['archived'] === true,
    cards: [...new Set(cards)],
    createdAt: time(a['createdAt']),
    updatedAt: time(a['updatedAt']),
  };
}

export function loadAlbums(): Album[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.map(normalize).filter((album): album is Album => album !== null) : [];
  } catch {
    // 隐私模式下 localStorage 可能直接抛；数据被改坏了也当没有
    return [];
  }
}

/** 存不下（隐私模式、配额满）时返回 false，界面据此提示 */
function save(albums: Album[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(albums));
    return true;
  } catch {
    return false;
  }
}

/** 读出来、改一下、存回去。改的函数返回 false 表示没改动，不必写盘 */
function mutate(change: (albums: Album[]) => boolean | void): boolean {
  const albums = loadAlbums();
  if (change(albums) === false) return true;
  return save(albums);
}

export function getAlbum(id: string): Album | null {
  return loadAlbums().find((album) => album.id === id) ?? null;
}

export type AlbumFields = Pick<Album, 'name' | 'author' | 'intro' | 'category' | 'cover'>;

export function createAlbum(fields: AlbumFields): Album | null {
  const now = Date.now();
  const album: Album = { ...fields, id: crypto.randomUUID(), archived: false, cards: [], createdAt: now, updatedAt: now };
  return mutate((albums) => void albums.unshift(album)) ? album : null;
}

export function updateAlbum(id: string, patch: Partial<Omit<Album, 'id' | 'createdAt'>>): boolean {
  return mutate((albums) => {
    const album = albums.find((a) => a.id === id);
    if (!album) return false;
    Object.assign(album, patch, { updatedAt: Date.now() });
  });
}

/** 复制一份：卡片列表和各项信息都带上，名字后面加后缀，默认不归档 */
export function duplicateAlbum(id: string, suffix: string): Album | null {
  const source = getAlbum(id);
  if (!source) return null;
  const now = Date.now();
  const copy: Album = {
    ...source,
    id: crypto.randomUUID(),
    name: `${source.name}${suffix}`,
    archived: false,
    cards: [...source.cards],
    createdAt: now,
    updatedAt: now,
  };
  return mutate((albums) => void albums.splice(albums.findIndex((a) => a.id === id) + 1, 0, copy)) ? copy : null;
}

/** 删卡册不删卡：卡片在服务端，别的卡册里也可能有它 */
export function deleteAlbum(id: string): boolean {
  return mutate((albums) => {
    const index = albums.findIndex((a) => a.id === id);
    if (index < 0) return false;
    albums.splice(index, 1);
  });
}

/** 把卡片放进或拿出某个卡册 */
export function setCardInAlbum(albumId: string, cardId: string, inside: boolean): boolean {
  return mutate((albums) => {
    const album = albums.find((a) => a.id === albumId);
    if (!album || album.cards.includes(cardId) === inside) return false;
    album.cards = inside ? [...album.cards, cardId] : album.cards.filter((c) => c !== cardId);
    // 封面那张被拿走了就退回自动
    if (!inside && album.cover === cardId) album.cover = null;
    album.updatedAt = Date.now();
  });
}

/** 卡册的封面卡：指定了就用指定的，否则第一张，空卡册没有封面 */
export function coverOf(album: Album): string | null {
  return album.cover && album.cards.includes(album.cover) ? album.cover : (album.cards[0] ?? null);
}
