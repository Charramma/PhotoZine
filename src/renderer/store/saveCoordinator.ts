import { PROJECT_SAVE } from '@shared/domain/constants'
import { userReason } from '@shared/domain/userError'
import type { ProjectDocument } from '@shared/domain/project/schema'
import type { SaveOutcome } from '@shared/ipc/contract'
import { saveProject } from '../api/project'
import { useProjectSession } from './projectSession'

/**
 * 文档落盘的唯一通路（总体设计稿 §7 保存策略）：改动发生后防抖合并成一次写盘，
 * 关闭项目前用 `flushSave()` 立即收口。写盘本身由主进程串行队列保证不交错。
 *
 * 调用方只有命令入口（`documentCommands`）与项目会话关闭两处 —— 界面组件不自己碰 `project:save`，
 * 否则就会出现"改了却没存"和"两处各存各的"这两种分叉。
 */

interface Job {
  root: string
  document: ProjectDocument
}

/** 待写内容：防抖窗口内反复覆盖，只留最后一份 */
let target: Job | null = null
let timer: ReturnType<typeof setTimeout> | null = null
/** 串行尾：任何时刻最多一个写盘在途，后一次等前一次结束（与主进程队列同构） */
let tail: Promise<void> = Promise.resolve()

/** 只有"有改动且当前会话可写"才需要落盘；只读会话绝不再写（AGENTS.md §3.6） */
function snapshot(): Job | null {
  const session = useProjectSession.getState().session
  if (session === null || session.readOnlyReason !== null || !session.dirty) return null
  return { root: session.root, document: session.document }
}

function describeOutcome(outcome: SaveOutcome): string | null {
  switch (outcome.kind) {
    case 'saved':
      return null
    case 'rejected':
      return `项目文件校验未通过，未写入：${outcome.errors.map((error) => error.message).join('；')}`
    case 'refused':
      return outcome.reason
    case 'not-open':
      return '项目已经不在当前窗口里打开，改动没有写入'
    case 'conflict':
      return '磁盘上的项目文件被外部改动过，为避免覆盖你的文件没有写入，请重新打开项目'
  }
}

async function writeOut(job: Job): Promise<void> {
  const store = useProjectSession.getState()
  try {
    const outcome = await saveProject(job.root, job.document)
    const reason = describeOutcome(outcome)
    if (outcome.kind === 'saved') store.markSaved(job.document, outcome.document)
    else store.markSaveFailed(reason ?? '项目没有保存，原因未知')
  } catch (error) {
    store.markSaveFailed(userReason(error))
  }
}

async function pump(): Promise<void> {
  while (target !== null) {
    const job = target
    target = null
    await writeOut(job)
  }
}

function startPump(): void {
  tail = tail.then(pump)
}

/** 请求落盘：防抖窗口内的多次请求合并成一次，窗口从最后一次改动重新计时 */
export function requestSave(): void {
  const job = snapshot()
  if (job === null) return
  target = job
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    startPump()
  }, PROJECT_SAVE.debounceMs)
}

/** 立即把待写内容落盘（关闭项目前调用），返回时不再有未写的改动或已记下失败原因 */
export async function flushSave(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  const job = snapshot()
  if (job !== null) target = job
  startPump()
  await tail
}
