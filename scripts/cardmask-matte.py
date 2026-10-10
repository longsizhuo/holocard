"""
卡面遮罩评测用：在有显卡的机器上，用几个候选抠图模型把 crops/ 下的图各抠一遍。

和 scripts/cardmask-eval.ts 配合：
  1. 本机  pnpm cardmask:eval --crops        把要抠的区域裁到 .cardmask/out/crops/
  2. 显卡机  python cardmask-matte.py <模型...>  crops/ → out/<模型>/<同名>.png（1024×1024 灰度）
  3. 本机  把 out/<模型>/ 放回 .cardmask/out/remote/<模型>/，再 pnpm cardmask:eval --masks --model <模型>

预处理和服务端（src/segmenter/matte.ts）一样：拉伸到 1024×1024、lanczos、ImageNet 均值方差。
模型都是 MIT 许可的 BiRefNet 系列，第一次用时从 Hugging Face 下载到 models/（国内可设 HF_ENDPOINT=https://hf-mirror.com）。

依赖：onnxruntime-gpu（或 onnxruntime）、numpy、Pillow。
用法：python cardmask-matte.py lite birefnet hrsod toonout matting
"""

import glob
import json
import os
import site
import sys
import time
import urllib.request


def enable_cuda_dlls():
    """
    Windows 上 pip 装的 CUDA 13 运行时（nvidia-*-cu13）把 DLL 放在 site-packages/nvidia/cu13/bin/x86_64/，
    onnxruntime 还按老布局 nvidia/<库>/bin/ 找，找不到就静默退回 CPU。要在导入 onnxruntime 之前补上：
    add_dll_directory 给 Python 自己的加载用，PATH 给 onnxruntime 加载 CUDA provider 用（它不认前者）
    """
    if not hasattr(os, "add_dll_directory"):
        return
    added = []
    for root in set(site.getsitepackages() + [site.getusersitepackages()]):
        base = os.path.join(root, "nvidia")
        for path in glob.glob(os.path.join(base, "**", "bin"), recursive=True) + glob.glob(
            os.path.join(base, "**", "bin", "x86_64"), recursive=True
        ):
            if os.path.isdir(path):
                os.add_dll_directory(path)
                added.append(path)
    if added:
        os.environ["PATH"] = os.pathsep.join(added) + os.pathsep + os.environ.get("PATH", "")


enable_cuda_dlls()

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from PIL import Image  # noqa: E402

HF = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
# 名字 → (下载地址里 Hugging Face 之后的部分, 输入名, 输出是不是 logits)
MODELS = {
    "lite": ("onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx", "input_image", True),
    "birefnet": ("onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx", "input_image", True),
    "hrsod": ("onnx-community/BiRefNet-HRSOD_DHU-ONNX/resolve/main/onnx/model.onnx", "input_image", True),
    "toonout": ("sprited/birefnet-toonout-onnx/resolve/main/birefnet-toonout.onnx", "image", False),
    "matting": ("emrikol/birefnet-matting-onnx/resolve/main/birefnet-matting.onnx", "input_image", True),
}
SIZE = 1024
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def model_file(name):
    path = os.path.join("models", name + ".onnx")
    if not os.path.exists(path):
        os.makedirs("models", exist_ok=True)
        url = HF + "/" + MODELS[name][0]
        print("下载", name, url, flush=True)
        urllib.request.urlretrieve(url, path + ".part")
        os.replace(path + ".part", path)
    return path


def main():
    names = sys.argv[1:] or list(MODELS)
    crops = sorted(f for f in os.listdir("crops") if f.endswith(".png"))
    timings = {}
    for name in names:
        _, input_name, logits = MODELS[name]
        session = ort.InferenceSession(model_file(name), providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
        print(name, "用", session.get_providers()[0], flush=True)
        os.makedirs(os.path.join("out", name), exist_ok=True)
        spent = []
        for i, crop in enumerate(crops):
            image = Image.open(os.path.join("crops", crop)).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
            x = (np.asarray(image, dtype=np.float32) / 255 - MEAN) / STD
            x = x.transpose(2, 0, 1)[None]
            started = time.perf_counter()
            y = session.run(None, {input_name: x})[0][0, 0]
            # 第一张含 CUDA 初始化，不计时
            if i > 0:
                spent.append(time.perf_counter() - started)
            if logits:
                y = 1 / (1 + np.exp(-y))
            Image.fromarray(np.clip(y * 255 + 0.5, 0, 255).astype(np.uint8)).save(os.path.join("out", name, crop))
        timings[name] = round(1000 * sum(spent) / max(1, len(spent)))
        print(name, "完成", len(crops), "张，每张", timings[name], "毫秒", flush=True)
        del session
    with open(os.path.join("out", "timings.json"), "w") as f:
        json.dump(timings, f)


if __name__ == "__main__":
    main()
