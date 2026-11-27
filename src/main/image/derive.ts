import { readFile } from 'node:fs/promises'
import decodeHeic from 'heic-decode'
import { HEIC_DERIVED, IMAGE_PIPELINE, THUMBNAIL } from '@shared/domain/constants'
import { geometryFromDecoded, type PhotoGeometry } from './probe'
import { sharp, type Sharp } from './sharpRuntime'

/**
 * 派生图生成（总体设计稿 §5、AGENTS.md §6.2/§6.3）。
 *
 * 两条铁律在这里落地：**派生图像素已摆正**（栅格图用 `.rotate()` 读 EXIF 自动转向，
 * HEIC 由解码器应用容器方向），以及**派生档只用离散规格**（缩略图长边 400），
 * 不按精确像素生成 —— 否则用户微调裁切视点就会触发全量重转。
 */

const THUMBNAIL_RESIZE = {
  width: THUMBNAIL.longEdgePx,
  height: THUMBNAIL.longEdgePx,
  fit: 'inside',
  /** 小图不放大，避免列表里出现被拉伸的糊边 */
  withoutEnlargement: true
} as const

/** 超过 40MP 时把位图压回上限所需的缩放系数；1 表示无需降采样（需求文档 FR-PHOTO-01） */
export function scaleToFitMaxPixels(width: number, height: number): number {
  const pixels = width * height
  if (pixels <= IMAGE_PIPELINE.maxPixels) return 1
  return Math.sqrt(IMAGE_PIPELINE.maxPixels / pixels)
}

/** 落盘尾段只有一处定义：透明区统一落白底，质量由档位常量给定 */
function writeJpeg(image: Sharp, target: string, quality: number): Promise<unknown> {
  return image.flatten({ background: '#ffffff' }).jpeg({ quality }).toFile(target)
}

/** 缩略图档：栅格图直接从 `photos/` 的原图出 */
export async function writeThumbnail(source: string, target: string): Promise<void> {
  await writeJpeg(sharp(source).rotate().resize(THUMBNAIL_RESIZE), target, THUMBNAIL.quality)
}

export interface HeicDerived {
  geometry: PhotoGeometry
  /** 原图超过 40MP，派生图已降采样（界面要记警告）；`geometry` 仍是原图的真实尺寸 */
  downscaled: boolean
}

/** 解码得到的 RGBA 像素：两处输出各建一条流水线，共用同一块内存，不再复制 */
function rasterOf(decoded: { width: number; height: number; data: Uint8ClampedArray }): Sharp {
  return sharp(Buffer.from(decoded.data.buffer), {
    raw: { width: decoded.width, height: decoded.height, channels: 4 }
  })
}

/**
 * HEIC：原始字节留在 `photos/` 永不改写，解码产物写 `derived/heic/<photoId>.jpg`，
 * 缩略图与后续所有档位都从这张解码图出（总体设计稿 §5）。
 */
export async function writeHeicDerived(
  source: string,
  targets: { decoded: string; thumbnail: string }
): Promise<HeicDerived> {
  const decoded = await decodeHeic({ buffer: await readFile(source) })
  const geometry = geometryFromDecoded(decoded.width, decoded.height)
  const scale = scaleToFitMaxPixels(geometry.encodedWidth, geometry.encodedHeight)

  const decodedImage = scale < 1
    ? rasterOf(decoded).resize({
        width: Math.round(decoded.width * scale),
        height: Math.round(decoded.height * scale),
        fit: 'inside'
      })
    : rasterOf(decoded)
  await writeJpeg(decodedImage, targets.decoded, HEIC_DERIVED.quality)
  await writeJpeg(rasterOf(decoded).resize(THUMBNAIL_RESIZE), targets.thumbnail, THUMBNAIL.quality)

  return { geometry, downscaled: scale < 1 }
}
