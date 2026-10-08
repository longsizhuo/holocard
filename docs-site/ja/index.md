# HoloCard API

HTTP で写真を動くレイヤーカードにして、プレーヤーで自分のウェブページに載せられます。

## クイックスタート

手順は 4 つ：キーを取る → 画像を送る → 完成を待ってファイルをダウンロード → プレーヤーでページに載せる。

```bash
# 1. 送信：photo.jpg を手元の画像のパスに置き換え（PNG は Content-Type を image/png に）
curl -X POST https://holocard.longsizhuo.com/v1/cards \
  -H "Authorization: Bearer hc_あなたのキー" \
  -H "Content-Type: image/jpeg" --data-binary @photo.jpg
# → 202 {"id":"3f1c…","status":"queued","position":1,"url":"…"}

# 2. 数秒おきに確認。status が done になるとマニフェストと各ファイルの URL が付きます
curl https://holocard.longsizhuo.com/v1/cards/3f1c… -H "Authorization: Bearer hc_あなたのキー"

# 3. ファイル（マニフェストと各レイヤー）をダウンロード。ここでもキーが必要です
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/manifest.json -H "Authorization: Bearer hc_あなたのキー"
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/layer-0.webp -H "Authorization: Bearer hc_あなたのキー"
```

1 枚 30 秒〜1 分ほどで、混んでいるともう少しかかります。**ファイルは送信から 24 時間後に削除されます**。自分のサーバーにダウンロードしてください。

## キーの取得

1. [HoloCard](https://holocard.longsizhuo.com/?lang=ja) の右上の「ログイン」から involutionhell アカウントでログインします（GitHub で登録できます）。
2. 右上のアバターからアカウント画面を開き、「外部 API」の「API キーを申請」を押します。
3. キーは `hc_` と 32 文字で、**表示されるのは一度だけ**です。コピーして保存してください。なくしたら無効にして申請し直せます。

使えるキーは 1 アカウントにつき 1 つで、無効にするとすぐに使えなくなります。リクエストヘッダーに付けます：

```http
Authorization: Bearer hc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

::: warning
キーはあなたの身元そのものです。フロントエンドのコードや公開リポジトリには入れず、自分のサーバーでだけ使ってください。
:::

## エンドポイント

すべて `https://holocard.longsizhuo.com` 配下で、JSON を返します。エラーは `{"error": "説明", "code": "種類"}` です。

### `POST /v1/cards` 画像を送る

本文は画像そのもの（フォームではありません）で、`Content-Type` に画像の種類を書きます。JPEG・PNG・WebP・AVIF・HEIC、16MB まで。EXIF は削除され、向きは自動で直ります。

`202` が返ります：

```json
{ "id": "3f1c…", "status": "queued", "position": 1, "url": "https://holocard.longsizhuo.com/v1/cards/3f1c…" }
```

### `GET /v1/cards/{id}` 進み具合と結果

| 項目 | 説明 |
|---|---|
| `status` | `queued` 待ち、`running` 処理中、`done` 完成、`failed` 失敗 |
| `position` | 待ち行列の順番（自分を含む） |
| `eta` | 残りのおおよその秒数（待ち・処理中のみ） |
| `expiresAt` | ファイルが削除される時刻 |
| `manifest` | 完成時のみ：カードのマニフェスト（[ファイル形式](#ファイル形式)参照） |
| `files` | 完成時のみ：ファイル名 → ダウンロード URL |
| `error.code` | 失敗時のみ：`nsfw_rejected` 裸の写真、`moderation_unavailable` 判定が一時的に使えない、`processing_failed` 処理エラー |

### `GET /v1/cards/{id}/files/{name}` ファイルのダウンロード

`manifest.json`、各レイヤー画像 `layer-N.webp`（一部の古いカードは `.png`）、EXIF を消した元画像。名前は `files` に従ってください。

### `DELETE /v1/cards/{id}` 早めに削除

すぐにファイルを削除して `{"deleted": true}` を返します。待ち行列中のものも取り消されます。

### 補足

- カードは送信したキーでしか見られず、それ以外は `404` になります。
- API で作ったカードは非公開で、サイトには出ず、サイト上での共有や書き出しもできません。
- 裸の判定が済んでから納品し、完全な裸の写真は拒否されます（`nsfw_rejected`）。水着などは問題ありません。
- サイトの利用者が優先で、API のジョブはその後ろに並びます。

## 上限とエラー

| ステータス | code | 意味 |
|---|---|---|
| 401 | | キーがない、間違っている、無効化された |
| 404 | `card_not_found` / `file_not_found` | カードがない、自分のものでない、削除・期限切れ |
| 413 | `too_large` | 16MB を超えている |
| 415 | `unsupported_image` | 画像として認識できない |
| 429 | `quota_exceeded` | 24 時間の上限：自分で申請したキーは 1 アカウント 20 枚（無効にして申請し直してもリセットされません） |
| 429 | `too_many_in_flight` | 1 つのキーで同時にアップロード・待ち・処理中にできるのは 3 枚まで |
| 429 | `rate_limited` | 10 分で送信の試行が 30 回を超えた |
| 503 | `api_daily_limit` / `queue_full` / `busy` | 今日の API 全体の上限に達したか、混雑中。しばらくしてから再試行 |
| 507 | `disk_full` | サーバーの容量不足。しばらくしてから再試行 |

もっと多く使いたい場合はサイト管理者にご連絡ください。

## ページに載せる

ダウンロードしたファイルを動かすにはプレーヤーが必要です。npm パッケージ [`@holocard/player`](https://www.npmjs.com/package/@holocard/player) は標準のカスタム要素で、HTML・React・Vue でそのまま使えます。

1. `manifest.json` と各レイヤー画像を、名前を変えずにサーバーの同じフォルダーに置きます（例：`/cards/my-card/`）。
2. ページに追加します：

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@holocard/player@0.1/dist/holocard.js"></script>
<holo-card src="/cards/my-card"></holo-card>
```

ビルドツールを使う場合は `npm install @holocard/player` のあと `import '@holocard/player'`。

| | 説明 |
|---|---|
| `src` | カードのフォルダー、または `manifest.json`。別ドメインに置く場合は CORS の許可が必要 |
| `gyro` | 既定でスマホの傾きに追従。`gyro="off"` で無効。iOS は最初のタップで許可を求めます |
| サイズ | `holo-card` に幅を指定（既定 320px）。高さはカードの比率に合わせて決まります |
| イベント | `load` 表示完了、`error` 読み込み失敗（理由は `event.detail.error`） |

スタイルは Shadow DOM の中にあり、ページの CSS とは干渉しません。本番では具体的なバージョン（例：`@0.1.0`）に固定するのがおすすめです。

## ファイル形式

カードは 1 つのフォルダーで、`manifest.json` とレイヤーごとの画像からなります。レイヤーは奥から手前の順で、それぞれ元画像と同じ大きさの透過画像です。マニフェストはおおよそ次のとおりです：

```json
{
  "version": 1,
  "source": { "width": 1400, "height": 788 },
  "layers": [
    { "file": "layer-0.webp", "depth": 0.13, "parallax": 0, "bbox": [0, 0, 1400, 788], "foil": { "type": "sunpillar", "intensity": 1 } },
    { "file": "layer-1.webp", "depth": 0.62, "parallax": 1, "bbox": [310, 0, 1090, 788], "foil": { "type": "none", "intensity": 1 } }
  ],
  "effects": {
    "halo": { "intensity": 0.35, "light": { "peakAt": [0.7, -0.7], "sharpness": 120 } },
    "glare": true,
    "parallax": { "enabled": true, "amplitude": 0.1 }
  }
}
```

箔・グレア・視差はすべてマニフェストに入っていて、プレーヤーはそれに従います。通常は手で編集する必要はありません。
