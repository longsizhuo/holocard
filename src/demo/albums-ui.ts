/**
 * 卡册的界面
 *
 * 页头「我的卡册」打开管理窗口，面板上「加入卡册」打开选择窗口，两者共用一个 <dialog>。
 * 用原生 dialog：遮罩、Esc 关闭、焦点圈在窗口里，这些浏览器都管了。
 * 内容整块重画——卡册是几个到几十个的量级，不值得做细粒度更新；切换语言时也按当前视图重画一遍。
 * 数据读写全在 albums.ts。
 */

import {
  CATEGORIES,
  coverOf,
  createAlbum,
  deleteAlbum,
  duplicateAlbum,
  getAlbum,
  loadAlbums,
  setCardInAlbum,
  updateAlbum,
  type Album,
} from './albums';
import { onLangChange, t, type MessageKey } from '../i18n';
import { track } from './track';

type View =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  /** id 为 null 是新建；addCard：从「加入卡册」进来新建的，建好直接把这张卡放进去 */
  | { kind: 'edit'; id: string | null; back: View; addCard?: string }
  | { kind: 'pick'; cardId: string };

const BASE = import.meta.env.BASE_URL;

let dialog: HTMLDialogElement | null = null;
let body: HTMLElement | null = null;
let view: View = { kind: 'list' };
/** 列表里要不要把归档的卡册也列出来 */
let showArchived = false;

/** 挂到页面上已有的 <dialog>。onClose：窗口关掉时（加入卡册之后面板要刷新提示） */
export function initAlbums(el: HTMLDialogElement, onClose: () => void): void {
  dialog = el;
  body = el.querySelector<HTMLElement>('.albums__body');
  el.querySelector('.albums__close')?.addEventListener('click', () => el.close());
  // 点遮罩关闭：遮罩上的点击，事件目标是 dialog 自己
  el.addEventListener('click', (event) => {
    if (event.target === el) el.close();
  });
  el.addEventListener('close', onClose);
  onLangChange(() => {
    if (el.open) render();
  });
}

export function openAlbums(): void {
  show({ kind: 'list' });
  dialog?.showModal();
}

export function openPicker(cardId: string): void {
  show({ kind: 'pick', cardId });
  dialog?.showModal();
}

/** 这张卡在几个卡册里 */
export function albumCountFor(cardId: string): number {
  return loadAlbums().filter((album) => album.cards.includes(cardId)).length;
}

function show(next: View): void {
  view = next;
  render();
  body?.scrollTo(0, 0);
}

function render(): void {
  if (!body) return;
  const v = view;
  const nodes =
    v.kind === 'list' ? listView() : v.kind === 'detail' ? detailView(v.id) : v.kind === 'edit' ? editView(v) : pickView(v);
  body.replaceChildren(...nodes.filter((node): node is Node | string => Boolean(node)));
}

// ---------- 小工具 ----------

type Child = Node | string | null | false | undefined;

/** 建一个元素：属性直接赋到元素上，子节点里的空值跳过 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child) node.append(child);
  return node;
}

function button(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
  const b = el('button', { type: 'button', className: `abtn ${variant}`.trim(), textContent: label });
  b.addEventListener('click', onClick);
  return b;
}

function categoryLabel(category: string): string {
  return (CATEGORIES as readonly string[]).includes(category) ? t(`cat.${category}` as MessageKey) : category;
}

/** 卡片缩略图。卡过期或被删了，服务端回 404，就换成「已过期」 */
function thumb(cardId: string | null): HTMLElement {
  const box = el('div', { className: 'athumb' });
  if (!cardId) return box;
  const img = el('img', { src: `${BASE}api/layers/${cardId}/thumb.jpg`, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => {
    img.remove();
    box.classList.add('is-gone');
    box.append(el('span', { textContent: t('albums.cardGone') }));
  });
  box.append(img);
  return box;
}

function note(): HTMLElement {
  return el('p', { className: 'albums__note', textContent: t('albums.localNote') });
}

// ---------- 卡册列表 ----------

function listView(): Child[] {
  const albums = loadAlbums();
  const archived = albums.filter((album) => album.archived).length;
  const head = el(
    'div',
    { className: 'albums__head' },
    el('h2', { textContent: t('albums.title') }),
    button(t('albums.new'), () => show({ kind: 'edit', id: null, back: { kind: 'list' } }), 'is-primary'),
  );
  if (albums.length === 0) return [head, el('p', { className: 'albums__empty', textContent: t('albums.empty') }), note()];

  const shown = showArchived ? albums : albums.filter((album) => !album.archived);
  return [
    head,
    el('div', { className: 'albums__grid' }, ...shown.map(albumTile)),
    archived > 0 &&
      button(
        showArchived ? t('albums.hideArchived') : t('albums.showArchived', { n: archived }),
        () => {
          showArchived = !showArchived;
          render();
        },
        'is-link',
      ),
    note(),
  ];
}

function albumMeta(album: Album): string {
  return [t('albums.count', { n: album.cards.length }), album.category && categoryLabel(album.category), album.archived && t('albums.archived')]
    .filter(Boolean)
    .join(' · ');
}

function albumTile(album: Album): HTMLElement {
  const tile = el(
    'button',
    { type: 'button', className: `atile${album.archived ? ' is-archived' : ''}` },
    thumb(coverOf(album)),
    el('strong', { textContent: album.name }),
    el('span', { textContent: albumMeta(album) }),
  );
  tile.addEventListener('click', () => show({ kind: 'detail', id: album.id }));
  return tile;
}

// ---------- 卡册详情 ----------

function detailView(id: string): Child[] {
  const album = getAlbum(id);
  if (!album) return listView();

  const actions = el(
    'div',
    { className: 'albums__actions' },
    button(t('albums.edit'), () => show({ kind: 'edit', id, back: { kind: 'detail', id } })),
    button(t('albums.duplicate'), () => {
      const copy = duplicateAlbum(id, t('albums.copySuffix'));
      if (copy) show({ kind: 'detail', id: copy.id });
    }),
    button(t(album.archived ? 'albums.unarchive' : 'albums.archive'), () => {
      updateAlbum(id, { archived: !album.archived });
      render();
    }),
    button(
      t('albums.delete'),
      () => {
        if (!confirm(t('albums.deleteConfirm', { name: album.name }))) return;
        deleteAlbum(id);
        show({ kind: 'list' });
      },
      'is-danger',
    ),
  );

  const cover = coverOf(album);
  const cards = album.cards.map((cardId) =>
    el(
      'div',
      { className: 'acard' },
      // 点进去就是这张卡的页面；主人在那里照样能分享、导出、删除
      el('a', { href: `${BASE}c/${cardId}` }, thumb(cardId)),
      el(
        'div',
        { className: 'acard__tools' },
        cardId === cover
          ? el('span', { className: 'acard__cover', textContent: t('albums.isCover') })
          : button(t('albums.setCover'), () => {
              updateAlbum(id, { cover: cardId });
              render();
            }, 'is-mini'),
        button(t('albums.remove'), () => {
          setCardInAlbum(id, cardId, false);
          render();
        }, 'is-mini'),
      ),
    ),
  );

  return [
    button(`← ${t('albums.back')}`, () => show({ kind: 'list' }), 'is-link'),
    el('h2', { textContent: album.name }),
    el('p', {
      className: 'albums__meta',
      textContent: [albumMeta(album), album.author && t('albums.by', { author: album.author })].filter(Boolean).join(' · '),
    }),
    album.intro && el('p', { className: 'albums__intro', textContent: album.intro }),
    actions,
    cards.length
      ? el('div', { className: 'albums__grid' }, ...cards)
      : el('p', { className: 'albums__empty', textContent: t('albums.emptyAlbum') }),
  ];
}

// ---------- 新建 / 编辑 ----------

function field(label: string, ...controls: HTMLElement[]): HTMLElement {
  return el('label', { className: 'field' }, el('span', { className: 'field__label', textContent: label }), ...controls);
}

function editView(v: Extract<View, { kind: 'edit' }>): Child[] {
  const album = v.id ? getAlbum(v.id) : null;

  const name = el('input', { type: 'text', value: album?.name ?? '', maxLength: 40 });
  const author = el('input', { type: 'text', value: album?.author ?? '', maxLength: 30 });
  const intro = el('textarea', { value: album?.intro ?? '', maxLength: 200, rows: 3 });

  // 分类：预设的存键，自定义的直接存名字
  const current = album?.category ?? '';
  const preset = current === '' || (CATEGORIES as readonly string[]).includes(current) ? current : 'custom';
  const category = el(
    'select',
    {},
    el('option', { value: '', textContent: t('albums.noCategory') }),
    ...CATEGORIES.map((c) => el('option', { value: c, textContent: t(`cat.${c}` as MessageKey) })),
    el('option', { value: 'custom', textContent: t('albums.custom') }),
  );
  category.value = preset;
  const custom = el('input', {
    type: 'text',
    value: preset === 'custom' ? current : '',
    maxLength: 20,
    placeholder: t('albums.customPlaceholder'),
    hidden: preset !== 'custom',
  });
  category.addEventListener('change', () => {
    custom.hidden = category.value !== 'custom';
    if (!custom.hidden) custom.focus();
  });

  // 封面：只有已经有卡的卡册才有得选
  let cover = album?.cover ?? null;
  const coverField =
    album && album.cards.length > 0
      ? field(
          t('albums.cover'),
          el(
            'div',
            { className: 'acovers' },
            ...[null, ...album.cards].map((cardId) => {
              const pick = el(
                'button',
                { type: 'button', className: `acovers__item${cover === cardId ? ' is-on' : ''}` },
                cardId ? thumb(cardId) : el('span', { textContent: t('albums.coverAuto') }),
              );
              pick.addEventListener('click', () => {
                cover = cardId;
                for (const other of pick.parentElement?.children ?? []) other.classList.toggle('is-on', other === pick);
              });
              return pick;
            }),
          ),
        )
      : null;

  const hint = el('small', { className: 'field__hint albums__error' });
  const form = el(
    'form',
    { className: 'albums__form', noValidate: true },
    field(t('albums.name'), name),
    field(t('albums.author'), author),
    field(t('albums.intro'), intro),
    field(t('albums.category'), category, custom),
    coverField,
    hint,
    el(
      'div',
      { className: 'albums__actions' },
      button(t('albums.cancel'), () => show(v.back)),
      el('button', { type: 'submit', className: 'abtn is-primary', textContent: t('albums.save') }),
    ),
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = {
      name: name.value.trim(),
      author: author.value.trim(),
      intro: intro.value.trim(),
      category: category.value === 'custom' ? custom.value.trim() : category.value,
      cover,
    };
    if (!fields.name) {
      hint.textContent = t('albums.nameRequired');
      name.focus();
      return;
    }
    if (album) {
      if (!updateAlbum(album.id, fields)) {
        hint.textContent = t('albums.saveFailed');
        return;
      }
      show({ kind: 'detail', id: album.id });
      return;
    }
    const created = createAlbum(fields);
    if (!created) {
      hint.textContent = t('albums.saveFailed');
      return;
    }
    track('album-create');
    if (v.addCard) {
      setCardInAlbum(created.id, v.addCard, true);
      track('album-add');
    }
    show(v.back.kind === 'pick' ? v.back : { kind: 'detail', id: created.id });
  });

  // 新建时直接把光标放进名称框，手机上键盘跟着弹出来
  if (!album) queueMicrotask(() => name.focus());
  return [el('h2', { textContent: t(album ? 'albums.editTitle' : 'albums.new') }), form];
}

// ---------- 加入卡册 ----------

function pickView(v: Extract<View, { kind: 'pick' }>): Child[] {
  // 归档了的卡册不往里加新卡，但这张卡已经在里面的照样列出来，好把它拿出来
  const albums = loadAlbums().filter((album) => !album.archived || album.cards.includes(v.cardId));
  const rows = albums.map((album) => {
    const box = el('input', { type: 'checkbox', checked: album.cards.includes(v.cardId) });
    box.addEventListener('change', () => {
      if (setCardInAlbum(album.id, v.cardId, box.checked) && box.checked) track('album-add');
      render();
    });
    return el(
      'label',
      { className: 'apick' },
      box,
      thumb(coverOf(album)),
      el('span', {}, el('strong', { textContent: album.name }), el('small', { textContent: albumMeta(album) })),
    );
  });

  return [
    el('h2', { textContent: t('albums.addTitle') }),
    rows.length
      ? el('div', { className: 'albums__picks' }, ...rows)
      : el('p', { className: 'albums__empty', textContent: t('albums.pickEmpty') }),
    el(
      'div',
      { className: 'albums__actions' },
      button(`+ ${t('albums.new')}`, () => show({ kind: 'edit', id: null, back: v, addCard: v.cardId })),
      button(t('albums.done'), () => dialog?.close(), 'is-primary'),
    ),
    note(),
  ];
}
