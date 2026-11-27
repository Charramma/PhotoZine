import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sharp } from '../sharpRuntime'

/**
 * 测试样本用**真实编码器**现场生成（AGENTS.md §2.2、§7.3）：管线读到的是真字节、真 EXIF，
 * 不是内存桩。HEIC 无法本机生成（sharp 预编译 libvips 无 HEVC 通路），只造"看起来像 HEIC"
 * 的文件来验证解码失败被逐个隔离。
 */

export type SampleFormat = 'jpeg' | 'png' | 'webp'

export interface SampleExif {
  dateTimeOriginal?: string
  subsecOriginal?: string
  offsetOriginal?: string
  camera?: { make: string; model: string }
  /** 写进 IFD3：用于验证"GPS 不进项目文件"是真的没进，而不是进了再屏蔽 */
  gps?: boolean
}

export interface SampleOptions {
  format: SampleFormat
  width: number
  height: number
  /** 只写 EXIF 方向标记，像素本身不旋转 —— 与相机直出的情形一致 */
  orientation?: number
  exif?: SampleExif
  /** 让每张样本的字节都不同，避免误撞哈希 */
  seed?: number
}

const color = (seed: number): { r: number; g: number; b: number } => ({
  r: (seed * 37) % 251,
  g: (seed * 71) % 241,
  b: (seed * 113) % 233
})

export async function writeSample(dir: string, fileName: string, options: SampleOptions): Promise<string> {
  await mkdir(dir, { recursive: true })
  const seed = options.seed ?? fileName.length
  let builder = sharp({
    create: { width: options.width, height: options.height, channels: 3, background: color(seed) }
  })

  const exif = options.exif
  if (exif !== undefined) {
    const ifd0: Record<string, string> = {}
    const ifd2: Record<string, string> = {}
    const ifd3: Record<string, string> = {}
    if (exif.camera !== undefined) {
      ifd0.Make = exif.camera.make
      ifd0.Model = exif.camera.model
    }
    if (exif.dateTimeOriginal !== undefined) ifd2.DateTimeOriginal = exif.dateTimeOriginal
    if (exif.subsecOriginal !== undefined) ifd2.SubSecTimeOriginal = exif.subsecOriginal
    if (exif.offsetOriginal !== undefined) ifd2.OffsetTimeOriginal = exif.offsetOriginal
    if (exif.gps === true) {
      ifd3.GPSLatitudeRef = 'N'
      ifd3.GPSLatitude = '31/1 23/1 3000/100'
      ifd3.GPSLongitudeRef = 'E'
      ifd3.GPSLongitude = '121/1 30/1 0/1'
    }
    // libvips 的 IFD 编号：IFD0 主、IFD2 是 Exif 子 IFD、IFD3 是 GPS 子 IFD
    builder = builder.withExif({ IFD0: ifd0, IFD2: ifd2, IFD3: ifd3 })
  }
  if (options.orientation !== undefined) {
    builder = builder.withMetadata({ orientation: options.orientation })
  }

  const file = path.join(dir, fileName)
  if (options.format === 'jpeg') {
    await builder.jpeg({ quality: 88 }).toFile(file)
  } else if (options.format === 'png') {
    await builder.png().toFile(file)
  } else {
    await builder.webp({ quality: 88 }).toFile(file)
  }
  return file
}

/** 头是对的、数据是断的：应当被判定为无法解码，而不是"尺寸未知的合法图片" */
export async function writeTruncatedSample(dir: string, fileName: string): Promise<string> {
  const source = await writeSample(dir, `.${fileName}-src`, { format: 'jpeg', width: 400, height: 300, seed: 9 })
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(source)
  const file = path.join(dir, fileName)
  await writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 3)))
  return file
}

/** 只有 HEIC 文件头的假文件：解码必然失败，用来验证逐文件隔离与零残留 */
export async function writeFakeHeic(dir: string, fileName: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const header = Buffer.alloc(16)
  header.writeUInt32BE(24, 0)
  header.write('ftyp', 4, 'latin1')
  header.write('heic', 8, 'latin1')
  const file = path.join(dir, fileName)
  await writeFile(file, Buffer.concat([header, Buffer.alloc(64, 7)]))
  return file
}
