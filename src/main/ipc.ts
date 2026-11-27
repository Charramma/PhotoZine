import { app, dialog, ipcMain } from 'electron'
import { PZFILE_ROOT_PROJECT } from '@shared/domain/constants'
import { PICKABLE_EXTENSIONS } from '@shared/domain/photo/imageFormat'
import {
  eventContract,
  invokeContract,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeInput,
  type InvokeOutput
} from '@shared/ipc/contract'
import { cancelPhotoImport, runPhotoImport } from './image/importJobs'
import { closeProject, openProject, saveProject } from './fs/projectStore'
import { grantPzfileRoot, revokePzfileRoot } from './fs/pzfile'
import { closePrintWindow, createPrintWindow, getEditorWindow } from './windows'

interface HandleContext {
  senderId: number
  /** 把事件送回发起这次调用的窗口：导入进度属于发起方，不该广播给别的窗口 */
  emit<C extends EventChannel>(channel: C, payload: EventPayload<C>): void
}

/**
 * 注册请求—响应通道。入站按契约解析，出站同样解析后再返回，
 * 使"渲染进程拿到的形状"与契约不可能分叉（AGENTS.md §3.4）。
 */
function handle<C extends InvokeChannel>(
  channel: C,
  resolver: (input: InvokeInput<C>, context: HandleContext) => InvokeOutput<C> | Promise<InvokeOutput<C>>
): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    const contract = invokeContract[channel]
    // 按 channel 索引得到的契约对象是联合类型，此处收窄回该通道对应的输入输出类型
    const input = contract.input.parse(raw) as InvokeInput<C>
    const context: HandleContext = {
      senderId: event.sender.id,
      emit: <C2 extends EventChannel>(next: C2, payload: EventPayload<C2>): void => {
        if (event.sender.isDestroyed()) return
        event.sender.send(next, eventContract[next].parse(payload))
      }
    }
    const output = await resolver(input, context)
    return contract.output.parse(output) as InvokeOutput<C>
  })
}

function notifyEditor<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
  const editor = getEditorWindow()
  if (!editor || editor.isDestroyed()) return
  editor.webContents.send(channel, eventContract[channel].parse(payload))
}

/** 原生对话框：编辑器窗口在就以它为父窗口，界面不被阻塞（AGENTS.md §3.5） */
async function askOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  const owner = getEditorWindow()
  return owner && !owner.isDestroyed() ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)
}

/** 所有图片扩展名摊平成一个列表，供文件选择器过滤；由导入准入表派生，白名单只此一份（AGENTS.md §2.2） */

export function registerIpcHandlers(): void {
  handle('app:get-info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    userDataPath: app.getPath('userData'),
    packaged: app.isPackaged
  }))

  handle('print-window:open', ({ pages }) => ({ windowId: createPrintWindow(pages).id }))

  handle('print-window:report-ready', ({ pages }, context) => {
    notifyEditor('print-window:ready', { windowId: context.senderId, pages, at: new Date().toISOString() })
  })

  handle('print-window:close', () => {
    closePrintWindow()
  })

  handle('dialog:pick-project-folder', async () => {
    const picked = await askOpenDialog({
      title: '选择项目文件夹',
      buttonLabel: '选择',
      properties: ['openDirectory']
    })
    return { root: picked.canceled ? null : (picked.filePaths[0] ?? null) }
  })

  handle('dialog:pick-photos', async () => {
    const picked = await askOpenDialog({
      title: '选择照片',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '照片', extensions: [...PICKABLE_EXTENSIONS] }]
    })
    return { files: picked.canceled ? [] : picked.filePaths }
  })

  // 模板注册表在 T6 落地；在那之前所有 patternId 都算未知版式，按 I-08 只告警、不猜槽位数
  handle('project:open', async ({ root }) => {
    const outcome = await openProject(root, () => undefined)
    if (outcome.kind === 'opened') grantPzfileRoot(PZFILE_ROOT_PROJECT, outcome.project.root)
    // 会话由主进程定调，编辑器窗口镜像它：谁发起打开都一样，界面不自己记一份
    notifyEditor('project:session', outcome)
    return outcome
  })

  handle('project:close', async ({ root }) => {
    await closeProject(root)
    revokePzfileRoot(PZFILE_ROOT_PROJECT)
    notifyEditor('project:closed', { root })
  })

  handle('project:save', async ({ root, document }) => saveProject(root, document))

  handle('photo:import', (input, context) =>
    runPhotoImport(input, (progress) =>
      context.emit('photo:import-progress', { requestId: input.requestId, ...progress })
    )
  )

  handle('photo:import-cancel', ({ requestId }) => ({ cancelled: cancelPhotoImport(requestId) }))
}
