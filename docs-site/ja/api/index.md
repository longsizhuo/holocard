# HoloCard API

HoloCard API は、写真をレイヤー構造のホログラフィックカードに変換し、カードのマニフェストと各レイヤー画像を返します。[`@holocard/player`](/ja/player/) を使うと、任意のウェブページで表示できます。

## クイックスタート

利用の流れは次の 4 段階です。

1. API キーを取得する
2. 画像を送信する
3. ジョブの状態を確認し、完了後に結果ファイルをダウンロードする
4. プレーヤーでウェブページに表示する

```bash
# 1. 画像の送信（photo.jpg をローカルの画像パスに置き換えてください。PNG の場合は Content-Type を image/png に設定します）
curl -X POST https://holocard.longsizhuo.com/v1/cards \
  -H "Authorization: Bearer hc_xxx" \
  -H "Content-Type: image/jpeg" --data-binary @photo.jpg
# レスポンス：202 {"id":"3f1c…","status":"queued","position":1,"url":"…"}

# 2. ジョブの状態の確認（数秒間隔で確認します。status が done になると、マニフェストとファイルの URL が返されます）
curl https://holocard.longsizhuo.com/v1/cards/3f1c… -H "Authorization: Bearer hc_xxx"

# 3. 結果ファイルのダウンロード（マニフェストと各レイヤー画像。API キーが必要です）
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/manifest.json -H "Authorization: Bearer hc_xxx"
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/layer-0.webp -H "Authorization: Bearer hc_xxx"
```

処理時間は 1 枚あたり通常 30〜60 秒で、待ち行列がある場合はさらにかかります。**結果ファイルは送信から 24 時間後に削除されます**。必ずダウンロードしてご自身で保存してください。

## API キーの取得

1. [HoloCard](https://holocard.longsizhuo.com/?lang=ja) の右上の「ログイン」から、involutionhell アカウントでログインします（GitHub で登録できます）。
2. 右上のアバターからアカウント画面を開き、「外部 API」の「API キーを申請」を選択します。
3. キーは `hc_` で始まり、作成時に一度だけ表示されます。安全な場所に保存してください。紛失した場合は、新しく申請し、使わないキーを無効化してください。

有効な API キーは 1 アカウントにつき同時に 10 個までで、上限はすべてのキーで共通です。無効化は即時に反映されます。リクエストヘッダーに次のように指定します。

```http
Authorization: Bearer hc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

::: warning セキュリティ
API キーはアカウントの身元を表します。サーバー側でのみ使用し、クライアント側のコードや公開リポジトリには含めないでください。
:::

## エンドポイント

ベース URL は `https://holocard.longsizhuo.com` で、レスポンスは JSON 形式です。エラー時は次の形式で返されます。

```json
{ "error": "エラーの説明", "code": "エラーの種類" }
```

### `POST /v1/cards` 画像の送信

リクエスト本文は画像のバイナリそのもの（フォームではありません）で、`Content-Type` に画像の MIME タイプを指定します。対応形式は JPEG・PNG・WebP・AVIF・HEIC、サイズは 16 MB までです。EXIF 情報は削除され、撮影時の向きに合わせて補正されます。

成功すると `202 Accepted` が返されます。

```json
{ "id": "3f1c…", "status": "queued", "position": 1, "url": "https://holocard.longsizhuo.com/v1/cards/3f1c…" }
```

### `GET /v1/cards/{id}` ジョブの状態と結果

| 項目 | 説明 |
|---|---|
| `status` | ジョブの状態：`queued`（待機中）、`running`（処理中）、`done`（完了）、`failed`（失敗） |
| `position` | 待ち行列での順番（当該ジョブを含む） |
| `eta` | 残りの推定秒数。待機中・処理中のみ返されます |
| `expiresAt` | 結果ファイルが削除される日時 |
| `manifest` | カードのマニフェスト。完了時のみ返されます（[ファイル形式](/ja/format/)参照） |
| `files` | ファイル名からダウンロード URL への対応。完了時のみ返されます |
| `error.code` | 失敗の理由。失敗時のみ返されます：`nsfw_rejected`（裸体を検出）、`moderation_unavailable`（コンテンツ判定が一時的に利用不可）、`processing_failed`（処理エラー） |

### `GET /v1/cards/{id}/files/{name}` ファイルのダウンロード

ダウンロードできるのは `manifest.json`、各レイヤー画像 `layer-N.webp`（初期に作成されたカードは `.png`）、EXIF を削除した元画像です。ファイル名は `files` の記載に従ってください。

### `DELETE /v1/cards/{id}` カードの削除

カードのすべてのファイルを直ちに削除し、`{"deleted": true}` を返します。待機中のジョブも取り消されます。

### 注意事項

- カードは送信した API キーでのみ参照できます。他のキーのカード、削除済み・期限切れのカードへのリクエストは `404` になります。
- API で作成したカードはサイト上で公開されず、サイトでの共有や書き出しもできません。
- 納品前に裸体の判定を行い、完全な裸体の画像は拒否されます（`nsfw_rejected`）。
- サイトの利用者が優先され、API のジョブはその後に処理されます。

## カードマスク

完成した平面のカード画像を、互いに重ならない 6 枚のマスクに分割します。カードの領域ごとに異なるホイル効果を適用するためのものです（サイトの[カードマスク](https://holocard.longsizhuo.com/masks)と同じ処理）。認証、画像の条件、24 時間後に削除される点は上記と同じです。

```bash
curl -X POST https://holocard.longsizhuo.com/v1/masks \
  -H "Authorization: Bearer hc_xxx" \
  -H "Content-Type: image/png" --data-binary @card.png
# レスポンス：202 {"id":"9b2e…","status":"queued","url":"…"}

curl https://holocard.longsizhuo.com/v1/masks/9b2e… -H "Authorization: Bearer hc_xxx"
curl -O https://holocard.longsizhuo.com/v1/masks/9b2e…/files/character.png -H "Authorization: Bearer hc_xxx"
```

1 枚あたり通常 20〜40 秒かかります。

### `POST /v1/masks` カード画像の送信

リクエストボディは `POST /v1/cards` と同じです。長辺が 1400 ピクセルを超えるカード画像は縮小され、マスクは縮小後の画像と同じサイズになります。成功すると `202 Accepted` で `{ "id", "status": "queued", "url" }` を返します。

### `GET /v1/masks/{id}` 状態と結果

| フィールド | 説明 |
|---|---|
| `status` | `queued`、`running`、`done`、`failed` |
| `width`、`height` | マスクのサイズ（ピクセル）。完了時のみ |
| `window` | イラスト枠の位置 `{x, y, w, h}`（幅・高さで 0〜1 に正規化）。フルアートのカードでは `null` |
| `panel` | フルアートのカードの内側パネル。形式は `window` と同じ。イラスト枠のあるカードでは `null` |
| `lines` | 各行のテキストの位置と役割（`name`、`hp`、`body`、`footer`、`art`） |
| `effectsSource` | エフェクトのマスクの出どころ。`model` は検出モデル、`rules` は検出サービスが使えず規則で求めたもの |
| `files` | ファイル名からダウンロード URL への対応。完了時のみ |
| `error.code` | 失敗時は `processing_failed` |

サーバーが再起動すると処理中のジョブは失われ、その後の問い合わせは `404 masks_not_found` を返します。もう一度送信してください。

### `GET /v1/masks/{id}/files/{name}.png` マスクのダウンロード

| ファイル | 内容 |
|---|---|
| `card.png` | 縮小後のカード画像 |
| `border.png` | カードの縁 |
| `frame.png` | フレーム |
| `text.png` | テキスト |
| `character.png` | メインキャラクター |
| `effects.png` | エフェクト：イラスト中の光の帯・光輪・魔法陣・炎・稲妻・きらめきと、キャラクターの輪郭の内側の帯 |
| `background.png` | 背景 |
| `labels.png` | 領域の一覧。各ピクセルを所属する領域の色で塗ったもの |

マスクはグレースケールとアルファの PNG で、2 つのチャンネルは同じ値です。CSS の `mask-image` にそのまま使えます。6 枚のマスクは互いに重ならず、合わせるとカード全体を覆います。

マスクのジョブは 24 時間の利用上限に含まれません。すべてのキーを合わせて同時に処理できるマスクのジョブは 2 件までで、埋まっている場合は `503 queue_full` を返します。時間をおいて再試行してください。送信頻度の制限はカードと同じです。

## 利用上限とエラーコード

| ステータス | code | 説明 |
|---|---|---|
| 401 | — | API キーがない、無効、または無効化済み |
| 404 | `card_not_found` / `masks_not_found` / `file_not_found` | カードまたはマスクが存在しない、他のキーのもの、または削除済み・期限切れ |
| 413 | `too_large` | 画像が 16 MB を超えている |
| 415 | `unsupported_image` | 認識できない画像形式 |
| 429 | `quota_exceeded` | 24 時間の上限を超過：個人で申請したキーは 1 アカウントにつき、すべてのキーの合計で 20 枚（再申請してもリセットされません） |
| 429 | `too_many_in_flight` | 1 つのキーで同時にアップロード・待機・処理できるジョブは 3 件まで |
| 429 | `rate_limited` | 10 分間の送信回数が 30 回を超過 |
| 503 | `api_daily_limit` / `queue_full` / `busy` | API の当日の総量に達したか、待ち行列が混雑しています。時間をおいて再試行してください |
| 503 | `cardmask_unavailable` | サーバーにカードマスク用のモデルがありません |
| 507 | `disk_full` | サーバーの容量不足。時間をおいて再試行してください |

上限の引き上げをご希望の場合は、サイト管理者にお問い合わせください。
