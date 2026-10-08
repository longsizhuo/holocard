# 播放器

`@holocard/player` 是用于在网页中渲染 HoloCard 卡片的 Web Component（`<holo-card>`），以 npm 包形式发布，不依赖任何框架，可直接用于原生 HTML、React、Vue 等环境。卡片的箔面、炫光与视差均按清单（[文件格式](/format/)）中的参数渲染，效果与 HoloCard 网站一致。

## 安装

通过 CDN 引入：

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@holocard/player@0.1/dist/holocard.js"></script>
```

或通过 npm 安装后在代码中引入：

```bash
npm install @holocard/player
```

```js
import '@holocard/player'; // 注册 <holo-card> 元素
```

生产环境建议固定具体版本号（如 `@0.1.0`），并为 `<script>` 标签添加 [子资源完整性](https://www.jsdelivr.com/using-sri-with-dynamic-files)（SRI）校验。

## 使用

1. 将卡片的 `manifest.json` 与各层图像存放在服务器的同一目录下，保持文件名不变，例如 `/cards/my-card/`。通过 [API](/api/) 生成的卡片，可在任务完成后下载这些文件。
2. 在页面中添加元素：

```html
<holo-card src="/cards/my-card"></holo-card>
```

`src` 可以指向卡片目录，也可以直接指向 `manifest.json`。资源位于其他域名时，资源服务器需允许跨域访问（CORS）。

## 属性

| 属性 | 默认值 | 说明 |
|---|---|---|
| `src` | — | 卡片目录或 `manifest.json` 的地址。修改后会重新加载 |
| `gyro` | 开启 | 随设备倾斜转动卡片；设置为 `off` 时关闭。iOS 设备在用户首次点击卡片时请求陀螺仪权限 |

## 事件

| 事件 | 说明 |
|---|---|
| `load` | 图层加载完成，卡片已显示 |
| `error` | 加载失败，失败原因位于 `event.detail.error` |

```js
document.querySelector('holo-card').addEventListener('error', (event) => {
  console.error(event.detail.error);
});
```

## 尺寸与样式

通过 CSS 设置元素宽度（默认 `320px`），高度按卡片的宽高比自动计算：

```css
holo-card { width: 100%; max-width: 360px; }
```

播放器的样式封装在 Shadow DOM 中：宿主页面的 CSS 不会影响卡片内部，播放器也不会向宿主页面添加全局样式。

## 许可

箔面效果移植自 [pokemon-cards-css](https://github.com/simeydotme/pokemon-cards-css)（Simon Goellner），其许可证文本随 npm 包一同分发（`LICENSE`）。
