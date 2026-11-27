import type { OpenOutcome, SaveOutcome } from '@shared/ipc/contract'
import type { ProjectDocument } from '@shared/domain/project/schema'
import { useProjectSession } from '../store/projectSession'

/** 项目相关的跨进程调用（AGENTS.md §4.4：组件里不出现通道名） */

export function pickProjectFolder(): Promise<{ root: string | null }> {
  return window.pz.invoke('dialog:pick-project-folder')
}

export function openProject(root: string): Promise<OpenOutcome> {
  return window.pz.invoke('project:open', { root })
}

export function closeProject(root: string): Promise<void> {
  return window.pz.invoke('project:close', { root })
}

export function saveProject(root: string, document: ProjectDocument): Promise<SaveOutcome> {
  return window.pz.invoke('project:save', { root, document })
}

/**
 * 会话镜像：项目锁与 `pzfile` 授权根都在主进程手里，所以"打开了哪个项目"由它定调，
 * 这里把它广播的结果写进 store —— 界面组件因此不需要自己维护会话状态，
 * 从哪个入口打开（对话框、菜单、将来的最近项目）都同一条路生效。
 */
export function startSessionMirror(): void {
  window.pz.onEvent('project:session', (outcome) => useProjectSession.getState().applyOpenOutcome(outcome))
  window.pz.onEvent('project:closed', () => useProjectSession.getState().closeSession())
}
