import type { ProjectDocument } from '@shared/domain/project/schema'
import { requestSave } from './saveCoordinator'
import { useProjectSession } from './projectSession'

/**
 * 文档变更的唯一写入口（AGENTS.md §4.3）：任何改文档的操作都从这里过，改完就请求落盘。
 * 界面组件因此不需要知道 `project:save` 的存在，也不会出现"改了却没存"。
 *
 * `run` 返回 null 表示"这次操作什么都没改"（例如把照片拖回原位），于是既不标脏也不写盘。
 * T12 的撤销栈挂在这一处：届时在这里入栈快照，调用方无需改动。
 */
export function applyDocumentCommand(run: (document: ProjectDocument) => ProjectDocument | null): boolean {
  const store = useProjectSession.getState()
  const session = store.session
  if (session === null || session.readOnlyReason !== null) return false
  const next = run(session.document)
  if (next === null || next === session.document) return false
  store.replaceDocument(next)
  requestSave()
  return true
}
