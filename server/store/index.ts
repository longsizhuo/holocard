import { DB_PATH } from '../config';
import { CardDb } from './db';

/**
 * 所有卡片状态的唯一来源。以前是内存里的任务表 + 每个目录一份 meta.json，
 * 服务一重启进度就没了，也没法回答「最近传了什么、失败了几个」。
 */
export const db = new CardDb(DB_PATH);
