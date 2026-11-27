import { z } from 'zod'
import { issueSchema } from '@shared/domain/project/invariants'
import {
  forwardCompatibleDocumentSchema,
  photoSchema,
  projectDocumentSchema,
  sha256Schema
} from '@shared/domain/project/schema'

/**
 * IPC 契约的唯一来源：主进程实现、预加载桥、渲染进程调用都从这里取类型，
 * 任何一侧都不允许出现裸对象跨进程传输（AGENTS.md §3.4）。
 *
 * 会进出血流的数据形状（照片项、判定结果、项目文档）一律复用 `shared/domain` 里的
 * zod 定义，这里只组合、不重述，避免"传输层放行、领域层拒绝"的分叉。
 */

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
  electron: z.string(),
  chrome: z.string(),
  userDataPath: z.string(),
  packaged: z.boolean()
})
export type AppInfo = z.infer<typeof appInfoSchema>

/* ---------------------------------- 项目 ---------------------------------- */

/** 打开成功后交给界面的全部状态：文档 + 需要用户确认的修复项 + 只读降级原因 */
export const openedProjectSchema = z.object({
  root: z.string(),
  document: projectDocumentSchema,
  /** 打开时自动修复的项，界面需列出并由用户确认后才写盘（禁止静默改用户文件） */
  fixes: z.array(issueSchema),
  warnings: z.array(issueSchema),
  /** 原图文件已不在 `photos/` 内的照片（I-06），排版时临时摘除 */
  missingPhotoIds: z.array(z.string()),
  readOnlyReason: z.string().nullable()
})
export type OpenedProject = z.infer<typeof openedProjectSchema>

export const projectOpenOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('opened'), project: openedProjectSchema }),
  z.object({ kind: z.literal('not-a-project') }),
  z.object({ kind: z.literal('already-open') }),
  /** 文件版本高于应用：只读展示内容，不加锁也不建会话，绝不写回（FR-PROJ-02） */
  z.object({
    kind: z.literal('newer-version'),
    root: z.string(),
    version: z.number().int(),
    document: forwardCompatibleDocumentSchema
  }),
  /** 主文件与备份都无法判读：不加载文档，只给恢复指引，且不覆盖任何文件 */
  z.object({ kind: z.literal('corrupt'), errors: z.array(issueSchema), inspected: z.array(z.string()) })
])
export type OpenOutcome = z.infer<typeof projectOpenOutcomeSchema>

export const projectSaveOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), document: projectDocumentSchema }),
  z.object({ kind: z.literal('rejected'), errors: z.array(issueSchema) }),
  z.object({ kind: z.literal('refused'), reason: z.string() }),
  z.object({ kind: z.literal('not-open') }),
  /** 磁盘上的文件不是我们上次写下的那份：外部改动，由界面决定重载还是覆盖 */
  z.object({ kind: z.literal('conflict'), diskMtimeMs: z.number() })
])
export type SaveOutcome = z.infer<typeof projectSaveOutcomeSchema>

/* ---------------------------------- 导入 ---------------------------------- */

/** 命中重复哈希时的处置：`ask` 让界面先问用户，`skip` 丢弃，`keep` 照旧导入 */
export const duplicatePolicySchema = z.enum(['ask', 'skip', 'keep'])
export type DuplicatePolicy = z.infer<typeof duplicatePolicySchema>

/** 与之重复的对象：已有照片由界面按 `hash` 回查序号，本批内的重复直接点名文件 */
export const duplicateOfSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing') }),
  z.object({ kind: z.literal('batch'), sourceFile: z.string() })
])
export type DuplicateOf = z.infer<typeof duplicateOfSchema>

export const duplicateHitSchema = z.object({
  sourceFile: z.string(),
  hash: sha256Schema,
  duplicateOf: duplicateOfSchema
})
export type DuplicateHit = z.infer<typeof duplicateHitSchema>

export const importFailureSchema = z.object({ sourceFile: z.string(), reason: z.string() })
export type ImportFailure = z.infer<typeof importFailureSchema>

export const importWarningSchema = z.object({ sourceFile: z.string(), message: z.string() })
export type ImportWarning = z.infer<typeof importWarningSchema>

const importDuplicatesVariant = z.object({
  kind: z.literal('duplicates'),
  duplicates: z.array(duplicateHitSchema)
})

const importPhotosVariant = z.object({
  kind: z.literal('imported'),
  photos: z.array(photoSchema),
  failures: z.array(importFailureSchema),
  skipped: z.array(duplicateHitSchema),
  warnings: z.array(importWarningSchema)
})

/** 导入管线本身的结果：要么先要用户表态，要么落了照片（可能附带逐个失败项） */
export const importOutcomeSchema = z.discriminatedUnion('kind', [importDuplicatesVariant, importPhotosVariant])
export type ImportOutcome = z.infer<typeof importOutcomeSchema>

const importRefusedVariant = z.object({
  /** 项目没打开或处于只读降级：一个字节的写入都不允许发生（AGENTS.md §3.6） */
  kind: z.literal('refused'),
  reason: z.string()
})

/** 跨进程返回给界面的导入结果 */
export const photoImportResultSchema = z.discriminatedUnion('kind', [
  importDuplicatesVariant,
  importPhotosVariant,
  importRefusedVariant
])
export type PhotoImportResult = z.infer<typeof photoImportResultSchema>

export const photoImportInputSchema = z.object({
  /** 一次导入的身份：进度事件与取消都按它配对，界面自己生成（UUID） */
  requestId: z.uuid(),
  root: z.string().min(1),
  /** 用户选中的源文件绝对路径，顺序即导入顺序 */
  files: z.array(z.string().min(1)).min(1),
  duplicatePolicy: duplicatePolicySchema,
  /** 文档里已有的照片哈希，去重提示据此给出；顺序真值仍在界面侧，这里只当索引用 */
  existingHashes: z.array(sha256Schema)
})
export type PhotoImportInput = z.infer<typeof photoImportInputSchema>

export const photoImportProgressSchema = z.object({
  requestId: z.uuid(),
  total: z.number().int().min(1),
  done: z.number().int().min(0),
  currentFile: z.string(),
  phase: z.enum(['hash', 'derive'])
})
export type PhotoImportProgress = z.infer<typeof photoImportProgressSchema>

/** 应用菜单里由界面负责执行的命令：菜单只发意图，具体流程仍归各面板自己 */
export const menuCommandSchema = z.enum(['open-project', 'import-photos', 'close-project'])
export type MenuCommand = z.infer<typeof menuCommandSchema>

/* ---------------------------------- 通道 ---------------------------------- */

/** 请求—响应通道 */
export const invokeContract = {
  'app:get-info': {
    input: z.void(),
    output: appInfoSchema
  },
  'print-window:open': {
    input: z.object({ pages: z.number().int().min(1).max(24) }),
    output: z.object({ windowId: z.number().int() })
  },
  /** 打印窗口自身上报"版面已渲染完成"，主进程据此广播给编辑器窗口 */
  'print-window:report-ready': {
    input: z.object({ pages: z.number().int().min(1) }),
    output: z.void()
  },
  'print-window:close': {
    input: z.void(),
    output: z.void()
  },
  /** 原生文件夹选择器：界面碰不到 `node:*`，只能请主进程代问（AGENTS.md §3.1） */
  'dialog:pick-project-folder': {
    input: z.void(),
    output: z.object({ root: z.string().nullable() })
  },
  /** 原生文件选择器，只放行导入格式 */
  'dialog:pick-photos': {
    input: z.void(),
    output: z.object({ files: z.array(z.string()) })
  },
  'project:open': {
    input: z.object({ root: z.string().min(1) }),
    output: projectOpenOutcomeSchema
  },
  'project:close': {
    input: z.object({ root: z.string().min(1) }),
    output: z.void()
  },
  'project:save': {
    input: z.object({ root: z.string().min(1), document: projectDocumentSchema }),
    output: projectSaveOutcomeSchema
  },
  'photo:import': {
    input: photoImportInputSchema,
    output: photoImportResultSchema
  },
  'photo:import-cancel': {
    input: z.object({ requestId: z.uuid() }),
    output: z.object({ cancelled: z.boolean() })
  }
} as const

/** 主进程 → 渲染进程事件通道 */
export const eventContract = {
  'print-window:ready': z.object({
    windowId: z.number().int(),
    pages: z.number().int(),
    at: z.string()
  }),
  /** 导入进度走事件流，界面侧禁止轮询（AGENTS.md §3.4） */
  'photo:import-progress': photoImportProgressSchema,
  'menu:command': z.object({ command: menuCommandSchema })
} as const

export type InvokeChannel = keyof typeof invokeContract
export type InvokeInput<C extends InvokeChannel> = z.infer<(typeof invokeContract)[C]['input']>
export type InvokeOutput<C extends InvokeChannel> = z.infer<(typeof invokeContract)[C]['output']>
export type EventChannel = keyof typeof eventContract
export type EventPayload<C extends EventChannel> = z.infer<(typeof eventContract)[C]>

/** preload 暴露到 `window.pz` 的桥接口 */
export interface PzBridge {
  invoke<C extends InvokeChannel>(channel: C, input?: InvokeInput<C>): Promise<InvokeOutput<C>>
  onEvent<C extends EventChannel>(channel: C, handler: (payload: EventPayload<C>) => void): () => void
  /**
   * 拖进窗口的文件 → 磁盘绝对路径（Electron ≥32 起 `File.path` 已移除，只能经 `webUtils` 取）。
   *
   * 形参写成 `unknown` 是因为本文件同时被无 DOM 的 Node 侧类型检查，`File` 在那边不存在；
   * 预加载实现里收窄成 `File`，取不到路径（非磁盘文件、外链拖入）返回 null 由界面拒绝。
   */
  sourcePathOfDroppedFile(file: unknown): string | null
}
