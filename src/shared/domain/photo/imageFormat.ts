import { IMAGE_FORMAT_EXTENSIONS, IMAGE_FORMAT_LABELS } from '../constants'

/**
 * 图片格式判定的唯一来源：扩展名白名单 + 文件头魔数（需求文档 FR-PHOTO-01）。
 * 两者都要过 —— 只认扩展名会让"内容是别的格式、扩展名写成 .jpg"的文件混进管线，
 * 到解码阶段才失败，报错也就说不清是哪张照片的什么问题。
 */

export type ImageFormat = keyof typeof IMAGE_FORMAT_EXTENSIONS

/** 界面与错误提示里的格式清单：由标签表派生，不与白名单分叉 */
export const SUPPORTED_FORMAT_HINT = Object.values(IMAGE_FORMAT_LABELS).join('、')

const formatByExtension = new Map<string, ImageFormat>()
for (const [format, extensions] of Object.entries(IMAGE_FORMAT_EXTENSIONS) as [
  ImageFormat,
  readonly string[]
][]) {
  for (const extension of extensions) formatByExtension.set(extension, format)
}

/**
 * HEIF 母品牌，与 heic-decode 内部的认品牌表保持一致：
 * 我们放行什么，解码器就能解什么，不出现"这边放行、那边说不是 HEIC"的分叉。
 * 注意 `avif` 不在其中 —— AVIF 不是 HEIC。
 */
const HEIC_BRANDS = new Set(['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx'])

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 由文件名的扩展名得出格式；白名单之外返回 null */
export function formatFromFileName(fileName: string): ImageFormat | null {
  const dot = fileName.lastIndexOf('.')
  // 点号在开头是 Unix 隐藏文件的写法，不是扩展名
  if (dot <= 0) return null
  return formatByExtension.get(fileName.slice(dot + 1).toLowerCase()) ?? null
}

function startsWithMagic(head: Uint8Array, magic: readonly number[]): boolean {
  return head.length >= magic.length && magic.every((byte, index) => head[index] === byte)
}

/** 按 latin1 读出 [from, to) 区间的 ASCII 文本，越界返回空串 */
function readAscii(head: Uint8Array, from: number, to: number): string {
  return head.length >= to ? String.fromCharCode(...head.subarray(from, to)) : ''
}

/** 由文件头得出真实格式；认不出来返回 null（当作非图片处理） */
export function sniffImageFormat(head: Uint8Array): ImageFormat | null {
  if (startsWithMagic(head, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWithMagic(head, PNG_MAGIC)) return 'png'
  if (readAscii(head, 0, 4) === 'RIFF' && readAscii(head, 8, 12) === 'WEBP') return 'webp'
  if (readAscii(head, 4, 8) === 'ftyp' && HEIC_BRANDS.has(readAscii(head, 8, 12))) return 'heic'
  return null
}
