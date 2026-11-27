import { IMAGE_PIPELINE } from '@shared/domain/constants'
import type { PhotoImportInput, PhotoImportResult } from '@shared/ipc/contract'
import { requireWriteAccess } from '../fs/projectStore'
import { rootKey } from '../fs/projectPath'
import { importPhotos, type ImportProgress } from './importPhotos'
import { throttleProgress } from './imagePipeline'

/**
 * 在途导入的身份表（AGENTS.md §3.4）：进度用事件流推给界面，取消用 `AbortController` 传进管线，
 * 界面既不轮询也不共享状态 —— 请求 id 由界面生成，主进程只登记与查表。
 *
 * 同一项目同时只允许一趟导入：落盘名的唯一性是在导入开始时一次性预留的，
 * 两趟并发就会挑中同一个 `photos/` 名字，后提交的那张会把前一张覆盖掉。
 */
interface RunningJob {
  /** 项目根的身份键（`rootKey`）：同一目录的不同写法算同一趟导入 */
  key: string
  controller: AbortController
}

const running = new Map<string, RunningJob>()

export async function runPhotoImport(
  input: PhotoImportInput,
  onProgress: (progress: ImportProgress) => void
): Promise<PhotoImportResult> {
  const access = requireWriteAccess(input.root)
  if (access.kind === 'denied') return { kind: 'refused', reason: access.reason }

  const key = rootKey(access.root)
  if ([...running.values()].some((job) => job.key === key)) {
    return { kind: 'refused', reason: '这个项目已有一批照片在导入，请等它结束再试' }
  }

  const controller = new AbortController()
  running.set(input.requestId, { key, controller })
  const progress = throttleProgress(onProgress, IMAGE_PIPELINE.progressThrottleMs)
  try {
    return await importPhotos({
      root: access.root,
      files: input.files,
      duplicatePolicy: input.duplicatePolicy,
      existingHashes: new Set(input.existingHashes),
      signal: controller.signal,
      onProgress: progress.push
    })
  } finally {
    progress.close()
    running.delete(input.requestId)
  }
}

/** 取消在途导入；返回是否真的找到这趟导入（界面据此判断它是不是已经自己结束了） */
export function cancelPhotoImport(requestId: string): boolean {
  const job = running.get(requestId)
  if (job === undefined) return false
  job.controller.abort()
  return true
}
