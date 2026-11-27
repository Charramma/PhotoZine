/**
 * heic-decode 没有随包类型，这里补齐我们真正用到的那一面（AGENTS.md §2.2 强类型）。
 * 只声明解码：它内部的 jimp 重编码我们不碰，编码统一交给 sharp（总体设计稿 §5、AGENTS.md §8.1）。
 */
declare module 'heic-decode' {
  export interface HeicDecoded {
    /** 已按容器 irot/imir 摆正的像素宽高 */
    width: number
    height: number
    /** RGBA 逐行像素 */
    data: Uint8ClampedArray
  }

  export interface HeicDecodeOptions {
    buffer: Uint8Array
  }

  export default function decodeHeic(options: HeicDecodeOptions): Promise<HeicDecoded>
}
