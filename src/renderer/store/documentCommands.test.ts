import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenOutcome } from '@shared/ipc/contract'
import { makeDocument, makePhotoList } from '@shared/domain/project/__fixtures__/document'
import type { ProjectDocument } from '@shared/domain/project/schema'
import { applyDocumentCommand } from './documentCommands'
import { useProjectSession } from './projectSession'

/**
 * 命令入口是文档的唯一写入口（AGENTS.md §4.3），落盘由它统一触发。
 * `saveCoordinator` 是它的下一层（再往下才是 IPC），这一层用 mock 隔开，store 用真实实现。
 */

const { requestSave } = vi.hoisted(() => ({ requestSave: vi.fn() }))
vi.mock('./saveCoordinator', () => ({ requestSave }))

const open = (document: ProjectDocument, readOnlyReason: string | null = null): void => {
  const outcome: OpenOutcome = {
    kind: 'opened',
    project: { root: 'D:/项目/夏日纪行', document, fixes: [], warnings: [], missingPhotoIds: [], readOnlyReason }
  }
  useProjectSession.getState().applyOpenOutcome(outcome)
}

const session = () => useProjectSession.getState().session

beforeEach(() => {
  requestSave.mockReset()
})

describe('applyDocumentCommand', () => {
  it('产生新文档时标脏并请求落盘', () => {
    const initial = makeDocument()
    open(initial)
    const next = makeDocument({ photos: makePhotoList(2) })

    expect(applyDocumentCommand(() => next)).toBe(true)
    expect(session()?.document).toBe(next)
    expect(session()?.dirty).toBe(true)
    expect(requestSave).toHaveBeenCalledTimes(1)
  })

  it('操作什么都没改时既不标脏也不写盘', () => {
    const initial = makeDocument()
    open(initial)

    expect(applyDocumentCommand(() => null)).toBe(false)
    expect(applyDocumentCommand((document) => document)).toBe(false)
    expect(session()?.dirty).toBe(false)
    expect(requestSave).not.toHaveBeenCalled()
  })

  it('只读会话拒绝写入（总体设计稿 D-12）', () => {
    open(makeDocument(), '该项目已经在另一个窗口里打开')
    expect(applyDocumentCommand(() => makeDocument({ photos: makePhotoList(1) }))).toBe(false)
    expect(session()?.dirty).toBe(false)
    expect(requestSave).not.toHaveBeenCalled()
  })

  it('没有会话时静默返回，不抛错打断界面', () => {
    useProjectSession.getState().closeSession()
    expect(applyDocumentCommand(() => makeDocument())).toBe(false)
  })
})
