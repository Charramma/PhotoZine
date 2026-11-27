import type { DuplicatePolicy, PhotoImportProgress, PhotoImportResult } from '@shared/ipc/contract'

/**
 * 照片导入的跨进程调用（AGENTS.md §4.4）。
 *
 * 深度封装在这一层：请求身份、事件订阅与退订都由它管，界面只拿到
 * "一个可取消的任务 + 它的结果"，既不用轮询进度，也不会漏掉退订。
 */

export interface ImportJob {
  /** 取消时以 AbortError 结束；界面按"用户已取消"处理，不当故障报 */
  result: Promise<PhotoImportResult>
  cancel(): void
}

export function pickPhotoFiles(): Promise<{ files: string[] }> {
  return window.pz.invoke('dialog:pick-photos')
}

/** 拖进窗口的文件对应的磁盘路径；取不到（非本地文件）返回 null */
export function filePathOf(file: File): string | null {
  return window.pz.sourcePathOfDroppedFile(file)
}

export function importPhotos(options: {
  root: string
  files: readonly string[]
  duplicatePolicy: DuplicatePolicy
  /** 已有照片的哈希，用于"这张已经导入过"的提示；由界面从当前文档派生 */
  existingHashes: readonly string[]
  onProgress(progress: PhotoImportProgress): void
}): ImportJob {
  const requestId = crypto.randomUUID()
  const unsubscribe = window.pz.onEvent('photo:import-progress', (payload) => {
    if (payload.requestId === requestId) options.onProgress(payload)
  })

  return {
    result: window.pz
      .invoke('photo:import', {
        requestId,
        root: options.root,
        files: [...options.files],
        duplicatePolicy: options.duplicatePolicy,
        existingHashes: [...options.existingHashes]
      })
      .finally(unsubscribe),
    cancel: () => {
      void window.pz.invoke('photo:import-cancel', { requestId })
    }
  }
}
