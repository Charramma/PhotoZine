import { movePhotoInDocument } from '@shared/domain/project/ordering'
import type { KeyBinding } from './keymap'
import { applyDocumentCommand } from './store/documentCommands'
import { useEditorUi } from './store/editorUi'
import { useProjectSession } from './store/projectSession'

/**
 * 键位表（AGENTS.md §4.14、需求文档 FR-EDIT-03）：所有快捷键只在这一个文件里声明。
 * 键位处理一律读写 store，不依赖组件局部状态，因此焦点在列表内外都同样生效。
 */

/** 可移动目标的当前下标；只读会话、未打开项目、没选中或选中已消失都返回 -1 */
function movablePhotoIndex(): number {
  const session = useProjectSession.getState().session
  if (session === null || session.readOnlyReason !== null) return -1
  const selectedId = useEditorUi.getState().selectedPhotoId
  return session.document.photos.findIndex((photo) => photo.id === selectedId)
}

/** 键盘移动选中的照片（需求文档 FR-ORDER-01）：到头/到底时返回 null，不产生变更也不写盘 */
function moveSelectedPhoto(step: -1 | 1): void {
  const from = movablePhotoIndex()
  if (from < 0) return
  applyDocumentCommand((document) => movePhotoInDocument(document, from, from + step))
}

const photoMoveEnabled = (): boolean => movablePhotoIndex() >= 0

export const APP_KEY_BINDINGS: readonly KeyBinding[] = [
  { id: 'photo-move-up', keys: 'Alt+ArrowUp', enabled: photoMoveEnabled, run: () => moveSelectedPhoto(-1) },
  { id: 'photo-move-down', keys: 'Alt+ArrowDown', enabled: photoMoveEnabled, run: () => moveSelectedPhoto(1) }
]
