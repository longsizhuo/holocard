# pipeline

分层任务的队列与调度、常驻工作线程、sharp 图片处理、裸露识别、剩余时间估计、卡面遮罩任务。

## 与其他目录的关系

- 工作线程跑 src/segmenter；被 routes/ 调用

各文件的职责见 docs-site/develop/architecture.md 的对应小节。
