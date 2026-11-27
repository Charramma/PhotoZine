import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { COPY_CHUNK_BYTES, IMAGE_PIPELINE, PROJECT_DIRS } from '@shared/domain/constants'
import {
  SUPPORTED_FORMAT_HINT,
  admissionProblem,
  formatFromFileName,
  sniffImageFormat,
  type ImageFormat
} from '@shared/domain/photo/imageFormat'
import { userReason } from '@shared/domain/userError'
import type { PhotoItem } from '@shared/domain/project/schema'
import { sanitizeNameSegment } from '@shared/fs/relativePath'
import { ensureProjectSkeleton } from '../fs/projectLayout'
import { projectPath } from '../fs/projectPath'
import { writeHeicDerived, writeThumbnail } from './derive'
import { mapWithConcurrency } from './imagePipeline'
import { measureRasterGeometry, readSourceMetadata, type PhotoGeometry } from './probe'

import type {
  DuplicateHit,
  DuplicateOf,
  ImportFailure,
  ImportOutcome,
  ImportWarning,
  PhotoImportInput,
  PhotoImportProgress
} from '@shared/ipc/contract'

/**
 * 照片导入管线（总体设计稿 §4 importer、需求文档 FR-PHOTO-01）。
 *
 * 一趟导入分三个阶段，顺序是有讲究的：
 * 1. **指纹**：每个源文件只流式读一遍，同时得到字节数、文件头与 sha256；
 *    重复判定落在这趟之后，因此"要不要拷"在写任何字节之前就能回答。
 * 2. **暂存**：字节级拷进 `.tmp/<uuid>/` 并 fsync，回读校验与源一致后才派生
 *    （缩略图 / HEIC 解码图）。原图永不被改写，任何变换都只产出派生文件（AGENTS.md §5.6）。
 * 3. **提交**：整批处理完，把成功条目 `rename` 进正式目录 —— 崩溃或取消只会
 *    留下 `.tmp/` 里的半成品，正式目录里不会出现半个文件（总体设计稿 §7）。
 *
 * 单个文件的失败（坏文件、暂不放行的格式）只记进 `failures`，不阻断整批；
 * 环境级错误（磁盘写不进、重命名失败）直接抛出，让界面停下来而不是继续假装成功。
 */

/** 会跨进程的形状全部取自契约（AGENTS.md §3.4、§5.1），这里只补进程内的部分 */
export type { DuplicateHit, DuplicateOf, ImportFailure, ImportOutcome, ImportWarning }

/** 进度去掉 requestId 后的形状：请求身份属于传输层，管线只管"第几个文件、哪一趟" */
export type ImportProgress = Omit<PhotoImportProgress, 'requestId'>

export interface ImportPhotosRequest
  extends Omit<PhotoImportInput, 'requestId' | 'existingHashes' | 'files'> {
  /** 契约给的是可变数组；管线只读不写，这里按只读收 */
  files: readonly string[]
  /** 已有照片的哈希集合；第几张照片这类顺序信息留在界面，不在这里镜像一份 */
  existingHashes: ReadonlySet<string>
  signal: AbortSignal
  onProgress?: (progress: ImportProgress) => void
}

/** 流式读到的指纹：字节数、文件头与整文件 sha256 */
interface Fingerprint {
  bytes: number
  head: Uint8Array
  hash: string
}

type Step<T> = ({ ok: true; sourceFile: string } & T) | { ok: false; sourceFile: string; reason: string }

type HashStep = Step<{ fingerprint: Fingerprint; format: ImageFormat }>

/** 一条暂存记录：先落在 `.tmp/<uuid>/`，提交时整批 rename 进正式目录 */
interface Move {
  staged: string
  target: string
}

type StageStep = Step<{ photo: PhotoItem; moves: Move[]; warning: string | null }>

/** 文件头长度：够覆盖 jpeg/png/webp 的魔数与 HEIC 的 brand 字段 */
const HEAD_BYTES = 16

/**
 * 流式算 sha256：一次只持有 COPY_CHUNK_BYTES 的缓冲，不把整张原图读进内存
 * （40MP 原图解码后是上百 MB，批量导入更是一个都放不下）。
 */
async function fingerprintOf(file: string): Promise<Fingerprint> {
  const handle = await open(file, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
  const head = Buffer.alloc(HEAD_BYTES)
  let bytes = 0
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, COPY_CHUNK_BYTES, bytes)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      if (bytes < HEAD_BYTES) buffer.copy(head, bytes, 0, Math.min(bytesRead, HEAD_BYTES - bytes))
      bytes += bytesRead
    }
  } finally {
    await handle.close()
  }
  return { bytes, head: new Uint8Array(head.subarray(0, Math.min(bytes, HEAD_BYTES))), hash: hash.digest('hex') }
}

/** 字节级拷贝并算出写入内容的 sha256；落盘前 fsync，保证 rename 之后内容已在盘上 */
async function copyAndHash(source: string, target: string): Promise<string> {
  const from = await open(source, 'r')
  const to = await open(target, 'w')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
  let position = 0
  try {
    for (;;) {
      const { bytesRead } = await from.read(buffer, 0, COPY_CHUNK_BYTES, position)
      if (bytesRead === 0) break
      await to.write(buffer, 0, bytesRead)
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    await to.datasync()
  } finally {
    await to.close()
    await from.close()
  }
  return hash.digest('hex')
}

/** 落盘名：清洗源文件名并避开 `photos/` 里已有的名字，冲突时加 ` (2)` 计数（D-14） */
function reserveStorageName(sourceFile: string, occupied: Set<string>): string {
  const base = path.basename(sourceFile)
  const extension = path.extname(base)
  const stem = sanitizeNameSegment(base.slice(0, base.length - extension.length)) ?? 'photo'
  // 唯一性按大小写无关判定：Windows 文件系统本来就这样，避免 `A.jpg` 与 `a.jpg` 撞车
  let fileName = `${stem}${extension}`
  for (let index = 2; occupied.has(fileName.toLowerCase()); index += 1) {
    fileName = `${stem} (${index})${extension}`
  }
  occupied.add(fileName.toLowerCase())
  return fileName
}

export async function importPhotos(request: ImportPhotosRequest): Promise<ImportOutcome> {
  const { root, files, duplicatePolicy, existingHashes, signal, onProgress } = request
  // 缓存目录可以被用户随时删掉，导入前补齐（AGENTS.md §5.5）；`.tmp/` 里的旧半成品由打开项目时清扫
  await ensureProjectSkeleton(root)

  const total = files.length
  let done = 0
  const report = (currentFile: string, phase: ImportProgress['phase']): void => {
    done += 1
    onProgress?.({ total, done, currentFile, phase })
  }

  /* ---------------- 阶段 1：指纹与准入判定 ---------------- */

  const hashSteps = await mapWithConcurrency(
    files,
    async (sourceFile): Promise<HashStep> => {
      const step = await hashOne(sourceFile)
      report(sourceFile, 'hash')
      return step
    },
    signal
  )

  const failures: ImportFailure[] = []
  const skipped: DuplicateHit[] = []
  const duplicates: DuplicateHit[] = []
  const accepted: Extract<HashStep, { ok: true }>[] = []
  const batchHashes = new Map<string, string>()
  for (const step of hashSteps) {
    if (!step.ok) {
      failures.push({ sourceFile: step.sourceFile, reason: step.reason })
      continue
    }
    const { hash } = step.fingerprint
    const earlierInBatch = batchHashes.get(hash)
    let duplicateOf: DuplicateOf | null = null
    if (existingHashes.has(hash)) duplicateOf = { kind: 'existing' }
    else if (earlierInBatch !== undefined) duplicateOf = { kind: 'batch', sourceFile: earlierInBatch }

    if (duplicateOf !== null) {
      const hit: DuplicateHit = { sourceFile: step.sourceFile, hash, duplicateOf }
      // `ask` 一次问完整批：任何一个重复都不该先写进磁盘再问
      if (duplicatePolicy === 'ask') {
        duplicates.push(hit)
        continue
      }
      if (duplicatePolicy === 'skip') {
        skipped.push(hit)
        continue
      }
    } else {
      batchHashes.set(hash, step.sourceFile)
    }
    accepted.push(step)
  }

  if (duplicatePolicy === 'ask' && duplicates.length > 0) return { kind: 'duplicates', duplicates }

  /* ---------------- 阶段 2：暂存、校验、派生 ---------------- */

  const staging = projectPath(root, `${PROJECT_DIRS.scratch}/${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  const occupiedNames = new Set(
    (await readdir(projectPath(root, PROJECT_DIRS.photos)).catch((): string[] => [])).map((name) => name.toLowerCase())
  )
  const jobs = accepted.map((step) => ({ step, fileName: reserveStorageName(step.sourceFile, occupiedNames) }))
  done = 0

  try {
    const stageSteps = await mapWithConcurrency(
      jobs,
      async ({ step, fileName }): Promise<StageStep> => {
        const result = await stageOne(root, staging, step, fileName)
        report(step.sourceFile, 'derive')
        return result
      },
      signal
    )

    const photos: PhotoItem[] = []
    const warnings: ImportWarning[] = []
    const pending: Move[] = []
    for (const step of stageSteps) {
      if (!step.ok) {
        failures.push({ sourceFile: step.sourceFile, reason: step.reason })
        continue
      }
      photos.push(step.photo)
      pending.push(...step.moves)
      if (step.warning !== null) warnings.push({ sourceFile: step.sourceFile, message: step.warning })
    }

    /* ---------------- 阶段 3：提交 ---------------- */

    for (const move of pending) await rename(move.staged, move.target)
    return { kind: 'imported', photos, failures, skipped, warnings }
  } finally {
    // 无论成功、失败还是取消，暂存区都不该留下东西：正式目录里的文件全部来自 rename
    await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/** 阶段 1 的单文件判定：准入 → 指纹 → 内容格式与扩展名是否一致 */
async function hashOne(sourceFile: string): Promise<HashStep> {
  const extensionFormat = formatFromFileName(path.basename(sourceFile))
  if (extensionFormat === null) {
    return { ok: false, sourceFile, reason: `不支持的文件格式，只支持 ${SUPPORTED_FORMAT_HINT}` }
  }
  // 认得出来但暂不放行的格式（HEIC，总体设计稿 §10.1）在这里就挡住，给出可执行的说法
  const deferred = admissionProblem(extensionFormat)
  if (deferred !== null) return { ok: false, sourceFile, reason: deferred }
  let fingerprint: Fingerprint
  try {
    fingerprint = await fingerprintOf(sourceFile)
  } catch (error) {
    return { ok: false, sourceFile, reason: `无法读取文件：${userReason(error)}` }
  }
  const sniffed = sniffImageFormat(fingerprint.head)
  if (sniffed === null) return { ok: false, sourceFile, reason: '文件内容不是可识别的图片格式' }
  // 扩展名与内容必须一致：否则格式判定会分叉 —— 界面按扩展名选通路，解码器按内容失败
  if (sniffed !== extensionFormat) {
    return { ok: false, sourceFile, reason: `扩展名与内容不一致（写成 ${extensionFormat}，实际是 ${sniffed}）` }
  }
  return { ok: true, sourceFile, fingerprint, format: extensionFormat }
}

/** 阶段 2 的单文件处理：拷贝 → 校验 → 探测 → 派生，产物全留在暂存区 */
async function stageOne(
  root: string,
  staging: string,
  step: Extract<HashStep, { ok: true }>,
  fileName: string
): Promise<StageStep> {
  const { sourceFile, fingerprint, format } = step
  const photoId = randomUUID()
  const stagedOriginal = path.join(staging, `${photoId}${path.extname(sourceFile)}`)
  const stagedThumbnail = path.join(staging, `${photoId}.thumb.jpg`)
  const moves: Move[] = [
    { staged: stagedOriginal, target: projectPath(root, `${PROJECT_DIRS.photos}/${fileName}`) },
    { staged: stagedThumbnail, target: projectPath(root, `${PROJECT_DIRS.thumbnails}/${photoId}.jpg`) }
  ]

  try {
    if ((await copyAndHash(sourceFile, stagedOriginal)) !== fingerprint.hash) {
      return { ok: false, sourceFile, reason: '拷贝结果与源文件不一致，请重试或检查磁盘' }
    }
    const metadata = await readSourceMetadata(sourceFile)

    let geometry: PhotoGeometry
    // HEIC 通路保留但暂不放行（总体设计稿 §10.1 挂账 T3-HEIC）：准入表翻开前，`hashOne` 已在阶段 1 拦下 `.heic`
    if (format === 'heic') {
      const stagedDecoded = path.join(staging, `${photoId}.decoded.jpg`)
      const derived = await writeHeicDerived(stagedOriginal, {
        decoded: stagedDecoded,
        thumbnail: stagedThumbnail
      })
      moves.push({
        staged: stagedDecoded,
        target: projectPath(root, `${PROJECT_DIRS.derivedHeic}/${photoId}.jpg`)
      })
      geometry = derived.geometry
    } else {
      geometry = await measureRasterGeometry(sourceFile)
      await writeThumbnail(sourceFile, stagedThumbnail)
    }

    const { encodedWidth, encodedHeight, displayWidth, displayHeight, orientation } = geometry
    const pixels = encodedWidth * encodedHeight
    return {
      ok: true,
      sourceFile,
      moves,
      photo: {
        id: photoId,
        fileName,
        sourcePath: sourceFile,
        bytes: fingerprint.bytes,
        hash: fingerprint.hash,
        takenAt: metadata.takenAt,
        camera: metadata.camera,
        displayWidth,
        displayHeight,
        encodedWidth,
        encodedHeight,
        orientation,
        aspect: displayWidth / displayHeight,
        description: { blocks: [] }
      },
      warning:
        pixels > IMAGE_PIPELINE.maxPixels
          ? `原图 ${encodedWidth}×${encodedHeight}（${Math.round(pixels / 100_000) / 10}MP）超过 ${
              IMAGE_PIPELINE.maxPixels / 1_000_000
            }MP 上限，派生图按上限降采样，原图仍完整保留`
          : null
    }
  } catch (error) {
    const reason = userReason(error)
    return {
      ok: false,
      sourceFile,
      reason: format === 'heic' ? `HEIC 解码失败：${reason}` : `图片处理失败：${reason}`
    }
  }
}
