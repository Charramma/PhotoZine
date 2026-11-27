import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  eventContract,
  invokeContract,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeInput,
  type InvokeOutput,
  type PzBridge
} from '@shared/ipc/contract'

/** 渲染进程唯一能拿到的能力，其余 Electron API 一律不暴露（AGENTS.md §3.1） */
const bridge: PzBridge = {
  invoke<C extends InvokeChannel>(channel: C, input?: InvokeInput<C>): Promise<InvokeOutput<C>> {
    const contract = invokeContract[channel]
    const parsed = contract.input.parse(input)
    return ipcRenderer
      .invoke(channel, parsed)
      .then((raw: unknown) => contract.output.parse(raw)) as Promise<InvokeOutput<C>>
  },

  onEvent<C extends EventChannel>(channel: C, handler: (payload: EventPayload<C>) => void): () => void {
    const contract = eventContract[channel]
    const listener = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      handler(contract.parse(raw) as EventPayload<C>)
    }
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },

  sourcePathOfDroppedFile(file: unknown): string | null {
    try {
      // 拖拽进来的不全是磁盘文件（比如从网页拖的图片），取不到路径就交回 null 让界面拒绝
      return webUtils.getPathForFile(file as File) || null
    } catch {
      return null
    }
  }
}

contextBridge.exposeInMainWorld('pz', bridge)
