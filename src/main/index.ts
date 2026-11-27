import { app, shell } from 'electron'
import { PZFILE_ROOT_APP, PZFILE_SCHEME } from '@shared/domain/constants'
import { grantPzfileRoot, registerPzfileScheme, setupPzfileProtocol } from './fs/pzfile'
import { registerIpcHandlers } from './ipc'
import { setupApplicationMenu } from './menu'
import { createEditorWindow, getEditorWindow } from './windows'

// 特权协议声明必须在 app ready 之前完成
registerPzfileScheme()

if (!app.requestSingleInstanceLock()) {
  // 已有实例：第二次启动只做聚焦，绝不并发打开同一项目（需求文档 FR-DATA-01）
  app.quit()
} else {
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()

  if (process.platform === 'win32') {
    app.setAppUserModelId('com.photozine.desktop')
  }

  // 开发期只授权应用自身目录，用于验证协议与越界拦截；项目根由打开项目的流程在持有项目锁后授权
  grantPzfileRoot(PZFILE_ROOT_APP, app.getAppPath())
  setupPzfileProtocol()
  registerIpcHandlers()
  setupApplicationMenu()
  createEditorWindow()

  app.on('second-instance', () => {
    const editor = getEditorWindow()
    if (!editor) return
    if (editor.isMinimized()) editor.restore()
    editor.focus()
  })

  app.on('web-contents-created', (_event, contents) => {
    // 任何窗口都不得开新窗口，跳出本地内容一律拒绝（AGENTS.md §3.2）
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      if (!isLocalContent(url)) event.preventDefault()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

/** 允许停留的目标：Vite 开发服务器、打包后的本地页面、pzfile 协议与调试工具 */
function isLocalContent(url: string): boolean {
  const devBase = process.env['ELECTRON_RENDERER_URL']
  if (devBase && url.startsWith(devBase)) return true
  if (url.startsWith(`${PZFILE_SCHEME}:`)) return true
  if (url.startsWith('devtools://') || url.startsWith('chrome-extension://')) return true
  return url.startsWith('file://') && url.includes('/renderer/')
}
