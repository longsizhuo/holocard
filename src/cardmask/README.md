# cardmask

卡面遮罩的识别规则：找版式、拼出边框、文字、主角、特效、背景六张互不重叠的遮罩。

## 与其他目录的关系

- 被 server/pipeline/cardmask.ts 调用；和主流程（src/segmenter）互不引用

各文件的职责见 docs-site/develop/architecture.md 的对应小节。
