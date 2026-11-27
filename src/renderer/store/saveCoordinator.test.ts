import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_SAVE } from '@shared/domain/constants'
import { makeDocument, makePhotoList } from '@shared/domain/project/__fixtures__/document'
import type { ProjectDocument } from '@shared/domain/project/schema'
import type { OpenOutcome, SaveOutcome } from '@shared/ipc/contract'

/**
 * 自动落盘的唯一通路（总体设计稿 §7 保存策略）：这里 mock 的是 `api/project`，
 * 它本身就是 IPC 边界（AGENTS.md §2.2），store 与协调器都用真实实现。
 */

const { saveProject } = vi.hoisted(() => ({
  saveProject: vi.fn<(root: string, document: ProjectDocument) => Promise<SaveOutcome>>()
}))
vi.mock('../api/project', () => ({
  saveProject: (root: string, document: ProjectDocument) => saveProject(root, document)
}))

const ROOT = 'D:/项目/夏日纪行'

const opened = (document: ProjectDocument, readOnlyReason: string | null = null): OpenOutcome => ({
  kind: 'opened',
  project: { root: ROOT, document, fixes: [], warnings: [], missingPhotoIds: [], readOnlyReason }
})

async function setup(document: ProjectDocument, readOnlyReason: string | null = null) {
  vi.resetModules()
  const store = await import('./projectSession')
  const coordinator = await import('./saveCoordinator')
  store.useProjectSession.getState().applyOpenOutcome(opened(document, readOnlyReason))
  const session = () => store.useProjectSession.getState().session
  const edit = (next: ProjectDocument) => store.useProjectSession.getState().replaceDocument(next)
  return { coordinator, session, edit }
}

beforeEach(() => {
  vi.useFakeTimers()
  saveProject.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('requestSave', () => {
  it('防抖窗口内的多次修改合并成一次落盘，写的是最后一次的内容', async () => {
    const initial = makeDocument({ photos: [] })
    const docB = makeDocument({ photos: makePhotoList(1) })
    const docC = makeDocument({ photos: makePhotoList(2) })
    const { coordinator, session, edit } = await setup(initial)
    saveProject.mockResolvedValue({ kind: 'saved', document: docC } satisfies SaveOutcome)

    edit(docB)
    coordinator.requestSave()
    edit(docC)
    coordinator.requestSave()
    expect(saveProject).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(PROJECT_SAVE.debounceMs)
    expect(saveProject).toHaveBeenCalledTimes(1)
    expect(saveProject.mock.lastCall?.[0]).toBe(ROOT)
    expect(saveProject.mock.lastCall?.[1]).toEqual(docC)
    expect(session()?.dirty).toBe(false)
    expect(session()?.saveState.kind).toBe('saved')
  })

  it('保存失败保留未保存状态，并把"下一步怎么办"如实写进状态', async () => {
    const initial = makeDocument()
    const next = makeDocument({ photos: makePhotoList(1) })
    const { coordinator, session, edit } = await setup(initial)
    saveProject.mockResolvedValue({ kind: 'refused', reason: '该项目已在别处打开，当前窗口只能查看' } satisfies SaveOutcome)

    edit(next)
    coordinator.requestSave()
    await vi.advanceTimersByTimeAsync(PROJECT_SAVE.debounceMs)

    expect(session()?.dirty).toBe(true)
    expect(session()?.saveState).toEqual({ kind: 'error', reason: '该项目已在别处打开，当前窗口只能查看' })
  })

  it('磁盘文件被外部改动时不覆盖，报出冲突而不是静默写入', async () => {
    const { coordinator, session, edit } = await setup(makeDocument())
    saveProject.mockResolvedValue({ kind: 'conflict', diskMtimeMs: 1 } satisfies SaveOutcome)
    edit(makeDocument({ photos: makePhotoList(1) }))
    coordinator.requestSave()
    await vi.advanceTimersByTimeAsync(PROJECT_SAVE.debounceMs)

    const state = session()?.saveState
    expect(state?.kind).toBe('error')
    if (state?.kind === 'error') expect(state.reason).toContain('外部')
    expect(session()?.dirty).toBe(true)
  })

  it('保存途中又发生修改：完成后继续把最新内容写下去', async () => {
    const initial = makeDocument({ photos: [] })
    const submitted = makeDocument({ photos: makePhotoList(1) })
    const late = makeDocument({ photos: makePhotoList(2) })
    saveProject.mockReset()
    const { coordinator, session, edit } = await setup(initial)
    saveProject
      .mockImplementationOnce(async () => {
        edit(late)
        coordinator.requestSave()
        return { kind: 'saved', document: submitted } satisfies SaveOutcome
      })
      .mockResolvedValue({ kind: 'saved', document: late } satisfies SaveOutcome)

    edit(submitted)
    coordinator.requestSave()
    await vi.advanceTimersByTimeAsync(PROJECT_SAVE.debounceMs * 2)

    expect(saveProject).toHaveBeenCalledTimes(2)
    expect(saveProject.mock.lastCall?.[1]).toEqual(late)
    expect(session()?.dirty).toBe(false)
    expect(session()?.document).toEqual(late)
  })

  it('只读会话与没有改动的会话都不落盘', async () => {
    const readOnly = await setup(makeDocument(), '该项目已经在另一个窗口里打开')
    readOnly.edit(makeDocument({ photos: makePhotoList(1) }))
    readOnly.coordinator.requestSave()

    const clean = await setup(makeDocument())
    clean.coordinator.requestSave()

    await vi.advanceTimersByTimeAsync(PROJECT_SAVE.debounceMs * 2)
    expect(saveProject).not.toHaveBeenCalled()
  })
})

describe('flushSave', () => {
  it('关闭项目前立即落盘，不等防抖窗口', async () => {
    const next = makeDocument({ photos: makePhotoList(1) })
    const { coordinator, session, edit } = await setup(makeDocument())
    saveProject.mockResolvedValue({ kind: 'saved', document: next } satisfies SaveOutcome)

    edit(next)
    coordinator.requestSave()
    await coordinator.flushSave()

    expect(saveProject).toHaveBeenCalledTimes(1)
    expect(session()?.dirty).toBe(false)

    await vi.advanceTimersByTimeAsync(PROJECT_SAVE.debounceMs)
    expect(saveProject).toHaveBeenCalledTimes(1)
  })

  it('没有待写内容时不产生多余的写盘', async () => {
    const { coordinator } = await setup(makeDocument())
    await coordinator.flushSave()
    expect(saveProject).not.toHaveBeenCalled()
  })
})
