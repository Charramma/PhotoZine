import { z } from 'zod'
import { normalizeNameSegment } from '@shared/fs/relativePath'
import { DESCRIPTION_MAX_CHARS, PAGE_SIZE_KEYS, PROJECT_NAME_MAX_LENGTH } from '../constants'

/**
 * `project.json` 的唯一真值：校验器与类型同源（AGENTS.md §5.1）。
 * 本文件只定义**形状**；跨字段的语义约束（不变式 I-01…I-10）在 `invariants.ts`，
 * 单位、路径与空值约定的决策见总体设计稿 §3。
 */

export const PROJECT_SCHEMA_VERSION = 1

/** 实体标识：一律 UUID，落盘与跨进程传输同受约束 */
const idSchema = z.uuid('标识符格式不正确')

/**
 * 项目内存储的文件名：`photos/` 下的单个名字。
 * 与协议侧共用同一套词法规则（`normalizeNameSegment`），避免出现"协议允许、契约不允许"两套判定。
 */
const storedFileNameSchema = z
  .string()
  .refine((value) => normalizeNameSegment(value) !== null, '文件名不合法：必须是单个名字，不得含路径分隔符、Windows 非法字符或以点号/空格结尾')

/** 落盘时间戳：ISO 8601 UTC，与 `Date.toISOString()` 同形 */
const timestampSchema = z.iso.datetime()

/** sha256 十六进制串：照片内容哈希与导入去重共用这一条规则，不在别处再写一遍正则 */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, '哈希必须是 64 位十六进制 sha256')

/**
 * 项目名就是项目文件夹名，与"单个名字"是同一条规则：复用 `normalizeNameSegment`，
 * 不另写一份字符集，避免"契约放行、磁盘拒绝"的分叉（AGENTS.md §5.3、FR-PROJ-01）。
 */
export const projectNameSchema = z
  .string()
  .trim()
  .min(1, '项目名不能为空')
  .max(PROJECT_NAME_MAX_LENGTH, `项目名不得超过 ${PROJECT_NAME_MAX_LENGTH} 个字符`)
  .refine((value) => normalizeNameSegment(value) !== null, '项目名必须是单个名字，不得含路径分隔符、Windows 非法字符或以点号/空格结尾')

/* ---------------------------------- 富文本 ---------------------------------- */

/** 能力集严格等于 PDF 能力集（D-07）：段落、粗体、斜体、对齐、段内软换行 */
export const textRunSchema = z.object({
  text: z.string().min(1, '文本片段不能为空'),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  /** 该片段前有一个软换行 */
  breakBefore: z.boolean().optional()
})
export type TextRun = z.infer<typeof textRunSchema>

export const textBlockSchema = z.object({
  /** 缺省即左对齐，不落盘以控制文件体积 */
  align: z.enum(['left', 'center', 'right']).optional(),
  runs: z.array(textRunSchema).min(1, '段落至少包含一个文本片段')
})
export type TextBlock = z.infer<typeof textBlockSchema>

export const richTextSchema = z.object({
  blocks: z.array(textBlockSchema)
})
export type RichText = z.infer<typeof richTextSchema>

/** 正文字符数：描述上限与容量提示的口径（FR-DESC-01） */
export function countCharacters(text: RichText): number {
  let total = 0
  for (const block of text.blocks) {
    for (const run of block.runs) total += run.text.length
  }
  return total
}

export const boundedRichTextSchema = richTextSchema.superRefine((value, context) => {
  const chars = countCharacters(value)
  if (chars > DESCRIPTION_MAX_CHARS) {
    context.addIssue({
      code: 'custom',
      path: ['blocks'],
      message: `描述共 ${chars} 字，超过 ${DESCRIPTION_MAX_CHARS} 字上限`
    })
  }
})

/* ---------------------------------- 照片项 ---------------------------------- */

/** 派生值不落盘：格式由 `fileName` 扩展名得出，是否缺失由打开时的文件系统检查得出（D-09） */
export const photoSchema = z.object({
  id: idSchema,
  /** `photos/` 内的实际存储名，由导入流程保证唯一（D-14） */
  fileName: storedFileNameSchema,
  /** 仅用于展示，任何逻辑不得依赖（总体设计稿 §3） */
  sourcePath: z.string().nullable(),
  bytes: z.int().min(0),
  hash: sha256Schema,
  takenAt: timestampSchema.nullable(),
  camera: z.string().nullable(),
  /** 显示尺寸：EXIF 方向摆正后的宽高，排版几何只用它（AGENTS.md §6.3） */
  displayWidth: z.int().min(1),
  displayHeight: z.int().min(1),
  /** 编码尺寸与 EXIF 方向：只在重建派生图时使用（AGENTS.md §6.3） */
  encodedWidth: z.int().min(1),
  encodedHeight: z.int().min(1),
  orientation: z.int().min(1).max(8),
  /** 派生自显示尺寸，允许被不变式 I-07 重算，故形状层不加范围约束 */
  aspect: z.number().finite(),
  starred: z.boolean().optional(),
  /** 章节预留位（总体设计稿 §12），M1 无写入口 */
  sectionId: z.string().nullable().optional(),
  description: boundedRichTextSchema
})
export type PhotoItem = z.infer<typeof photoSchema>

/* ---------------------------------- 页面 ---------------------------------- */

export const slotSchema = z.object({
  /** 未填的显式 null 只允许出现在允许空槽的版式（总体设计稿 §3 空值约定） */
  photoId: idSchema.nullable(),
  fit: z.enum(['cover', 'contain']).optional(),
  /** 取值范围与缩放下限由不变式 I-09 收敛，不在形状层直接拒绝，保证可自动修复 */
  focus: z.object({ x: z.number().finite(), y: z.number().finite() }),
  /** 预留位（D-10），M1 恒为 1 */
  zoom: z.number().finite().optional()
})
export type SlotItem = z.infer<typeof slotSchema>

const pageTextCommon = {
  /** 版式内文字块的稳定标识，几何与样式由模板决定（D-08） */
  key: z.string().min(1),
  /** 溢出降级链的实际生效结果，由排版写回供界面与导出摘要读取（§4.3） */
  overflowApplied: z.enum(['none', 'shrink', 'promote', 'clip']).optional(),
  fontSizeUsed: z.number().positive().optional()
}

export const pageTextSchema = z.discriminatedUnion('kind', [
  z.object({ ...pageTextCommon, kind: z.literal('photo-description'), photoId: idSchema }),
  z.object({ ...pageTextCommon, kind: z.literal('meta'), metaField: z.enum(['name', 'subtitle']) })
])
export type PageText = z.infer<typeof pageTextSchema>

export const pageSchema = z.object({
  id: idSchema,
  patternId: z.string().min(1),
  /** 用户手动改过的页，自动排版不重排（FR-LAYOUT-02） */
  locked: z.boolean(),
  slots: z.array(slotSchema),
  texts: z.array(pageTextSchema)
})
export type PageItem = z.infer<typeof pageSchema>

/* ---------------------------------- 文档 ---------------------------------- */

export const projectMetaSchema = z.object({
  id: idSchema,
  name: projectNameSchema,
  subtitle: z.string().trim(),
  coverPhotoId: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
})
export type ProjectMeta = z.infer<typeof projectMetaSchema>

/** 页面设置的项目级唯一真值：导出侧读取它，不另存一份（FR-LAYOUT-04 / FR-EXPORT-03） */
export const layoutSchema = z.object({
  templateId: z.string().min(1),
  pageSize: z.enum(PAGE_SIZE_KEYS),
  showPageNumbers: z.boolean()
})
export type ProjectLayout = z.infer<typeof layoutSchema>

/**
 * GPS 与源路径不进契约：导入只保留排版需要的 EXIF 字段，派生图不带 EXIF，
 * 因此不存在"开关关闭后泄漏"的通路（总体设计稿 §6，AGENTS.md §5.10）。
 */
export const exportSettingsSchema = z.object({
  quality: z.enum(['screen', 'dpi300', 'original']),
  includeCover: z.boolean()
})
export type ExportSettings = z.infer<typeof exportSettingsSchema>

/** 文档形状；`schemaVersion` 由迁移器判定，故与最终校验器分开 */
const projectDocumentShape = {
  schemaVersion: z.int().min(1),
  meta: projectMetaSchema,
  layout: layoutSchema,
  export: exportSettingsSchema,
  photos: z.array(photoSchema),
  pages: z.array(pageSchema)
}

export const projectDocumentSchema = z.object({
  ...projectDocumentShape,
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION)
})
export type ProjectDocument = z.infer<typeof projectDocumentSchema>

/** 高于本应用版本的文件：只读展示用宽松形状，禁止写回（FR-PROJ-02） */
export const forwardCompatibleDocumentSchema = z.object(projectDocumentShape)
export type FutureProjectDocument = z.infer<typeof forwardCompatibleDocumentSchema>
