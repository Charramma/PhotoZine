import { create } from 'zustand'

/**
 * 编辑器的"当前操作目标"（AGENTS.md §4.3）：选中哪张照片不只一个面板要读
 * （列表高亮、键位表、后续的属性面板与描述编辑器），所以不留在组件内部；
 * 它又不是文档内容，所以不进 `projectSession`。
 *
 * 不随项目关闭清空：照片标识是 UUID，换项目后旧标识必然落不到任何一张照片上，
 * 读取方一律按"找不到就是没选中"处理。
 */

interface EditorUiStore {
  selectedPhotoId: string | null
  selectPhoto(photoId: string | null): void
}

export const useEditorUi = create<EditorUiStore>((set) => ({
  selectedPhotoId: null,
  selectPhoto: (photoId) => set({ selectedPhotoId: photoId })
}))
