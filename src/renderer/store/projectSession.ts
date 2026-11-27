import { create } from 'zustand'
import type { OpenOutcome, OpenedProject } from '@shared/ipc/contract'
import type { Issue } from '@shared/domain/project/invariants'
import type { ProjectDocument } from '@shared/domain/project/schema'

/**
 * 编辑器会话里的文档状态（AGENTS.md §4.3）：
 * 只有这一份文档，别的界面元素一律从它派生；改它只走 `replaceDocument`，
 * 而 `replaceDocument` 的唯一调用方是命令入口 `documentCommands`（总体设计稿 D-20），
 * 落盘由它一并触发，成败记在 `saveState`（§7 保存策略）。
 *
 * 会话本身的建立与清除不在这里发起：真相在主进程，由 `api/project` 的镜像写入（D-21）。
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
  /** 落盘结果（需求文档 FR-EDIT-02）：`dirty` 表示"有改动还没写下去"，这里记"上次写成功/失败" */
  saveState: SaveState
}

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; reason: string }

interface SessionStore {
  session: ProjectSession | null
  applyOpenOutcome(outcome: OpenOutcome): void
  closeSession(): void
  replaceDocument(document: ProjectDocument): void
  /**
   * 确认落盘成功：只有"内存里还是提交时的那份"才把文档换成磁盘回写的内容并清脏标记；
   * 保存途中用户又改了，就只记一次成功，脏标记留给下一轮（总体设计稿 §7 保存策略）。
   */
  markSaved(submitted: ProjectDocument, saved: ProjectDocument): void
  markSaveFailed(reason: string): void
}

const toSession = (project: OpenedProject): ProjectSession => ({
  root: project.root,
  document: project.document,
  readOnlyReason: project.readOnlyReason,
  notices: [...project.fixes, ...project.warnings],
  missingPhotoIds: project.missingPhotoIds,
  dirty: false,
  saveState: { kind: 'idle' }
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

  markSaved: (submitted, saved) => {
    const session = get().session
    if (session === null) return
    const unchanged = session.document === submitted
    set({
      session: {
        ...session,
        document: unchanged ? saved : session.document,
        dirty: !unchanged,
        saveState: { kind: 'saved', at: Date.now() }
      }
    })
  },

  markSaveFailed: (reason) => {
    const session = get().session
    if (session === null) return
    set({ session: { ...session, dirty: true, saveState: { kind: 'error', reason } } })
  }
}))
