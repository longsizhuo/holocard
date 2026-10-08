/**
 * 安卓动态照片（Motion Photo）
 *
 * 格式是公开的（Google 的 Motion Photo 1.0，developer.android.com/media/platform/motion-photo-format）：
 * 一张普通 JPEG，文件末尾直接接上一段 MP4，再在 XMP 里写明「后面接了多长的视频」。
 * 不认识这个格式的看图软件只会看到一张正常的 JPEG——JPEG 解码到 EOI 就停了。
 *
 * XMP 里两套字段都写：
 *   MotionPhoto 1.0 + Container 目录   现行规范，Google 相册、新一些的系统相册认这个
 *   MicroVideo                         老格式，规范说新读取方应当忽略它，
 *                                      但一些国产系统相册只认它，多写几行没有代价
 * 目录的写法照 Pixel 手机实际产出的样子（Container:Item 带 Item:* 属性），
 * 那是各家读取方都测过的形态。XMP 由 sharp 写进 JPEG。
 */

import sharp from 'sharp';

/**
 * 拼一张动态照片。
 *
 * cover 是封面（PNG），presentationUs 是封面对应视频里的哪一刻（微秒）。
 * 封面必须就是那一帧的画面，否则相册从静态图切到播放时会跳一下。
 */
export async function packMotionPhoto(cover: Buffer, mp4: Buffer, presentationUs: number): Promise<Buffer> {
  const us = Math.round(presentationUs);
  const xmp = [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="HoloCard">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"',
    '    xmlns:Container="http://ns.google.com/photos/1.0/container/"',
    '    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"',
    '   GCamera:MotionPhoto="1"',
    '   GCamera:MotionPhotoVersion="1"',
    `   GCamera:MotionPhotoPresentationTimestampUs="${us}"`,
    '   GCamera:MicroVideo="1"',
    '   GCamera:MicroVideoVersion="1"',
    // 老格式的偏移是「从文件末尾往前数」，视频接在最后，所以就是视频的长度
    `   GCamera:MicroVideoOffset="${mp4.length}"`,
    `   GCamera:MicroVideoPresentationTimestampUs="${us}">`,
    '   <Container:Directory>',
    '    <rdf:Seq>',
    '     <rdf:li rdf:parseType="Resource">',
    '      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/>',
    '     </rdf:li>',
    '     <rdf:li rdf:parseType="Resource">',
    `      <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${mp4.length}" Item:Padding="0"/>`,
    '     </rdf:li>',
    '    </rdf:Seq>',
    '   </Container:Directory>',
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
  ].join('\n');

  const image = await sharp(cover).jpeg({ quality: 92 }).withXmp(xmp).toBuffer();
  // 规范要求各项紧挨着放：JPEG 必须以 EOI 结尾，视频紧跟其后，中间不能有别的字节
  if (image.readUInt16BE(image.length - 2) !== 0xffd9) throw new Error('JPEG 没有以 EOI 结尾');
  return Buffer.concat([image, mp4]);
}
