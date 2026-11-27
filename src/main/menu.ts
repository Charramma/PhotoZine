import { Menu, app, dialog, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/ipc/contract'
import { getEditorWindow } from './windows'

/**
 * 应用菜单：全中文（AGENTS.md §4.11），只放**当前真的能用**的命令。
 *
 * 三项与项目/照片相关的命令只向编辑器窗口发一个意图，具体流程仍由对应面板自己完成 ——
 * 菜单不重复实现选文件与写盘，也就不会与界面各存一份流程（总体设计稿 §2）。
 *
 * 这里刻意**没有**页面缩放项：`AGENTS.md §4.14` 的 `Ctrl+ +/-` 归 T10 的预览缩放，
 * 不是 Chromium 缩放；Chromium 缩放会改变 CSS 像素密度，直接污染 mm 版面与 `printToPDF` 的一致性。
 */
function sendCommand(command: MenuCommand): void {
  const editor = getEditorWindow()
  if (!editor || editor.isDestroyed()) return
  editor.webContents.send('menu:command', { command })
}

async function showAbout(): Promise<void> {
  await dialog.showMessageBox({
    type: 'info',
    title: '关于 PhotoZine',
    message: 'PhotoZine',
    detail: `版本 ${app.getVersion()}\n本地优先的个人杂志编辑器：照片与文字都存在项目文件夹里，默认不联网。`,
    buttons: ['好'],
    defaultId: 0,
    cancelId: 0
  })
}

export function setupApplicationMenu(): void {
  const development = !app.isPackaged

  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '打开项目文件夹…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open-project') },
        { label: '导入照片…', accelerator: 'CmdOrCtrl+Shift+I', click: () => sendCommand('import-photos') },
        { type: 'separator' },
        { label: '关闭项目', accelerator: 'CmdOrCtrl+Shift+W', click: () => sendCommand('close-project') },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'CmdOrCtrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '拷贝', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
        { label: '关闭窗口', accelerator: 'CmdOrCtrl+W', role: 'close' }
      ]
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 PhotoZine', click: () => void showAbout() }]
    }
  ]

  // 开发期才给重载与开发者工具：发布版里它们会丢弃未保存的文档，且不属于产品能力
  if (development) {
    template.splice(3, 0, {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' }
      ]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
