import type { OpenOutcome, SaveOutcome } from '@shared/ipc/contract'
import type { ProjectDocument } from '@shared/domain/project/schema'

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
