/**
 * 苹果实况照片（Live Photo）
 *
 * 一张实况照片是两个文件：一张静态图 + 一段 MOV，靠同一个 UUID 配对。
 *   静态图：EXIF 里的 Apple MakerNote，17 号标签（ContentIdentifier）写 UUID
 *   MOV：  moov/meta 里 com.apple.quicktime.content.identifier 写同一个 UUID，
 *          再加一条定时元数据轨道，用 still-image-time 标出静态图是视频里的哪一刻
 * 两边对上，iOS「照片」就把它们合成一张实况照片。
 *
 * 这两样没有现成的库能写，只能自己拼字节（都实测过）：
 *   - ffmpeg 复制这种轨道会报「Unknown hdlr_type for mebx, writing dummy values」，写出来是空壳
 *   - mp4box.js 不认识 mebx / keys 这几种盒子
 *   - exiftool 明说写不了定时元数据；Apple MakerNote 它只能改已有的，不能新建
 *   - goLive 用的是 GPAC 的 MP4Box 命令行，得往服务器上装系统包
 * 写出来的结构对照真机样本逐项核对过，exiftool 也能正确读回 ContentIdentifier。
 *
 * 另外还有一条 live-photo-info 轨道和 moov/meta 里 live-photo.* 几个键：
 * 相册里配对用不上，但设成锁屏壁纸时能不能「动」，苹果有一套没公开的判据。
 * 这几样的结构和字节照搬自 goLive（https://github.com/code-path/goLive，Apache-2.0）
 * 从真机实况照片里取出来的那份——它的产物能当动态壁纸。
 */

import { body, box, child, fullBox, i32, listBoxes, path, u16, u32, type Box } from './bmff';

// ---------- 从 goLive 的真机样本里取出来的字节 ----------

/**
 * live-photo-info 轨道的样本描述（mebx）。
 * 键名 com.apple.quicktime.live-photo-info，外加一段 setu（采集端版本信息的 bplist）。
 * 原样保留，没有逐字段解读的必要——苹果也没公开它的含义。
 */
const INFO_ENTRY = Buffer.from(
  '0000021b6d65627800000000000000010000020b6b65797300000203000000010000002f6b6579646d647461' +
    '636f6d2e6170706c652e717569636b74696d652e6c6976652d70686f746f2d696e666f00000043647479700000' +
    '0001636f6d2e6170706c652e717569636b74696d652e636f6d2e6170706c652e717569636b74696d652e6c6976' +
    '652d70686f746f2d696e666f0000017173657475000001596366677662706c6973743030d301020304050c5f10' +
    '214c69766550686f746f4d6574616461746153657475704461746156657273696f6e5d53797374656d56657273' +
    '696f6e5f10114672616d65776f726b56657273696f6e731001d3060708090a0b5f101350726f64756374427569' +
    '6c6456657273696f6e5b50726f647563744e616d655e50726f6475637456657273696f6e583231413532373768' +
    '596950686f6e65204f535431372e30d40d0e0f10111213145a436f72654d6f74696f6e5d434d43617074757265' +
    '436f72655e483130495350536572766963657359436f72654d6564696158323836382e302e32573434362e352e' +
    '335432302e325e333034352e36392e322e31312e340008000f0033004100550057005e00740080008f009800a2' +
    '00a700b000bb00c900d800e200eb00f300f8000000000000020100000000000000150000000000000000000000' +
    '00000001070000001064696d7300000780000005a0000000186374707300000010647479700000000000000000',
  'hex',
);

/** live-photo-info 的样本：每帧一个，真机样本里 60 帧全都一样，这里也每帧都放这一份 */
const INFO_SAMPLE = Buffer.from(
  '000000900000000103000000bdc36d3ce3b5eb6d800000007b80ad425a2d64410a08cb3e7feea6bd79e9f63f0000' +
    '80400400ff00000000000000000000000000000000000000000007000000525e873ee66e52bf1b2a6ac4d37862bf' +
    '761ed23dde3f8ec313f52f39b2f04439ff309dbf1a17f1ed1b070000206796ed1b0700000000000000000000000000' +
    '0000000000',
  'hex',
);

/**
 * 静态图时刻轨道的样本描述（mebx），两个键：
 *   1  com.apple.quicktime.still-image-time                  int8，恒为 -1
 *   2  com.apple.quicktime.live-photo-still-image-transform  3×3 的 float64 矩阵
 */
const STILL_ENTRY = Buffer.from(
  '000000b86d6562780000000000000001000000a86b6579730000004800000001000000306b6579646d647461636f' +
    '6d2e6170706c652e717569636b74696d652e7374696c6c2d696d6167652d74696d650000001064747970000000' +
    '00000000410000005800000002000000406b6579646d647461636f6d2e6170706c652e717569636b74696d652e' +
    '6c6976652d70686f746f2d7374696c6c2d696d6167652d7472616e73666f726d00000010647479700000000000' +
    '000053',
  'hex',
);

/** 静态图时刻轨道唯一的样本：still-image-time = -1，外加一个单位矩阵（静态图相对视频没做任何变换） */
const STILL_SAMPLE = Buffer.from(
  '0000000900000001ff0000005000000002' +
    '3ff0000000000000' + '0000000000000000' + '0000000000000000' +
    '0000000000000000' + '3ff0000000000000' + '0000000000000000' +
    '0000000000000000' + '0000000000000000' + '3ff0000000000000',
  'hex',
);

// ---------- MOV ----------

/** tkhd / mvhd 里的单位变换矩阵 */
const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

/** QuickTime 的 hdlr 名字是 Pascal 字符串：一个字节的长度 + 内容 */
function pascal(text: string): Buffer {
  const bytes = Buffer.from(text, 'latin1');
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function tkhd(trackId: number, duration: number, time: number): Buffer {
  // flags 0xf：启用、在影片中、在预览中、在海报中——和真机样本一致
  return fullBox(
    'tkhd',
    0,
    0x00000f,
    u32(time, time, trackId, 0, duration),
    Buffer.alloc(8),
    u16(0, 0, 0, 0),
    MATRIX,
    u32(0, 0),
  );
}

/** 编辑表。mediaTime 为 -1 的条目是一段空白：这段时间里这条轨道什么都不放 */
function edts(entries: Array<[duration: number, mediaTime: number]>): Buffer {
  return box(
    'edts',
    fullBox(
      'elst',
      0,
      0,
      u32(entries.length),
      ...entries.map(([duration, mediaTime]) =>
        Buffer.concat([u32(duration), i32(mediaTime), u32(0x00010000)]),
      ),
    ),
  );
}

/** 一条定时元数据（mebx）轨道，所有样本放在同一个 chunk 里 */
function metadataTrak(options: {
  trackId: number;
  time: number;
  timescale: number;
  /** 媒体时长（本轨道的 timescale） */
  mediaDuration: number;
  /** 轨道时长（影片的 timescale，含编辑表里的空白） */
  trackDuration: number;
  edits: Array<[number, number]>;
  entry: Buffer;
  stts: Array<[count: number, delta: number]>;
  sampleSize: number;
  sampleCount: number;
  chunkOffset: number;
}): Buffer {
  const o = options;
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), o.entry),
    fullBox('stts', 0, 0, u32(o.stts.length), ...o.stts.map(([count, delta]) => u32(count, delta))),
    fullBox('stsc', 0, 0, u32(1, 1, o.sampleCount, 1)),
    fullBox('stsz', 0, 0, u32(o.sampleSize, o.sampleCount)),
    fullBox('stco', 0, 0, u32(1, o.chunkOffset)),
  );
  const minf = box(
    'minf',
    box('gmhd', fullBox('gmin', 0, 0, u16(0x40, 0x8000, 0x8000, 0x8000, 0, 0))),
    fullBox(
      'hdlr',
      0,
      0,
      Buffer.from('dhlralisappl', 'latin1'),
      u32(0, 0),
      pascal('Core Media Data Handler'),
    ),
    box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('alis', 0, 1))),
    stbl,
  );
  const mdia = box(
    'mdia',
    // 语言 0x55c4 = und
    fullBox('mdhd', 0, 0, u32(o.time, o.time, o.timescale, o.mediaDuration), u16(0x55c4, 0)),
    fullBox('hdlr', 0, 0, Buffer.from('mhlrmetaappl', 'latin1'), u32(1, 0), pascal('Core Media Metadata')),
    minf,
  );
  return box('trak', tkhd(o.trackId, o.trackDuration, o.time), edts(o.edits), mdia);
}

/** QuickTime 风格的 moov/meta：hdlr(mdta) + keys + ilst。和 MP4 的 meta 不同，它没有 version/flags */
function quickTimeMeta(items: Array<[key: string, type: number, value: Buffer]>): Buffer {
  const hdlr = fullBox('hdlr', 0, 0, u32(0), Buffer.from('mdta', 'latin1'), Buffer.alloc(12), Buffer.alloc(2));
  const keys = fullBox(
    'keys',
    0,
    0,
    u32(items.length),
    ...items.map(([key]) => box('mdta', Buffer.from(key, 'utf8'))),
  );
  // ilst 里每一项的「类型」是键的序号（从 1 起），不是四个字母
  const ilst = box(
    'ilst',
    ...items.map(([, type, value], i) => {
      const data = box('data', u32(type, 0), value);
      return Buffer.concat([u32(8 + data.length, i + 1), data]);
    }),
  );
  return box('meta', hdlr, keys, ilst);
}

function handlerOf(buf: Buffer, trak: Box): string {
  const hdlr = path(buf, trak, ['mdia', 'hdlr']);
  return buf.toString('latin1', hdlr.start + 16, hdlr.start + 20);
}

/**
 * 把 ffmpeg 编出来的 MOV 改成实况照片的视频部分。
 *
 * stillFrame 是静态图对应的帧序号（从 0 起），静态图本身必须就是这一帧的画面。
 *
 * 对输入的要求（都由 export.ts 里的 ffmpeg 参数保证）：
 *   - moov 在文件末尾（不开 faststart）。新样本的 mdat 插在 moov 前面，
 *     视频轨道原有的 chunk 偏移一个都不用动
 *   - 只有一条视频轨道，没有 B 帧（显示时间 = 解码时间，第 N 帧的时刻直接从 stts 累加）
 *   - mvhd / mdhd 是 version 0（32 位时长，几秒的视频绰绰有余）
 */
export function packLivePhotoMov(mov: Buffer, contentId: string, stillFrame: number): Buffer {
  const top = listBoxes(mov);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov || moov.start + moov.size !== mov.length) throw new Error('MOV 的 moov 必须在文件末尾');

  const children = listBoxes(mov, moov.start + moov.header, moov.start + moov.size);
  const mvhd = Buffer.from(body(mov, child(mov, moov, 'mvhd')));
  if (mvhd[0] !== 0) throw new Error('只支持 version 0 的 mvhd');
  const time = mvhd.readUInt32BE(4);
  const movieScale = mvhd.readUInt32BE(12);
  const movieDuration = mvhd.readUInt32BE(16);
  const nextTrackId = mvhd.readUInt32BE(96);

  const video = children.find((b) => b.type === 'trak' && handlerOf(mov, b) === 'vide');
  if (!video) throw new Error('MOV 里没有视频轨道');
  const mdhd = body(mov, path(mov, video, ['mdia', 'mdhd']));
  if (mdhd[0] !== 0) throw new Error('只支持 version 0 的 mdhd');
  const mediaScale = mdhd.readUInt32BE(12);
  const mediaDuration = mdhd.readUInt32BE(16);

  // 视频每一帧的时长。live-photo-info 轨道照抄，保证每帧对应一个样本
  const sttsBody = body(mov, path(mov, video, ['mdia', 'minf', 'stbl', 'stts']));
  const stts: Array<[number, number]> = [];
  for (let i = 0, n = sttsBody.readUInt32BE(4); i < n; i++) {
    stts.push([sttsBody.readUInt32BE(8 + i * 8), sttsBody.readUInt32BE(12 + i * 8)]);
  }
  const frames = stts.reduce((sum, [count]) => sum + count, 0);
  if (stillFrame < 0 || stillFrame >= frames) {
    throw new Error(`静态帧 ${stillFrame} 超出范围（共 ${frames} 帧）`);
  }

  // 静态帧的媒体时刻 → 影片时刻
  let stillMedia = 0;
  let left = stillFrame;
  for (const [count, delta] of stts) {
    const take = Math.min(count, left);
    stillMedia += take * delta;
    left -= take;
    if (left === 0) break;
  }
  const stillTime = Math.round((stillMedia * movieScale) / mediaScale);

  // 新样本放进一个新的 mdat，紧挨在 moov 前面
  const mdat = box('mdat', ...Array.from({ length: frames }, () => INFO_SAMPLE), STILL_SAMPLE);
  const infoOffset = moov.start + 8;
  const stillOffset = infoOffset + INFO_SAMPLE.length * frames;

  const infoTrak = metadataTrak({
    trackId: nextTrackId,
    time,
    timescale: mediaScale,
    mediaDuration,
    trackDuration: movieDuration,
    edits: [[movieDuration, 0]],
    entry: INFO_ENTRY,
    stts,
    sampleSize: INFO_SAMPLE.length,
    sampleCount: frames,
    chunkOffset: infoOffset,
  });
  // 只有一个样本、时长 1；前面垫一段空白编辑，把它推到静态帧那一刻
  const stillTrak = metadataTrak({
    trackId: nextTrackId + 1,
    time,
    timescale: movieScale,
    mediaDuration: 1,
    trackDuration: stillTime + 1,
    edits: stillTime > 0 ? [[stillTime, -1], [1, 0]] : [[1, 0]],
    entry: STILL_ENTRY,
    stts: [[1, 1]],
    sampleSize: STILL_SAMPLE.length,
    sampleCount: 1,
    chunkOffset: stillOffset,
  });

  mvhd.writeUInt32BE(nextTrackId + 2, 96);
  const score = Buffer.alloc(4);
  score.writeFloatBE(1, 0);
  const scoringVersion = Buffer.alloc(8);
  scoringVersion.writeBigInt64BE(4n, 0);
  const meta = quickTimeMeta([
    ['com.apple.quicktime.content.identifier', 1, Buffer.from(contentId, 'utf8')],
    // 下面三个和 goLive 写的一样：自动识别出的实况、「生动度」满分、评分算法第 4 版。
    // 类型码 0x16 / 0x17 / 0x15 分别是大端无符号整数、float32、有符号整数（和 exiftool 写入时一致）
    ['com.apple.quicktime.live-photo.auto', 0x16, Buffer.from([1])],
    ['com.apple.quicktime.live-photo.vitality-score', 0x17, score],
    ['com.apple.quicktime.live-photo.vitality-scoring-version', 0x15, scoringVersion],
  ]);

  // 原有的子盒子原样保留（mvhd 换成改过的），旧的 meta 丢掉换成我们的
  const kept = children
    .filter((b) => b.type !== 'meta')
    .map((b) => (b.type === 'mvhd' ? box('mvhd', mvhd) : mov.subarray(b.start, b.start + b.size)));
  const newMoov = box('moov', ...kept, infoTrak, stillTrak, meta);

  return Buffer.concat([mov.subarray(0, moov.start), mdat, newMoov]);
}

// ---------- 静态图 ----------

/**
 * Apple MakerNote：'Apple iOS' + NUL + 版本 1 + 'MM'，从第 14 字节起是一个 IFD，
 * 里面的偏移都相对 MakerNote 开头。只放一个标签：0x0011 ContentIdentifier。
 * 真机只带这一个标签时正好 69 字节，和这里拼出来的逐字节同构。
 */
function appleMakerNote(contentId: string): Buffer {
  const text = Buffer.concat([Buffer.from(contentId, 'ascii'), Buffer.from([0])]);
  const head = Buffer.concat([
    Buffer.from('Apple iOS', 'latin1'),
    Buffer.from([0]),
    u16(1),
    Buffer.from('MM', 'latin1'),
  ]);
  // IFD：条目数（2 字节）+ 1 个条目（12 字节）+ 下一个 IFD 的偏移（4 字节），之后是字符串
  const dataAt = head.length + 2 + 12 + 4;
  const ifd = Buffer.concat([u16(1), u16(0x0011, 2), u32(text.length, dataAt), u32(0)]);
  return Buffer.concat([head, ifd, text]);
}

/**
 * 一段只有 Apple MakerNote 的 EXIF（APP1 段）。
 *   IFD0：只有一个指向 Exif IFD 的指针
 *   Exif IFD：ExifVersion + MakerNote
 * 不写 Make / Model：这不是 iPhone 拍的，不冒充。配对只认 MakerNote 的签名和 17 号标签。
 */
function exifWithMakerNote(contentId: string): Buffer {
  const maker = appleMakerNote(contentId);
  // TIFF 头 8 字节；IFD0 从 8 开始，占 2 + 12 + 4 = 18 字节
  const exifIfdAt = 8 + 18;
  // Exif IFD 占 2 + 2×12 + 4 = 30 字节，后面紧跟 MakerNote 的内容
  const makerAt = exifIfdAt + 30;
  const tiff = Buffer.concat([
    Buffer.from('MM', 'latin1'),
    u16(42),
    u32(8),
    // IFD0
    u16(1),
    u16(0x8769, 4),
    u32(1, exifIfdAt),
    u32(0),
    // Exif IFD，条目按标签号升序
    u16(2),
    u16(0x9000, 7),
    u32(4),
    Buffer.from('0232', 'latin1'),
    u16(0x927c, 7),
    u32(maker.length, makerAt),
    u32(0),
    maker,
  ]);
  const payload = Buffer.concat([Buffer.from('Exif', 'latin1'), Buffer.from([0, 0]), tiff]);
  return Buffer.concat([u16(0xffe1, payload.length + 2), payload]);
}

/**
 * 往 JPEG 里插 APP 段，放在 SOI 之后。
 * 原有的 APP0（JFIF）去掉：EXIF 规范要求 APP1 紧跟 SOI，两者本来就不该同时出现。
 */
function insertJpegSegments(jpeg: Buffer, segments: Buffer[]): Buffer {
  if (jpeg.readUInt16BE(0) !== 0xffd8) throw new Error('不是 JPEG');
  let at = 2;
  const kept: Buffer[] = [];
  // 只动 SOS 之前的标记段，压缩数据原样接在后面
  while (at + 4 <= jpeg.length) {
    const marker = jpeg.readUInt16BE(at);
    if ((marker & 0xff00) !== 0xff00) throw new Error(`JPEG 结构不对（@${at}）`);
    if (marker === 0xffda) break;
    const length = jpeg.readUInt16BE(at + 2);
    if (marker !== 0xffe0) kept.push(jpeg.subarray(at, at + 2 + length));
    at += 2 + length;
  }
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, ...kept, jpeg.subarray(at)]);
}

/** 给静态图（JPEG）写上配对用的 ContentIdentifier */
export function packLivePhotoJpeg(jpeg: Buffer, contentId: string): Buffer {
  return insertJpegSegments(jpeg, [exifWithMakerNote(contentId)]);
}
