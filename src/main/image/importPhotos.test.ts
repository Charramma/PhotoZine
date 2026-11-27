import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { COPY_CHUNK_BYTES, IMAGE_PIPELINE, PROJECT_DIRS, THUMBNAIL } from '@shared/domain/constants'
import { photoSchema } from '@shared/domain/project/schema'
import { formatFromFileName } from '@shared/domain/photo/imageFormat'
import { ensureProjectSkeleton } from '../fs/projectLayout'
import { writeFakeHeic, writeSample, writeTruncatedSample } from './__fixtures__/samples'
import { importPhotos, type ImportOutcome, type ImportProgress } from './importPhotos'
import { sharp } from './sharpRuntime'

/**
 * 导入管线的验收用**真实磁盘与真实编码文件**跑（AGENTS.md §2.2、§7.3）：
 * 源文件在项目外的临时目录，落盘结果逐项核对，禁止内存桩糊弄过去。
 */

let workspace = ''
let root = ''
let sources = ''

const neverAborted = new AbortController().signal

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'pz-import-'))
  // 项目文件夹与"用户的源目录"分开：导入必须只读后者、只写前者（总体设计稿 §3）
  root = path.join(workspace, '我的杂志')
  sources = path.join(workspace, '相机卡')
  await mkdir(root, { recursive: true })
  await ensureProjectSkeleton(root)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** 每个用例从干净的项目开始，源样本留在项目外 */
beforeEach(async () => {
  for (const dir of [PROJECT_DIRS.photos, PROJECT_DIRS.thumbnails, PROJECT_DIRS.derivedHeic, PROJECT_DIRS.scratch]) {
    await rm(path.join(root, dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  await rm(path.join(root, PROJECT_DIRS.derivedPreview), { recursive: true, force: true })
  await rm(path.join(root, PROJECT_DIRS.derivedPrint), { recursive: true, force: true })
  await rm(path.join(root, PROJECT_DIRS.export), { recursive: true, force: true })
  await ensureProjectSkeleton(root)
})

const namesOf = async (dir: string): Promise<string[]> => (await readdir(dir)).sort()

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false)

/** 判别联合在断言前先收窄：kind 不对就直接把整个联合摊出来给失败信息 */
type ImportedResult = Extract<ImportOutcome, { kind: 'imported' }>

function imported(outcome: ImportOutcome): ImportedResult {
  if (outcome.kind !== 'imported') throw new Error(`期望 imported，实际是 ${JSON.stringify(outcome)}`)
  return outcome
}

const request = (files: readonly string[], overrides: Partial<Parameters<typeof importPhotos>[0]> = {}) =>
  importPhotos({
    root,
    files,
    duplicatePolicy: 'ask',
    existingHashes: new Set(),
    signal: neverAborted,
    ...overrides
  })

describe('导入落盘', () => {
  it('JPEG 与 PNG：字节级原样落 photos/，缩略图进 thumbnails/，文档字段齐全', async () => {
    const jpeg = await writeSample(sources, 'IMG_0001.jpg', {
      format: 'jpeg',
      width: 640,
      height: 480,
      seed: 1,
      exif: { dateTimeOriginal: '2024:10:01 09:30:00', camera: { make: 'Canon', model: 'EOS R5' } }
    })
    const png = await writeSample(sources, '截图 01.png', { format: 'png', width: 300, height: 400, seed: 2 })

    const result = imported(await request([jpeg, png]))

    expect(result.failures).toEqual([])
    expect(result.photos).toHaveLength(2)
    const [first, second] = result.photos
    expect(first?.fileName).toBe('IMG_0001.jpg')
    expect(first?.bytes).toBe((await readFile(jpeg)).length)
    expect(first?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(first?.camera).toBe('Canon EOS R5')
    expect(first?.takenAt).not.toBeNull()
    expect(first?.sourcePath).toBe(jpeg)
    expect(first?.description).toEqual({ blocks: [] })
    expect(second?.fileName).toBe('截图 01.png')
    expect(second?.takenAt).toBeNull()
    expect(second?.camera).toBeNull()
    expect(second?.displayWidth).toBe(300)
    expect(second?.displayHeight).toBe(400)
    for (const photo of result.photos) {
      expect(photoSchema.safeParse(photo).success, JSON.stringify(photo)).toBe(true)
      expect(photo.aspect).toBeCloseTo(photo.displayWidth / photo.displayHeight, 6)
      expect(formatFromFileName(photo.fileName)).not.toBeNull()
    }

    const original = await readFile(path.join(root, PROJECT_DIRS.photos,first!.fileName))
    expect(original.equals(await readFile(jpeg))).toBe(true)
    expect(await namesOf(path.join(root, PROJECT_DIRS.photos))).toEqual([first!.fileName, second!.fileName].sort())
    expect(await namesOf(path.join(root, PROJECT_DIRS.thumbnails))).toEqual(
      [`${first!.id}.jpg`, `${second!.id}.jpg`].sort()
    )
    expect(result.warnings).toEqual([])
    expect(await namesOf(path.join(root, PROJECT_DIRS.scratch))).toEqual([])
  }, 30_000)

  it('缩略图是摆正后的 JPEG 长边档，HEIC 之外不需要 derived/', async () => {
    const source = await writeSample(sources, '横拍竖显.jpg', {
      format: 'jpeg',
      width: 1200,
      height: 800,
      orientation: 6,
      seed: 3
    })

    const result = imported(await request([source]))
    const photo = result.photos[0]!

    expect(photo.encodedWidth).toBe(1200)
    expect(photo.encodedHeight).toBe(800)
    expect(photo.orientation).toBe(6)
    expect(photo.displayWidth).toBe(800)
    expect(photo.displayHeight).toBe(1200)

    const thumb = await sharp(path.join(root, PROJECT_DIRS.thumbnails, `${photo.id}.jpg`)).metadata()
    expect(thumb.format).toBe('jpeg')
    expect((thumb.height ?? 0)).toBeGreaterThan(thumb.width ?? 0)
    expect(Math.max(thumb.width ?? 0, thumb.height ?? 0)).toBe(THUMBNAIL.longEdgePx)
    expect(await exists(path.join(root, PROJECT_DIRS.derivedHeic, `${photo.id}.jpg`))).toBe(false)
  })

  it('原图超过 40MP：只记警告，photos/ 里仍是全尺寸原图（AGENTS.md §5.6）', async () => {
    const source = await writeSample(sources, '超大图.jpg', { format: 'jpeg', width: 9000, height: 5000, seed: 4 })

    const result = imported(await request([source]))
    const photo = result.photos[0]!

    expect(photo.encodedWidth * photo.encodedHeight).toBeGreaterThan(IMAGE_PIPELINE.maxPixels)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.sourceFile).toBe(source)
    expect(result.warnings[0]?.message).toContain('40')
    expect(await sharp(path.join(root, PROJECT_DIRS.photos,photo.fileName)).metadata()).toMatchObject({ width: 9000, height: 5000 })
  }, 60_000)

  it('同名文件不覆盖：第二张落盘加计数后缀（D-14）', async () => {
    const first = await writeSample(path.join(sources, 'A'), 'IMG_1.jpg', { format: 'jpeg', width: 200, height: 200, seed: 5 })
    const second = await writeSample(path.join(sources, 'B'), 'IMG_1.jpg', { format: 'jpeg', width: 200, height: 200, seed: 6 })

    const result = imported(await request([first, second]))

    expect(result.photos.map((photo) => photo.fileName)).toEqual(['IMG_1.jpg', 'IMG_1 (2).jpg'])
    expect(await exists(path.join(root, PROJECT_DIRS.photos,'IMG_1 (2).jpg'))).toBe(true)
  })

  it('缓存目录被用户删掉也要能导入（AGENTS.md §5.5 缺失即重建）', async () => {
    await rm(path.join(root, PROJECT_DIRS.thumbnails), { recursive: true, force: true })
    const source = await writeSample(sources, '重建.jpg', { format: 'jpeg', width: 200, height: 200, seed: 7 })

    const result = imported(await request([source]))

    expect(result.failures).toEqual([])
    expect(await exists(path.join(root, PROJECT_DIRS.thumbnails, `${result.photos[0]!.id}.jpg`))).toBe(true)
  })
})

describe('逐个失败，不阻断整批', () => {
  it('扩展名不在白名单、无扩展名、文件不存在：各自报错，其余照常导入', async () => {
    const txt = path.join(sources, '说明.txt')
    await writeFile(txt, '不是图片')
    const noExtension = path.join(sources, 'README')
    await writeFile(noExtension, 'x')
    const good = await writeSample(sources, '正常.jpg', { format: 'jpeg', width: 200, height: 200, seed: 8 })

    const result = imported(await request([txt, noExtension, path.join(sources, '不存在.jpg'), good]))

    expect(result.photos.map((photo) => photo.fileName)).toEqual(['正常.jpg'])
    expect(result.failures.map((failure) => failure.sourceFile)).toEqual([txt, noExtension, path.join(sources, '不存在.jpg')])
    expect(result.failures[0]?.reason).toContain('格式')
    expect(result.failures[1]?.reason).toContain('格式')
    expect(result.failures[2]?.reason).toContain('读取')
    expect(await namesOf(path.join(root, PROJECT_DIRS.photos))).toEqual(['正常.jpg'])
    expect(await namesOf(path.join(root, PROJECT_DIRS.scratch))).toEqual([])
  })

  it('扩展名与内容不符：拒绝，而不是到解码阶段才说不清坏在哪', async () => {
    const lyingPng = await writeSample(sources, '谎报.png', { format: 'jpeg', width: 100, height: 100, seed: 10 })
    const lyingJpeg = await writeSample(sources, '谎报.jpg', { format: 'png', width: 100, height: 100, seed: 11 })

    const result = imported(await request([lyingPng, lyingJpeg]))

    expect(result.photos).toEqual([])
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]?.reason).toContain('不一致')
    expect(await namesOf(path.join(root, PROJECT_DIRS.photos))).toEqual([])
  })

  it('截断的 JPEG：拷贝与探测都能过，编码阶段失败并留下原因，项目内零残留', async () => {
    const truncated = await writeTruncatedSample(sources, '断掉的.jpg')

    const result = imported(await request([truncated]))

    expect(result.photos).toEqual([])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.sourceFile).toBe(truncated)
    expect(result.failures[0]?.reason.length).toBeGreaterThan(0)
    expect(await namesOf(path.join(root, PROJECT_DIRS.photos))).toEqual([])
    expect(await namesOf(path.join(root, PROJECT_DIRS.thumbnails))).toEqual([])
    expect(await namesOf(path.join(root, PROJECT_DIRS.scratch))).toEqual([])
  })

  it('HEIC 在准入阶段就被拒绝：一个字节也不写（总体设计稿 §10.1 挂账 T3-HEIC）', async () => {
    const fake = await writeFakeHeic(sources, '实况主图.heic')

    const result = imported(await request([fake]))

    expect(result.photos).toEqual([])
    expect(result.failures[0]?.reason).toContain('HEIC')
    expect(await namesOf(path.join(root, PROJECT_DIRS.photos))).toEqual([])
    expect(await namesOf(path.join(root, PROJECT_DIRS.thumbnails))).toEqual([])
    expect(await namesOf(path.join(root, PROJECT_DIRS.derivedHeic))).toEqual([])
    expect(await namesOf(path.join(root, PROJECT_DIRS.scratch))).toEqual([])
  })

  it('非图片文件（内容认不出魔数）报错', async () => {
    const random = path.join(sources, '随机字节.jpg')
    await writeFile(random, Buffer.alloc(COPY_CHUNK_BYTES + 10, 3))

    const result = imported(await request([random]))

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.reason).toContain('格式')
  })
})

describe('哈希去重', () => {
  it('policy=ask：命中已有哈希时在拷贝前返回重复清单，项目内一个字节的半成品都不落', async () => {
    const kept = await writeSample(sources, '新的.jpg', { format: 'jpeg', width: 200, height: 200, seed: 12 })
    const dupe = path.join(sources, '旧的.jpg')
    await writeFile(dupe, await readFile(kept))
    const hash = imported(await request([kept])).photos[0]!.hash
    const thumbnailsBefore = await namesOf(path.join(root, PROJECT_DIRS.thumbnails))

    const outcome = await request([dupe], { existingHashes: new Set([hash]) })

    expect(outcome).toEqual({
      kind: 'duplicates',
      duplicates: [{ sourceFile: dupe, hash, duplicateOf: { kind: 'existing' } }]
    })
    expect(await namesOf(path.join(root, PROJECT_DIRS.photos))).toEqual(['新的.jpg'])
    expect(await namesOf(path.join(root, PROJECT_DIRS.thumbnails))).toEqual(thumbnailsBefore)
    expect(await namesOf(path.join(root, PROJECT_DIRS.scratch))).toEqual([])
  })

  it('policy=ask 也认同一批里的重复', async () => {
    const source = await writeSample(sources, '同一张.jpg', { format: 'jpeg', width: 200, height: 200, seed: 13 })
    const twin = path.join(sources, '同一张-副本.jpg')
    await writeFile(twin, await readFile(source))

    const outcome = await request([source, twin])

    if (outcome.kind !== 'duplicates') throw new Error('应当报重复')
    expect(outcome.duplicates).toEqual([
      { sourceFile: twin, hash: outcome.duplicates[0]!.hash, duplicateOf: { kind: 'batch', sourceFile: source } }
    ])
  })

  it('policy=skip：重复的记进 skipped，其余照常导入', async () => {
    const registered = await writeSample(sources, '已在册.jpg', { format: 'jpeg', width: 200, height: 200, seed: 14 })
    const hash = imported(await request([registered])).photos[0]!.hash
    const copy = path.join(sources, '已在册-副本.jpg')
    await writeFile(copy, await readFile(registered))
    const fresh = await writeSample(sources, '新图.jpg', { format: 'jpeg', width: 200, height: 200, seed: 16 })

    const result = imported(
      await request([fresh, copy], { duplicatePolicy: 'skip', existingHashes: new Set([hash]) })
    )

    expect(result.photos.map((photo) => photo.fileName)).toEqual(['新图.jpg'])
    expect(result.skipped).toEqual([{ sourceFile: copy, hash, duplicateOf: { kind: 'existing' } }])
    expect(await namesOf(path.join(root, PROJECT_DIRS.photos))).toEqual(['已在册.jpg', '新图.jpg'])
  })

  it('policy=keep：同哈希的两张各自成一条照片，id 与落盘名互不相同', async () => {
    const original = await writeSample(sources, '就要重复.jpg', { format: 'jpeg', width: 200, height: 200, seed: 15 })
    const hash = imported(await request([original])).photos[0]!.hash
    const twin = path.join(sources, '就要重复-副本.jpg')
    await writeFile(twin, await readFile(original))
    const twin2 = path.join(sources, '就要重复-副本2.jpg')
    await writeFile(twin2, await readFile(original))

    const result = imported(
      await request([twin, twin2], { duplicatePolicy: 'keep', existingHashes: new Set([hash]) })
    )

    expect(result.photos).toHaveLength(2)
    expect(new Set(result.photos.map((photo) => photo.id)).size).toBe(2)
    expect(new Set(result.photos.map((photo) => photo.fileName)).size).toBe(2)
    expect(result.photos.every((photo) => photo.hash === hash)).toBe(true)
    expect(result.skipped).toEqual([])
  })
})

describe('进度与取消', () => {
  it('每个文件完成都推进度，phase 覆盖 hash 与 derive', async () => {
    const files = await Promise.all(
      [1, 2, 3].map((seed) => writeSample(sources, `进度-${seed}.jpg`, { format: 'jpeg', width: 200, height: 200, seed }))
    )
    const progress: ImportProgress[] = []

    const result = imported(await request(files, { onProgress: (value) => progress.push(value) }))

    expect(result.photos).toHaveLength(3)
    const phases = new Set(progress.map((value) => value.phase))
    expect(phases).toEqual(new Set(['hash', 'derive']))
    expect(Math.max(...progress.map((value) => value.total))).toBe(3)
    expect(Math.max(...progress.map((value) => value.done))).toBe(3)
    for (const value of progress) {
      expect(value.done).toBeLessThanOrEqual(value.total)
      expect(files).toContain(value.currentFile)
    }
  })

  it('取消：抛 AbortError，photos/、thumbnails/、.tmp/ 全空', async () => {
    const files = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((seed) =>
        writeSample(sources, `取消-${seed}.jpg`, { format: 'jpeg', width: 400, height: 400, seed })
      )
    )
    const controller = new AbortController()
    const seen: ImportProgress[] = []

    const pending = request(files, {
      signal: controller.signal,
      onProgress: (value) => {
        seen.push(value)
        if (seen.filter((item) => item.phase === 'derive').length >= 1) controller.abort()
      }
    })

    await expect(pending).rejects.toThrowError(/abort/i)
    expect(await namesOf(path.join(root, PROJECT_DIRS.photos))).toEqual([])
    expect(await namesOf(path.join(root, PROJECT_DIRS.thumbnails))).toEqual([])
    expect(await namesOf(path.join(root, PROJECT_DIRS.scratch))).toEqual([])
  })

  it('批次为空：不报错、哪都不留东西', async () => {
    const result = imported(await request([]))

    expect(result).toMatchObject({ photos: [], failures: [], skipped: [], warnings: [] })
    expect(await namesOf(path.join(root, PROJECT_DIRS.scratch))).toEqual([])
  })
})
