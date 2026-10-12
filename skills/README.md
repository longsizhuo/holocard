# skills

给编程智能体（Claude Code、Comfy Agent 等支持 SKILL.md 的工具）用的 skill，教它们调用 HoloCard 的对外接口。

- `holocard-card-masks/`：把平面卡图拆成边框、文字、主角、特效、背景等遮罩（`/v1/masks`）

skill 面向外部用户，正文用英文写；接口细节以 [docs-site/api/index.md](../docs-site/api/index.md) 为准，接口改了这里同步改。
