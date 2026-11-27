import path from 'node:path'
import { BrowserWindow, app } from 'electron'
import { EDITOR_WINDOW, PRINT_WINDOW } from '@shared/domain/constants'

const preloadPath = path.join(__dirname, '../preload/index.js')

/**
 * 窗口与任务栏图标（自绘资产，源文件 `resources/icon/photozine.svg`）。
 * 开发期直接从仓库资源目录读；打包产物里的多帧 `.ico` 由 electron-builder 从这张 256 方图生成（T13）。
 */
const appIcon = path.join(__dirname, '../../resources/icon/photozine-256.png')

let editorWindow: BrowserWindow | null = null
let printWindow: BrowserWindow | null = null

/** 两个窗口共用同一套构造选项，避免安全配置与图标分叉（AGENTS.md §3.2） */
function buildOptions(extra: Pick<Electron.BrowserWindowConstructorOptions, 'width' | 'height'>) {
  return {
    ...extra,
    show: false,
    icon: appIcon,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  } satisfies Electron.BrowserWindowConstructorOptions
}

function loadRendererEntry(win: BrowserWindow, entry: string, query?: Record<string, string>): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const url = new URL(`${devUrl}/${entry}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value)
    }
    void win.loadURL(url.toString())
    return
  }
  void win.loadFile(path.join(__dirname, '../renderer', entry), { query })
}

export function createEditorWindow(): BrowserWindow {
  editorWindow = new BrowserWindow({
    ...buildOptions(EDITOR_WINDOW),
    minWidth: EDITOR_WINDOW.minWidth,
    minHeight: EDITOR_WINDOW.minHeight,
    title: 'PhotoZine'
  })

  editorWindow.once('ready-to-show', () => editorWindow?.show())
  editorWindow.on('closed', () => {
    editorWindow = null
  })

  loadRendererEntry(editorWindow, 'index.html')
  return editorWindow
}

export function getEditorWindow(): BrowserWindow | null {
  return editorWindow
}

/**
 * 打印窗口每次重建：上一份版面绝不复用，
 * 这是导出结果与当前文档一致的前提（总体设计稿 §6）。
 */
export function createPrintWindow(pages: number): BrowserWindow {
  printWindow?.destroy()

  printWindow = new BrowserWindow({
    ...buildOptions(PRINT_WINDOW),
    title: 'PhotoZine · 打印渲染',
    // 未打包时显示出来，便于肉眼确认版面渲染；正式构建中离屏渲染
    show: !app.isPackaged
  })

  printWindow.on('closed', () => {
    printWindow = null
  })

  loadRendererEntry(printWindow, 'print/index.html', { pages: String(pages) })
  return printWindow
}

export function getPrintWindow(): BrowserWindow | null {
  return printWindow
}

export function closePrintWindow(): void {
  printWindow?.close()
  printWindow = null
}
