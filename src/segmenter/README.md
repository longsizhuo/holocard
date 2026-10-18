# segmenter

分层流水线：深度估计、抠主体、切层、边缘精修。服务端在工作线程里跑，浏览器端只在没有服务端时回退使用。

## 与其他目录的关系

- 图片编解码经 image-io.ts 注入（服务端用 sharp）；被 server/pipeline/segment-worker.ts 和 web/site/upload.ts 调用

各文件的职责见 docs-site/develop/architecture.md 的对应小节。
