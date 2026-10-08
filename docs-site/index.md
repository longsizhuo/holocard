# HoloCard API

HoloCard API 将照片处理为分层全息卡片，返回卡片清单（manifest）与各层图像；配合 [`@holocard/player`](#在网页中展示) 可在任意网页中渲染。

## 快速开始

调用流程分为四步：

1. 获取 API Key；
2. 提交图片；
3. 轮询任务状态，完成后下载结果文件；
4. 使用播放器在网页中展示。

```bash
# 1. 提交图片（将 photo.jpg 替换为本地图片路径；PNG 图片请将 Content-Type 设为 image/png）
curl -X POST https://holocard.longsizhuo.com/v1/cards \
  -H "Authorization: Bearer hc_xxx" \
  -H "Content-Type: image/jpeg" --data-binary @photo.jpg
# 响应：202 {"id":"3f1c…","status":"queued","position":1,"url":"…"}

# 2. 查询任务状态（建议间隔数秒轮询；status 为 done 时返回清单及文件下载地址）
curl https://holocard.longsizhuo.com/v1/cards/3f1c… -H "Authorization: Bearer hc_xxx"

# 3. 下载结果文件（清单及各层图像，同样需要携带 API Key）
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/manifest.json -H "Authorization: Bearer hc_xxx"
curl -O https://holocard.longsizhuo.com/v1/cards/3f1c…/files/layer-0.webp -H "Authorization: Bearer hc_xxx"
```

单张图片的处理时间通常为 30–60 秒，排队时会相应延长。**结果文件将在提交 24 小时后删除**，请及时下载并自行保存。

## 获取 API Key

1. 访问 [HoloCard](https://holocard.longsizhuo.com/)，点击右上角「登录」，使用 involutionhell 账号登录（可通过 GitHub 注册）。
2. 点击右上角头像进入个人中心，在「对外接口」中点击「申请 API key」。
3. API Key 以 `hc_` 开头，仅在创建时显示一次，请妥善保存；如遗失，请吊销后重新申请。

每个账号同一时间仅可持有一个有效的 API Key，吊销后立即失效。请求时在请求头中携带：

```http
Authorization: Bearer hc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

::: warning 安全提示
API Key 代表账号身份，请仅在服务端使用，切勿写入前端代码或提交至公开代码仓库。
:::

## 接口

基础地址为 `https://holocard.longsizhuo.com`，响应格式为 JSON。请求失败时返回：

```json
{ "error": "错误说明", "code": "错误类型" }
```

### `POST /v1/cards` 提交图片

请求体为图片的二进制内容（非表单），`Content-Type` 为图片的 MIME 类型。支持 JPEG、PNG、WebP、AVIF、HEIC，大小不超过 16 MB。服务端会移除 EXIF 信息，并按拍摄方向校正图片。

成功时返回 `202 Accepted`：

```json
{ "id": "3f1c…", "status": "queued", "position": 1, "url": "https://holocard.longsizhuo.com/v1/cards/3f1c…" }
```

### `GET /v1/cards/{id}` 查询任务状态与结果

| 字段 | 说明 |
|---|---|
| `status` | 任务状态：`queued`（排队中）、`running`（处理中）、`done`（已完成）、`failed`（失败） |
| `position` | 排队位置（含当前任务） |
| `eta` | 预计剩余时间（秒），仅在排队或处理中返回 |
| `expiresAt` | 结果文件的删除时间 |
| `manifest` | 卡片清单，仅在已完成时返回，格式见[文件格式](#文件格式) |
| `files` | 文件名到下载地址的映射，仅在已完成时返回 |
| `error.code` | 失败原因，仅在失败时返回：`nsfw_rejected`（图片含裸露内容）、`moderation_unavailable`（内容检测暂不可用）、`processing_failed`（处理失败） |

### `GET /v1/cards/{id}/files/{name}` 下载文件

可下载的文件包括 `manifest.json`、各层图像 `layer-N.webp`（早期生成的卡片为 `.png`）以及去除 EXIF 的原图，文件名以响应中的 `files` 字段为准。

### `DELETE /v1/cards/{id}` 删除卡片

立即删除该卡片的全部文件，返回 `{"deleted": true}`；排队中的任务将一并取消。

### 注意事项

- 卡片仅对提交它的 API Key 可见；访问其他 Key 的卡片、已删除或已过期的卡片均返回 `404`。
- 通过 API 生成的卡片不会在网站上公开展示，也无法在网站上分享或导出。
- 结果交付前会进行裸露内容检测，完全裸露的图片将被拒绝（`nsfw_rejected`）。
- 网站用户的任务优先处理，API 任务在其后排队。

## 配额与错误码

| 状态码 | code | 说明 |
|---|---|---|
| 401 | — | 未提供 API Key，或 Key 无效、已吊销 |
| 404 | `card_not_found` / `file_not_found` | 卡片不存在、不属于当前 Key，或已删除、已过期 |
| 413 | `too_large` | 图片超过 16 MB |
| 415 | `unsupported_image` | 无法识别的图片格式 |
| 429 | `quota_exceeded` | 超出 24 小时配额：个人申请的 Key 每个账号 20 张（吊销后重新申请不重置） |
| 429 | `too_many_in_flight` | 单个 Key 同时处于上传、排队或处理中的任务不超过 3 个 |
| 429 | `rate_limited` | 10 分钟内提交次数超过 30 次 |
| 503 | `api_daily_limit` / `queue_full` / `busy` | API 当日总量已用尽，或当前排队任务过多，请稍后重试 |
| 507 | `disk_full` | 服务器存储空间不足，请稍后重试 |

如需更高配额，请联系站长。

## 在网页中展示

结果文件需通过播放器渲染。播放器以 npm 包 [`@holocard/player`](https://www.npmjs.com/package/@holocard/player) 发布，是标准的 Web Component，可直接用于原生 HTML、React、Vue 等环境。

1. 将 `manifest.json` 与各层图像存放在服务器的同一目录下，保持文件名不变，例如 `/cards/my-card/`。
2. 在页面中引入播放器并添加元素：

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@holocard/player@0.1/dist/holocard.js"></script>
<holo-card src="/cards/my-card"></holo-card>
```

使用构建工具的项目也可以通过 `npm install @holocard/player` 安装，并在代码中 `import '@holocard/player'`。

| 属性 / 事件 | 说明 |
|---|---|
| `src` | 卡片目录或 `manifest.json` 的地址。跨域访问时，资源服务器需允许 CORS |
| `gyro` | 默认随设备倾斜；设置 `gyro="off"` 可关闭。iOS 设备在首次点击卡片时请求权限 |
| 尺寸 | 通过 CSS 设置元素宽度（默认 320px），高度按卡片比例自适应 |
| `load` 事件 | 卡片加载完成 |
| `error` 事件 | 加载失败，原因见 `event.detail.error` |

播放器的样式封装在 Shadow DOM 中，与宿主页面互不影响。生产环境建议固定版本号（如 `@0.1.0`）。

## 文件格式

一张卡片对应一个目录，包含 `manifest.json` 与各层图像。图层按由远及近的顺序排列，每层均为与原图尺寸相同的透明图像。`manifest.json` 示例：

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

箔面、炫光、视差等效果参数均保存在清单中，播放器据此渲染，通常无需手动修改。
