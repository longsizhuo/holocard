/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 模型权重来源主机，末尾要带斜杠。
   * 留空则走 Hugging Face 官方 CDN（默认，零成本）。
   * 中国大陆部署可填 https://hf-mirror.com/
   */
  readonly VITE_MODEL_HOST?: string;

  /** 权重路径模板，配合自建镜像使用。默认 {model}/resolve/{revision}/ */
  readonly VITE_MODEL_PATH_TEMPLATE?: string;

  /**
   * 强制指定权重精度，如 q8。
   * 留空则按设备自动选：WebGPU 用 fp16（约 50MB），WASM 用 q8（约 25MB）。
   */
  readonly VITE_MODEL_DTYPE?: 'fp32' | 'fp16' | 'q8' | 'q4';

  /**
   * 自建 umami 的站点 id。留空则完全不加载统计脚本，
   * 自托管这个项目的人不会被动连到我们的统计服务。
   */
  readonly VITE_UMAMI_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
