/** heic-decode 没有自带类型，这里只声明用到的那一个函数 */
declare module 'heic-decode' {
  export default function decode(input: {
    buffer: ArrayBufferLike | Uint8Array;
  }): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}
