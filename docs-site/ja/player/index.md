# プレーヤー

`@holocard/player` は、ウェブページで HoloCard のカードを描画する Web Component（`<holo-card>`）です。npm パッケージとして公開されており、フレームワークに依存せず、HTML・React・Vue などでそのまま利用できます。箔・グレア・視差はマニフェスト（[ファイル形式](/ja/format/)）のパラメーターに従って描画され、HoloCard のサイトと同じ見た目になります。

## インストール

CDN から読み込む場合：

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@holocard/player@0.1/dist/holocard.js"></script>
```

npm でインストールして読み込む場合：

```bash
npm install @holocard/player
```

```js
import '@holocard/player'; // <holo-card> 要素を登録します
```

本番環境では具体的なバージョン（例：`@0.1.0`）に固定し、`<script>` タグに[サブリソース完全性](https://www.jsdelivr.com/using-sri-with-dynamic-files)（SRI）のハッシュを付けることを推奨します。

## 使い方

1. カードの `manifest.json` と各レイヤー画像を、ファイル名を変えずにサーバーの同じディレクトリに配置します（例：`/cards/my-card/`）。[API](/ja/api/) で作成したカードは、ジョブの完了後にこれらのファイルをダウンロードできます。
2. ページに要素を追加します。

```html
<holo-card src="/cards/my-card"></holo-card>
```

`src` にはカードのディレクトリ、または `manifest.json` を直接指定できます。別オリジンの場合は、配信元で CORS を許可する必要があります。

## 属性

| 属性 | 既定値 | 説明 |
|---|---|---|
| `src` | — | カードのディレクトリ、または `manifest.json` の URL。変更すると再読み込みします |
| `gyro` | 有効 | 端末の傾きに合わせてカードを回転させます。`off` で無効化できます。iOS では最初のタップ時にジャイロスコープの許可を求めます |

## イベント

| イベント | 説明 |
|---|---|
| `load` | レイヤーの読み込みが完了し、カードが表示された |
| `error` | 読み込みに失敗した。理由は `event.detail.error` |

```js
document.querySelector('holo-card').addEventListener('error', (event) => {
  console.error(event.detail.error);
});
```

## サイズとスタイル

CSS で要素の幅を指定します（既定 `320px`）。高さはカードの縦横比に合わせて自動で決まります。

```css
holo-card { width: 100%; max-width: 360px; }
```

プレーヤーのスタイルは Shadow DOM 内に閉じています。ホストページの CSS はカードの内部に影響せず、プレーヤーもホストページにグローバルなスタイルを追加しません。

## ライセンス

箔の効果は [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css)（Simon Goellner）から移植したもので、そのライセンス文は npm パッケージに `LICENSE` として同梱されています。
