/**
 * ISO-BMFF（MP4 / QuickTime MOV）盒子的最小读写工具
 *
 * 实况照片要往 MOV 里加两条定时元数据轨道，ffmpeg 和 sharp 都写不了，只能自己拼盒子。
 * 这里只实现用得到的那一小块：列出一层盒子、按路径找盒子、拼新盒子。
 * 不是通用解析器——输入永远是我们自己用 ffmpeg 刚编出来的文件，结构是确定的。
 */

export interface Box {
  type: string;
  /** 盒子在整个缓冲区里的起始位置（含头） */
  start: number;
  /** 盒子总长（含头） */
  size: number;
  /** 头长：普通 8 字节，64 位长度的 16 字节 */
  header: number;
}

/** 列出 [start, end) 范围内的一层盒子 */
export function listBoxes(buf: Buffer, start = 0, end = buf.length): Box[] {
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) throw new Error(`盒子 ${type} 的长度不对（@${at}）`);
    boxes.push({ type, start: at, size, header });
    at += size;
  }
  return boxes;
}

/** 盒子的内容（去掉头） */
export function body(buf: Buffer, box: Box): Buffer {
  return buf.subarray(box.start + box.header, box.start + box.size);
}

/** 按类型取一层里的第一个子盒子，找不到就抛错 */
export function child(buf: Buffer, parent: Box, type: string, skip = 0): Box {
  const found = listBoxes(buf, parent.start + parent.header + skip, parent.start + parent.size).find(
    (b) => b.type === type,
  );
  if (!found) throw new Error(`${parent.type} 里没有 ${type}`);
  return found;
}

/** 沿路径一层层往下找，比如 ['mdia', 'minf', 'stbl', 'stts'] */
export function path(buf: Buffer, parent: Box, types: string[]): Box {
  return types.reduce((box, type) => child(buf, box, type), parent);
}

/** 拼一个普通盒子 */
export function box(type: string, ...parts: Buffer[]): Buffer {
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

/** 拼一个 full box：内容前多一个字节的 version 和三个字节的 flags */
export function fullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...parts);
}

/** 一串无符号 32 位大端整数 */
export function u32(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => out.writeUInt32BE(v >>> 0, i * 4));
  return out;
}

/** 一串有符号 32 位大端整数 */
export function i32(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => out.writeInt32BE(v, i * 4));
  return out;
}

export function u16(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => out.writeUInt16BE(v & 0xffff, i * 2));
  return out;
}
