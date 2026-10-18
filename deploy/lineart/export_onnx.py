"""把 Anime2Sketch（MIT，https://github.com/Mukosame/Anime2Sketch）导出成 ONNX，给线稿提取用（server/pipeline/sketch.ts）。

在 Anime2Sketch 仓库根目录、权重放进 weights/ 之后运行：
    python3 export_onnx.py --model improved --output anime2sketch-improved.onnx

只用它的 model.py 和 torch，不要装它的 requirements.txt（2026-09-08 那次提交里有一个冒名的 requests 依赖，见 deploy/README.md「线稿提取」）。
输入 1×3×H×W、[-1, 1] 的 RGB（H、W 须是 256 的倍数），输出 1×1×H×W、[-1, 1] 的白底线稿
"""

import argparse

import torch

from model import create_model

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Export Anime2Sketch to ONNX.')
    parser.add_argument('--model', default='improved', type=str, help="['default', 'improved']")
    parser.add_argument('--output', '-o', default='anime2sketch-improved.onnx', type=str)
    opt = parser.parse_args()

    net = create_model(opt.model).eval()
    torch.onnx.export(
        net, torch.randn(1, 3, 512, 512), opt.output,
        input_names=['image'], output_names=['sketch'], opset_version=17,
        dynamic_axes={'image': {2: 'height', 3: 'width'}, 'sketch': {2: 'height', 3: 'width'}},
        dynamo=False,
    )
    print(f'saved {opt.output}')
