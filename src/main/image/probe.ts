import exifr from 'exifr'
import { instantFromExifTime } from '@shared/domain/photo/exifTime'
import { sharp } from './sharpRuntime'

/**
 * 源文件探测（总体设计稿 §5、§3 尺寸真值）：编码尺寸与 EXIF 方向由 sharp 得出，
 * 拍摄时间与相机由 exifr 得出**原始标签**、再由 `instantFromExifTime` 换算成绝对时刻。
 *
 * 格式判定不在这里 —— 它属于导入准入阶段（`shared/domain/photo/imageFormat`），
 * 由文件头一次性给出；这里只回答"这张栅格图有多大""它留下了哪些可读信息"。
 * HEIC 的几何只能等解码结果给出（预编译 libvips 无 HEVC 通路，总体设计稿 S2 实测），
 * 所以它压根不走 `measureRasterGeometry`，也就不需要一个"可能是 null 的尺寸"。
 */

export interface PhotoGeometry {
  /** 未摆正的像素尺寸 */
  encodedWidth: number
  encodedHeight: number
  /** 用户看到的尺寸：方向 5–8 时宽高互换，版面几何只用它（AGENTS.md §6.3） */
  displayWidth: number
  displayHeight: number
  /** 重建派生图时要施加的方向；派生图像素已按它摆正 */
  orientation: number
}

export interface SourceMetadata {
  /**
   * 绝对时刻（ISO 8601 UTC）。有 `OffsetTimeOriginal` 就按它换算，没有才按导入机时区解释；
   * 换算只在 `shared/domain/photo/exifTime`，这里只负责把原始标签交出去（D-19）
   */
  takenAt: string | null
  camera: string | null
}

/** EXIF 方向 5–8 是 90/270 度族，显示时宽高互换 */
export function displaySizeOf(
  width: number,
  height: number,
  orientation: number
): { displayWidth: number; displayHeight: number } {
  if (orientation < 5 || orientation > 8) return { displayWidth: width, displayHeight: height }
  return { displayWidth: height, displayHeight: width }
}

/**
 * 解码器（libheif）已按容器 irot/imir 摆正的图像：派生图像素就是显示像素，
 * 方向记 1 表示"重建派生图时不需要再转"。真机样本若发现方向不对，改动点只在这里（总体设计稿 §5）。
 */
export function geometryFromDecoded(width: number, height: number): PhotoGeometry {
  return { encodedWidth: width, encodedHeight: height, displayWidth: width, displayHeight: height, orientation: 1 }
}

/**
 * 时间标签的取用顺序与配对：EXIF 的"原始 / 数字化 / 修改"三组，每组各带亚秒与时区偏移。
 * 键名用 exifr 字典里的写法，它对得上规范标签号：`DateTimeOriginal` = 0x9003、
 * `CreateDate` = 0x9004（规范里叫 DateTimeDigitized）、`ModifyDate` = IFD0 的 0x0132；
 * 别被 `CreateDate` 这个名字骗去改顺序。实测（真机 iPhone 13 Pro Max）三组同值。
 */
const TIME_TAGS = [
  { dateTime: 'DateTimeOriginal', subsec: 'SubSecTimeOriginal', offset: 'OffsetTimeOriginal' },
  { dateTime: 'CreateDate', subsec: 'SubSecTimeDigitized', offset: 'OffsetTimeDigitized' },
  { dateTime: 'ModifyDate', subsec: 'SubSecTime', offset: 'OffsetTime' }
] as const

/**
 * 一次取全：exifr 的 `pick` 按名字挑才稳，按数字标签号挑会漏标签（实测）；
 * `reviveValues: false` 是要它**别**把日期变成 Date —— 那条路会把墙上时间按本机时区解释，
 * 换台机器重导同一批照片时刻就漂移，换算必须只由 `instantFromExifTime` 做。
 */
const TAG_PICK: string[] = [
  ...TIME_TAGS.flatMap((group) => [group.dateTime, group.subsec, group.offset]),
  'Make',
  'Model'
]

/** exifr 的返回类型是 any，只在这一处收口成 unknown 容器，业务层不再碰它 */
async function parseTags(file: string): Promise<Map<string, unknown> | null> {
  try {
    const tags: unknown = await exifr.parse(file, { pick: TAG_PICK, reviveValues: false })
    if (typeof tags !== 'object' || tags === null) return null
    return new Map<string, unknown>(Object.entries(tags))
  } catch {
    // 元数据缺失或畸形不阻断导入：图像能不能解由 sharp 判定
    return null
  }
}

/** 拍摄时间与相机。GPS 不进项目文件，这里也就不往外给（AGENTS.md §5.10） */
export async function readSourceMetadata(file: string): Promise<SourceMetadata> {
  const tags = await parseTags(file)
  const tagText = (key: string): string => {
    const value = tags?.get(key)
    return typeof value === 'string' ? value.trim() : ''
  }

  let takenAt: string | null = null
  for (const group of TIME_TAGS) {
    const dateTime = tagText(group.dateTime)
    if (dateTime === '') continue
    takenAt = instantFromExifTime({
      dateTime,
      subsec: tagText(group.subsec),
      offset: tagText(group.offset)
    })
    // 前一组写了时间却换算不出（值畸形）就退到下一组，三组都没有才算没有时间
    if (takenAt !== null) break
  }

  const make = tagText('Make')
  const model = tagText('Model')
  // 多数机型会把厂商名重复写进型号，只留一份
  const camera =
    model === ''
      ? make === ''
        ? null
        : make
      : make === '' || model.toLowerCase().startsWith(make.toLowerCase())
        ? model
        : `${make} ${model}`

  return { takenAt, camera }
}

/** 栅格图的编码尺寸与 EXIF 方向；读不出尺寸就抛错，交给导入阶段逐个隔离 */
export async function measureRasterGeometry(file: string): Promise<PhotoGeometry> {
  const info = await sharp(file).metadata()
  if (info.width === undefined || info.height === undefined) throw new Error('读不出图片尺寸')
  const orientation = info.orientation ?? 1
  return {
    encodedWidth: info.width,
    encodedHeight: info.height,
    ...displaySizeOf(info.width, info.height, orientation),
    orientation
  }
}
