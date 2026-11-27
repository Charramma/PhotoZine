import { create } from 'zustand'
import type { OpenOutcome, OpenedProject } from '@shared/ipc/contract'
import type { Issue } from '@shared/domain/project/invariants'
import type { ProjectDocument } from '@shared/domain/project/schema'

/**
 * 编辑器会话里的文档状态（AGENTS.md §4.3）：
 * 只有这一份文档，别的界面元素一律从它派生；改它只走 `replaceDocument`。
 *
 * 撤销栈与命令队列在 T12 落地，届时 `replaceDocument` 的唯一调用方就是命令队列 ——
 * 现在留出这个写入口，是为了避免 T12 再把各处散落的赋值收拢一遍。
 */

export interface ProjectSession {
  root: string
  document: ProjectDocument
  /** 抢锁失败或锁被接管：常驻提示，任何写入都被主进程拒绝（总体设计稿 D-12） */
  readOnlyReason: string | null
  /** 打开时的自动修复项与告知项，界面列出来由用户决定是否保存（禁止静默改用户文件） */
  notices: Issue[]
  /** 原图已不在 `photos/` 里的照片（I-06），排版时临时摘除 */
  missingPhotoIds: string[]
  dirty: boolean
}

interface SessionStore {
  session: ProjectSession | null
  applyOpenOutcome(outcome: OpenOutcome): void
  closeSession(): void
  replaceDocument(document: ProjectDocument): void
  markSaved(document: ProjectDocument): void
}

const toSession = (project: OpenedProject): ProjectSession => ({
  root: project.root,
  document: project.document,
  readOnlyReason: project.readOnlyReason,
  notices: [...project.fixes, ...project.warnings],
  missingPhotoIds: project.missingPhotoIds,
  dirty: false
})

export const useProjectSession = create<SessionStore>((set, get) => ({
  session: null,

  applyOpenOutcome: (outcome) => {
    set({ session: outcome.kind === 'opened' ? toSession(outcome.project) : null })
  },

  closeSession: () => set({ session: null }),

  replaceDocument: (document) => {
    const session = get().session
    if (session === null) return
    set({ session: { ...session, document, dirty: true } })
  },

  markSaved: (document) => {
    const session = get().session
    if (session === null) return
    set({ session: { ...session, document, dirty: false } })
  }
}))
