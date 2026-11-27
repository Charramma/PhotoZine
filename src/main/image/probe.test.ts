import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFakeHeic, writeSample, writeTruncatedSample } from './__fixtures__/samples'
import { displaySizeOf, geometryFromDecoded, measureRasterGeometry, readSourceMetadata } from './probe'

/** 用 sharp 现场编码的真实文件跑探测，不用内存桩（AGENTS.md §7.3） */

const TAKEN_AT_LOCAL = [2026, 3, 4, 15, 26, 33]

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pz-probe-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const localParts = (iso: string): number[] => {
  const at = new Date(iso)
  return [at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()]
}

describe('measureRasterGeometry', () => {
  it('带 EXIF 方向的 JPEG：编码尺寸不变，显示尺寸按方向互换', async () => {
    const file = await writeSample(dir, '相机直出.jpg', {
      format: 'jpeg',
      width: 1200,
      height: 800,
      orientation: 6,
      seed: 11
    })

    expect(await measureRasterGeometry(file)).toEqual({
      encodedWidth: 1200,
      encodedHeight: 800,
      displayWidth: 800,
      displayHeight: 1200,
      orientation: 6
    })
  })

  it('无 EXIF 的 PNG 与 WebP：方向视为 1，宽高不互换', async () => {
    const png = await writeSample(dir, '截图.png', { format: 'png', width: 640, height: 480, seed: 13 })
    const webp = await writeSample(dir, '贴纸.webp', { format: 'webp', width: 200, height: 300, seed: 14 })

    expect(await measureRasterGeometry(png)).toEqual({
      encodedWidth: 640,
      encodedHeight: 480,
      displayWidth: 640,
      displayHeight: 480,
      orientation: 1
    })
    expect(await measureRasterGeometry(webp)).toMatchObject({ displayWidth: 200, displayHeight: 300 })
  })

  it('数据被截断的 JPEG 仍能读出头里的尺寸：真正拦住它的是派生图阶段的解码失败', async () => {
    const file = await writeTruncatedSample(dir, '下了一半.jpg')

    expect((await measureRasterGeometry(file)).encodedWidth).toBeGreaterThan(0)
  })

  it('非图片与 HEIC 都读不出尺寸：前者是坏文件，后者本来就不该走 sharp', async () => {
    const txt = path.join(dir, '说明.txt')
    await writeFile(txt, '这不是图片')
    const heic = await writeFakeHeic(dir, '假装是真机.heic')

    await expect(measureRasterGeometry(txt)).rejects.toThrowError()
    await expect(measureRasterGeometry(heic)).rejects.toThrowError()
    expect((await stat(heic)).size).toBeGreaterThan(0)
  })
})

describe('readSourceMetadata', () => {
  it('带 OffsetTimeOriginal 的墙上时间按偏移换算成绝对时刻，与导入机在哪个时区无关（D-19）', async () => {
    // 标签值取自真机 iPhone 13 Pro Max：同一片的 GPS 时间戳是 2025-05-19 00:27:40.44 UTC
    const file = await writeSample(dir, '带偏移.jpg', {
      format: 'jpeg',
      width: 320,
      height: 240,
      exif: {
        dateTimeOriginal: '2025:05:18 20:27:40',
        subsecOriginal: '449',
        offsetOriginal: '-04:00',
        camera: { make: 'Apple', model: 'iPhone 13 Pro Max' }
      },
      seed: 41
    })

    expect(await readSourceMetadata(file)).toEqual({
      takenAt: '2025-05-19T00:27:40.449Z',
      camera: 'Apple iPhone 13 Pro Max'
    })
  })

  it('没有偏移的墙上时间按导入机时区解释：换回本地时间分毫不差（D-19）', async () => {
    const file = await writeSample(dir, '带时间.jpg', {
      format: 'jpeg',
      width: 320,
      height: 240,
      exif: { dateTimeOriginal: '2026:03:04 15:26:33', camera: { make: 'Canon', model: 'EOS R5' } },
      seed: 12
    })

    const metadata = await readSourceMetadata(file)

    expect(typeof metadata.takenAt).toBe('string')
    if (typeof metadata.takenAt !== 'string') return
    expect(localParts(metadata.takenAt)).toEqual(TAKEN_AT_LOCAL)
    expect(metadata.camera).toBe('Canon EOS R5')
  })

  it('偏移写得不成样子时退到本机时区，时间本身不丢', async () => {
    const file = await writeSample(dir, '偏移畸形.jpg', {
      format: 'jpeg',
      width: 320,
      height: 240,
      exif: { dateTimeOriginal: '2026:03:04 15:26:33', offsetOriginal: 'GMT-4' },
      seed: 42
    })

    const metadata = await readSourceMetadata(file)

    expect(metadata.takenAt).not.toBeNull()
    if (metadata.takenAt === null) return
    expect(localParts(metadata.takenAt)).toEqual(TAKEN_AT_LOCAL)
  })

  it('元数据里不存在 GPS 与源路径的容身之处（AGENTS.md §5.10）', async () => {
    const file = await writeSample(dir, '带定位.jpg', {
      format: 'jpeg',
      width: 320,
      height: 240,
      exif: { gps: true },
      seed: 13
    })
    const metadata = await readSourceMetadata(file)

    expect(Object.keys(metadata).sort()).toEqual(['camera', 'takenAt'])
    expect(JSON.stringify(metadata)).not.toMatch(/latitude|longitude|gps/i)
  })

  it('厂商名重复在型号里时只留一份；全无元数据时两项为空', async () => {
    const repeated = await writeSample(dir, '重复厂商.jpg', {
      format: 'jpeg',
      width: 100,
      height: 100,
      exif: { camera: { make: 'Canon', model: 'Canon EOS R5' } },
      seed: 15
    })
    const plain = await writeSample(dir, '无元数据.png', { format: 'png', width: 100, height: 100, seed: 16 })

    expect((await readSourceMetadata(repeated)).camera).toBe('Canon EOS R5')
    expect(await readSourceMetadata(plain)).toEqual({ takenAt: null, camera: null })
  })

  it('读不出元数据的畸形文件返回空，而不是抛错打断整批', async () => {
    expect(await readSourceMetadata(path.join(dir, '不存在.jpg'))).toEqual({ takenAt: null, camera: null })
  })
})

describe('displaySizeOf', () => {
  it('0–4 度族不互换，90/270 度族互换', () => {
    for (const orientation of [1, 2, 3, 4]) {
      expect(displaySizeOf(1200, 800, orientation), String(orientation)).toEqual({
        displayWidth: 1200,
        displayHeight: 800
      })
    }
    for (const orientation of [5, 6, 7, 8]) {
      expect(displaySizeOf(1200, 800, orientation), String(orientation)).toEqual({
        displayWidth: 800,
        displayHeight: 1200
      })
    }
  })
})

describe('geometryFromDecoded', () => {
  it('解码产物视为已摆正', () => {
    expect(geometryFromDecoded(4032, 3024)).toEqual({
      encodedWidth: 4032,
      encodedHeight: 3024,
      displayWidth: 4032,
      displayHeight: 3024,
      orientation: 1
    })
  })
})
