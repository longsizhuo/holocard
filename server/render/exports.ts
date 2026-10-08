import { join } from 'node:path';
import { OUT_DIR, PORT } from '../config';
import { exportFiles, exportReady, runExport, type ExportFormat } from './export';

/*
 * 导出动图的队列，和分层队列分开：一次只做一张。
 * 状态不进数据库——导出好的文件就在卡片目录里，有没有、新不新看文件本身（exportReady），
 * 服务重启丢的只是排队中的请求，前端轮询拿到 none 会提示重试。
 */
export interface ExportJob {
  id: string;
  format: ExportFormat;
}
export const exportQueue: ExportJob[] = [];
export let exporting: ExportJob | null = null;
/** 失败原因留一会儿，给轮询的人看；过了这段时间再点就是重新生成 */
export const exportErrors = new Map<string, { error: string; at: number }>();
const EXPORT_ERROR_TTL_MS = 10 * 60 * 1000;

export const exportKey = (job: ExportJob): string => `${job.id}:${job.format}`;

export function pumpExports(): void {
  if (exporting) return;
  const job = exportQueue.shift();
  if (!job) return;
  exporting = job;
  const started = Date.now();
  void runExport(`http://127.0.0.1:${PORT}`, job.id, join(OUT_DIR, job.id), job.format)
    .then(() => {
      exportErrors.delete(exportKey(job));
      console.log(`[export] ${job.id} ${job.format} 用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      exportErrors.set(exportKey(job), { error: message, at: Date.now() });
      console.error(`[export] ${job.id} ${job.format} 失败:`, message);
    })
    .finally(() => {
      exporting = null;
      pumpExports();
    });
}

type ExportStatus =
  | { state: 'none' }
  | { state: 'queued'; position: number }
  | { state: 'running' }
  | { state: 'error'; error: string }
  | { state: 'done'; files: Array<{ url: string; name: string; type: string }> };

/** 某张卡某种格式的导出现在到哪一步了 */
export async function exportStatus(job: ExportJob): Promise<ExportStatus> {
  const version = await exportReady(join(OUT_DIR, job.id), job.format, job.id);
  if (version !== null) {
    return {
      state: 'done',
      // 地址带文件时间当版本号：卡片参数改过、重新生成之后，CDN 上的旧文件不会被拿到
      files: exportFiles(job.format, job.id).map((f) => ({
        url: `/api/layers/${job.id}/${f.file}?v=${version}`,
        name: f.download,
        type: f.type,
      })),
    };
  }
  if (exporting && exportKey(exporting) === exportKey(job)) return { state: 'running' };
  const index = exportQueue.findIndex((j) => exportKey(j) === exportKey(job));
  if (index >= 0) return { state: 'queued', position: index + 1 };
  const failed = exportErrors.get(exportKey(job));
  if (failed && Date.now() - failed.at < EXPORT_ERROR_TTL_MS) return { state: 'error', error: failed.error };
  return { state: 'none' };
}
