import type { MenuCommand } from '@shared/ipc/contract'

/**
 * 订阅应用菜单里的某一条命令：面板只认领自己实现的那条，
 * 菜单与界面之间因此不需要共享状态（AGENTS.md §4.4 组件内不写通道名）。
 */
export function onMenuCommand(command: MenuCommand, handler: () => void): () => void {
  return window.pz.onEvent('menu:command', (payload) => {
    if (payload.command === command) handler()
  })
}
