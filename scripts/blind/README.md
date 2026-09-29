# scripts/blind

双盲对比实验：同一批原图用两种配置各出一张卡，人在对比页上逐对选哪边更好，事后按答案还原成各配置的胜负。
第一次用在「抠图换 BiRefNet 512 版行不行」（2026-09）。

对比页的源码在仓库里（`lab/blind/index.html` + `src/lab/blind.ts`），用的是站里同一个卡片渲染器，
每次打包都重新构建，不会和线上渲染效果漂移。A、B 两张卡姿态完全同步：鼠标放在任意一张上两张一起转，手拿开时一起慢慢摆。

## 流程

```bash
# 1. 两种配置各跑一遍（先后跑，别同时：抠图峰值 7GB，两份叠加会挤爆内存）
pnpm build && pnpm build:server
node scripts/blind/run-variant.mjs --in 原图目录 --out /tmp/exp/lite --port 8781
HOLOCARD_MATTE_MODEL=onnx-community/BiRefNet_512x512-ONNX HOLOCARD_MATTE_SIZE=512 HOLOCARD_MATTE_DTYPE=q8 \
  node scripts/blind/run-variant.mjs --in 原图目录 --out /tmp/exp/512 --port 8782

# 2. 打包：只挑两版主体差别大的，混 6 对几乎一样的做核对
node scripts/blind/pack.mjs --variant lite=/tmp/exp/lite --variant 512=/tmp/exp/512 --out /tmp/exp/pack \
  --min-iou 0.95 --calibration 6 --focus "重点看主体边缘：白边、残影、被切掉的部分，倾斜时有没有错位"

# 3. 把 /tmp/exp/pack/page 发给评审（私有页面，或者 python3 -m http.server 在本机开），评完拿回「复制结果」那一行

# 4. 解码
node scripts/blind/score.mjs /tmp/exp/pack/key.json "1A 2= 3B 4X ..." --candidate 512
```

- `run-variant.mjs`：起一个临时分层服务（最低优先级），逐张提交，记下原图名 → 卡片 id（`ids.tsv`）和平均耗时（`timing.json`）。
  要比的配置用环境变量传，服务端认的见 `server/index.ts`（抠图模型是 `HOLOCARD_MATTE_*`）。
- `pack.mjs`：配对、按需筛选、随机分 A/B，生成对比页（`page/`）和答案（`key.json`）。页面数据里去掉了 manifest 的 generator（带模型名）。
- `score.mjs`：按答案统计各配置更好 / 差不多 / 都有问题，列出每一方明显更差的是哪几张，「核对」组单独算。

## 注意

- 原图、实验目录多半是用户的照片：放在仓库外面（`/tmp`、scratch），**评完删掉**，别提交。
- `key.json` 别和页面一起发出去，评审看到就不双盲了。
- 对比页一次只渲染两张卡；每一对的层图 base64 打在 `pairs/NN.json` 里，一对大约 0.3～1.2MB。
