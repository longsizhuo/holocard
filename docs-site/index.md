# HoloCard API

用 HTTP 接口把一张照片做成会动的分层闪卡，再用我们的播放器放进你自己的网页。

## 快速开始

整个流程四步：拿 key → 提交图片 → 等它做完、下载文件 → 用播放器放进网页。

```bash
# 1. 提交：把 photo.jpg 换成你电脑上图片的路径（PNG 把 Content-Type 改成 image/png）
curl -X POST https://holocard.longsizhuo.com/v1/cards \
  -H "Authorization: Bearer hc_你的key" \
  -H "Content-Type: image/jpeg" --data-binary @photo.jpg
# → 202 {"id":"3f1c…","status":"queued","position":1,"url":"…"}

# 2. 查进度：每隔几秒查一次，status 变成 done 时带上清单和每个文件的下载地址
curl https://holocard.longsizhuo.com/v1/cards/3f1c… -H "Authorization: Bearer hc_你的key"

# 3. 下载文件（清单和每一层），同样要带 key
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/manifest.json -H "Authorization: Bearer hc_你的key"
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/layer-0.webp -H "Authorization: Bearer hc_你的key"
```

做一张通常要半分钟到一分钟，排队的话更久。**文件在提交 24 小时后删除**，做完请尽快下载到你自己的服务器上。

## 获取 key

1. 在 [HoloCard](https://holocard.longsizhuo.com/) 右上角点「登录」，用 involutionhell 账号登录（没有账号的话可以用 GitHub 注册）。
2. 点右上角的头像打开个人中心，在「对外接口」里点「申请 API key」。
3. key 形如 `hc_` 加 32 个字符，**只显示这一次**，复制下来存好。弄丢了就吊销再申请一个。

每个账号同时只能有一个能用的 key，可以随时吊销，吊销立即生效。请求时放在请求头里：

```http
Authorization: Bearer hc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

::: warning
key 等于你的身份：只在你自己的服务器上用，不要写进前端代码，也不要提交到公开仓库。
:::

## 接口

地址都在 `https://holocard.longsizhuo.com` 下，返回 JSON。出错时返回 `{"error": "说明", "code": "错误类型"}`。

### `POST /v1/cards` 提交图片

请求体就是图片本身（不是表单），`Content-Type` 写图片类型。支持 JPEG、PNG、WebP、AVIF、HEIC，16MB 以内。会自动去掉 EXIF、按拍摄方向摆正。

返回 `202`：

```json
{ "id": "3f1c…", "status": "queued", "position": 1, "url": "https://holocard.longsizhuo.com/v1/cards/3f1c…" }
```

### `GET /v1/cards/{id}` 查进度和结果

| 字段 | 说明 |
|---|---|
| `status` | `queued` 排队中、`running` 处理中、`done` 做完、`failed` 失败 |
| `position` | 排队时前面还有几张（含自己） |
| `eta` | 预计还要多少秒（排队、处理中才有） |
| `expiresAt` | 文件删除的时间 |
| `manifest` | 做完时才有：卡片清单，见[文件格式](#文件格式) |
| `files` | 做完时才有：文件名 → 下载地址 |
| `error.code` | 失败时才有：`nsfw_rejected` 裸露照片被拒、`moderation_unavailable` 识别暂时不可用、`processing_failed` 处理出错 |

### `GET /v1/cards/{id}/files/{name}` 下载文件

能下载 `manifest.json`、各层图片 `layer-N.webp`（少数老卡是 `.png`）和去掉 EXIF 的原图，名字以 `files` 里给的为准。

### `DELETE /v1/cards/{id}` 提前删除

文件马上删掉，返回 `{"deleted": true}`，还在排队的也会撤下来。

### 说明

- 每张卡只有提交它的 key 能查、能下载、能删；别人的卡、删掉的、过期的一律返回 `404`。
- 接口做的卡不公开、不会出现在网站上，也不能在网站上分享或导出动图。
- 裸露识别做完才交付，完全裸露的照片会被拒（`nsfw_rejected`），泳装、低胸没问题。
- 网站上的用户优先，接口的任务排在后面。

## 额度和错误

| 状态码 | code | 意思 |
|---|---|---|
| 401 | | 没带 key、key 不对或已吊销 |
| 404 | `card_not_found` / `file_not_found` | 卡不存在、不是你的、已删除或过期 |
| 413 | `too_large` | 图片超过 16MB |
| 415 | `unsupported_image` | 不是能识别的图片 |
| 429 | `quota_exceeded` | 到了 24 小时额度：自己申请的 key 每个账号 20 张（吊销重新申请不清零） |
| 429 | `too_many_in_flight` | 同一个 key 同时最多 3 张在上传、排队或处理 |
| 429 | `rate_limited` | 10 分钟内提交尝试超过 30 次 |
| 503 | `api_daily_limit` / `queue_full` / `busy` | 今天接口的总量用完了，或者正在排队的太多，稍后再试 |
| 507 | `disk_full` | 服务器空间不足，稍后再试 |

需要更高的额度，请联系站长。

## 放进网页

下载下来的文件需要我们的播放器才能动起来。播放器是 npm 包 [`@holocard/player`](https://www.npmjs.com/package/@holocard/player)，一个标准的自定义元素，纯 HTML、React、Vue 里都能直接用。

1. 把 `manifest.json` 和各层图片放进你服务器上的同一个目录，文件名不要改，比如 `/cards/my-card/`。
2. 在网页里加上：

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@holocard/player@0.1/dist/holocard.js"></script>
<holo-card src="/cards/my-card"></holo-card>
```

用构建工具的项目也可以 `npm install @holocard/player`，然后 `import '@holocard/player'`。

| | 说明 |
|---|---|
| `src` | 卡片目录，或者直接写到 `manifest.json`。放在别的域名下时，那边要允许跨域（CORS） |
| `gyro` | 默认跟着手机倾斜，写 `gyro="off"` 关掉。iOS 第一次点卡片时会弹授权 |
| 大小 | 给 `holo-card` 设宽度（默认 320px），高度按卡片比例自动算 |
| 事件 | `load` 卡片显示好了；`error` 加载失败，原因在 `event.detail.error` |

样式装在 Shadow DOM 里，你页面的 CSS 不会影响卡片，卡片也不会往你的页面加样式。正式上线建议锁定具体版本（比如 `@0.1.0`）。

## 文件格式

一张卡是一个目录：`manifest.json` 加每层一张图。层按从远到近排列，每层是和原图同样大小、带透明通道的图片。清单大致是这样：

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

箔面、炫光、视差都写在清单里，播放器照着显示，一般不用手改。
