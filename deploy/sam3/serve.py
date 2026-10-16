"""
SAM3-Card 特效识别服务。分层服务（server/pipeline/effects.ts）把图发过来，这里回每类特效的遮罩。

  POST /effects  请求体是一张图（JPEG/PNG），回
                 {"width": w, "height": h, "effects": [{"type": "fire", "score": 0.83, "mask": "<PNG base64>"}]}
                 每类一张遮罩（同类的几个实例并成一张），和收到的图一样大；分数不到 SCORE 的不回
  GET  /health   {"ok": true, "device": "cuda", "loaded": false}

同一份代码跑两处，分层服务按顺序问，前一个不通再问下一个：
  显卡机（WSL，--device cuda）  bf16 autocast，RTX 5080 上一张图约 0.5 秒
  Oracle（--device cpu）        fp32 兜底，一张图约一分半；模型常驻要 5GB 内存，闲 IDLE 秒就卸掉，下次再加载（约一分钟）

权重：官方 sam3.pt 建模型，再盖上微调存档（存档里没有冻结的主干）。
用法：python serve.py --base sam3.pt --ckpt sam3card-v11soup.pt --device cpu --port 8796
"""

import argparse
import base64
import io
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from PIL import Image

# 模型认的短语 → manifest 里的特效类型（src/format/types.ts 的 EffectKind）
PROMPTS = {
    "light energy": "energy",
    "glow": "glow",
    "magic circle": "circle",
    "fire": "fire",
    "lightning": "lightning",
    "sparkles": "sparkles",
}
# 阈值 0.5：v11 合成在三套测试集上 Opus 复核精度 92%（背景纹样算可接受）
SCORE = 0.5
MAX_BODY = 16 * 1024 * 1024

args = argparse.ArgumentParser()
args.add_argument("--base", required=True)
args.add_argument("--ckpt", required=True)
args.add_argument("--device", default="cuda")
args.add_argument("--host", default="127.0.0.1")
args.add_argument("--port", type=int, default=8796)
args.add_argument("--idle", type=float, default=900, help="闲这么多秒卸掉模型，0 表示常驻")
opt = args.parse_args()

lock = threading.Lock()
proc = None
last_used = time.time()


def load():
    from sam3.model.sam3_image_processor import Sam3Processor
    from sam3.model_builder import build_sam3_image_model

    if opt.device == "cpu":
        import sam3.model.vitdet as vitdet

        # 主干 MLP 的融合算子把第一层固定转成 bf16，显卡上靠 autocast 接住；CPU 上换成普通的「线性层 + 激活」全程 fp32
        vitdet.addmm_act = lambda act, linear, x: act()(linear(x))
    t0 = time.time()
    model = build_sam3_image_model(checkpoint_path=opt.base, load_from_HF=False, eval_mode=True, device=opt.device)
    state = torch.load(opt.ckpt, map_location="cpu", weights_only=True)
    missing, unexpected = model.load_state_dict(state.get("model", state), strict=False)
    assert not unexpected and all(k.startswith("backbone.") for k in missing), "存档键名和模型对不上"
    model = (model.float() if opt.device == "cpu" else model.to(opt.device)).eval()
    print(f"模型加载 {time.time() - t0:.0f}s", flush=True)
    return Sam3Processor(model, device=opt.device, confidence_threshold=SCORE)


def detect(image):
    global proc, last_used
    with lock:
        if proc is None:
            proc = load()
        t0 = time.time()
        found = {}
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=opt.device == "cuda"):
            state = proc.set_image(image)
            for phrase, kind in PROMPTS.items():
                out = proc.set_text_prompt(phrase, state)
                if len(out["scores"]) == 0:
                    continue
                masks = (out["masks_logits"][:, 0] > 0.5).cpu().numpy()
                found[kind] = (float(out["scores"].float().max()), masks.any(axis=0))
        last_used = time.time()
        print(f"{image.width}x{image.height} {last_used - t0:.1f}s {sorted(found)}", flush=True)
    effects = []
    for kind, (score, mask) in found.items():
        buf = io.BytesIO()
        Image.fromarray(mask.astype(np.uint8) * 255).save(buf, "PNG", optimize=True)
        effects.append({"type": kind, "score": round(score, 3), "mask": base64.b64encode(buf.getvalue()).decode()})
    return {"width": image.width, "height": image.height, "effects": effects}


def unload_when_idle():
    global proc
    while True:
        time.sleep(30)
        with lock:
            if proc is not None and time.time() - last_used > opt.idle:
                proc = None
                if opt.device == "cuda":
                    torch.cuda.empty_cache()
                print("闲置，卸掉模型", flush=True)


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not found"})
        self.reply(200, {"ok": True, "device": opt.device, "loaded": proc is not None})

    def do_POST(self):
        if self.path != "/effects":
            return self.reply(404, {"error": "not found"})
        size = int(self.headers.get("content-length") or 0)
        if not 0 < size <= MAX_BODY:
            return self.reply(413, {"error": "body size"})
        try:
            image = Image.open(io.BytesIO(self.rfile.read(size))).convert("RGB")
        except Exception as error:
            return self.reply(400, {"error": f"bad image: {error}"})
        self.reply(200, detect(image))

    def log_message(self, *_):
        pass


if opt.idle > 0:
    threading.Thread(target=unload_when_idle, daemon=True).start()
print(f"listening {opt.host}:{opt.port} device={opt.device}", flush=True)
ThreadingHTTPServer((opt.host, opt.port), Handler).serve_forever()
