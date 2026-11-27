import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { THUMBNAIL, IMAGE_PIPELINE } from '@shared/domain/constants'
import { writeFakeHeic, writeSample } from './__fixtures__/samples'
import { scaleToFitMaxPixels, writeHeicDerived, writeThumbnail } from './derive'
import { sharp } from './sharpRuntime'

/** 派生图的正确性用真实编码结果度量，不靠 mock 断言（AGENTS.md §7.1） */

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pz-derive-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const thumbDir = async (): Promise<string> => {
  const dir2 = path.join(dir, 'thumbnails')
  await mkdir(dir2, { recursive: true })
  return dir2
}
const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false)

describe('writeThumbnail', () => {
  it('EXIF 方向为 6 的原图：缩略图像素已摆正', async () => {
    const source = await writeSample(dir, '横拍竖显.jpg', {
      format: 'jpeg',
      width: 1200,
      height: 800,
      orientation: 6,
      seed: 21
    })
    const target = path.join(await thumbDir(), '横拍竖显.jpg')

    await writeThumbnail(source, target)

    const info = await sharp(target).metadata()
    expect(info.height ?? 0).toBeGreaterThan(info.width ?? 0)
    expect(Math.max(info.width ?? 0, info.height ?? 0)).toBe(THUMBNAIL.longEdgePx)
  })

  it('按长边等比缩到档位上限，透明区落白底，产物是 JPEG', async () => {
    const source = await writeSample(dir, '带透明.png', { format: 'png', width: 640, height: 480, seed: 22 })
    const target = path.join(await thumbDir(), '带透明.png')

    await writeThumbnail(source, target)

    const info = await sharp(target).metadata()
    expect(info.format).toBe('jpeg')
    expect(info).toMatchObject({ width: THUMBNAIL.longEdgePx, height: 300 })
  })

  it('比档位还小的原图不放大', async () => {
    const source = await writeSample(dir, '小图.jpg', { format: 'jpeg', width: 100, height: 60, seed: 23 })
    const target = path.join(await thumbDir(), '小图.jpg')

    await writeThumbnail(source, target)

    expect(await sharp(target).metadata()).toMatchObject({ width: 100, height: 60 })
  })

  it('目标目录不存在时不静默创建：目录骨架由打开项目时保证（总体设计稿 §7）', async () => {
    const source = await writeSample(dir, '无目录.jpg', { format: 'jpeg', width: 200, height: 200, seed: 24 })
    await expect(writeThumbnail(source, path.join(dir, '不存在', 'x.jpg'))).rejects.toThrowError()
  })
})

describe('writeHeicDerived', () => {
  it('解码失败时报错，且不留任何半成品文件', async () => {
    const source = await writeFakeHeic(dir, '解不开.heic')
    const out = path.join(dir, '解码产物')
    await mkdir(out, { recursive: true })
    const targets = { decoded: path.join(out, 'x.jpg'), thumbnail: path.join(out, 't.jpg') }

    await expect(writeHeicDerived(source, targets)).rejects.toThrowError()
    expect(await exists(targets.decoded)).toBe(false)
    expect(await exists(targets.thumbnail)).toBe(false)
  })

  it('伪造的 HEIC 头会被解码器拒绝，而不是产出一张空图', async () => {
    const source = await writeFakeHeic(dir, '只有头.heic')
    const out = path.join(dir, '第二次')
    await mkdir(out, { recursive: true })

    await expect(
      writeHeicDerived(source, { decoded: path.join(out, 'd.jpg'), thumbnail: path.join(out, 't.jpg') })
    ).rejects.toThrowError()

    expect(await readdir(out)).toEqual([])
  })
})

describe('scaleToFitMaxPixels', () => {
  it('40MP 以内原样', () => {
    expect(scaleToFitMaxPixels(4000, 3000)).toBe(1)
    expect(scaleToFitMaxPixels(8000, 5000)).toBe(1)
  })

  it('超过 40MP 时等比压回上限以内', () => {
    const scale = scaleToFitMaxPixels(8000, 6000)
    expect(scale).toBeLessThan(1)
    expect(8000 * scale * (6000 * scale)).toBeLessThanOrEqual(IMAGE_PIPELINE.maxPixels * 1.001)
  })
})
