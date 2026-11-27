import { z } from 'zod'
import { ASPECT_EPSILON, DEFAULT_FOCUS } from '../constants'
import { projectDocumentSchema, type ProjectDocument, type SlotItem } from './schema'

/**
 * 数据不变式（总体设计稿 §3 表格）。
 * 形状由 `schema.ts` 负责，这里只处理"形状合法但语义不一致"的情况：
 * 能自动修复的记入 `fixes`，由界面在用户确认后才写盘（禁止静默改用户文件）。
 */

/** 版式声明中与校验有关的部分，几何与样式仍由模板配置决定（D-08） */
export interface PatternSpec {
  slotCount: number
  textCount: number
  allowRepeat: boolean
}

/** 模板注册表在 T6 落地，校验器通过它取版式声明，不依赖模板文件本身 */
export type PatternLookup = (patternId: string) => PatternSpec | undefined

/** 一条判定结果：路径 + 人话说明（跨进程也用它，见 `ipc/contract.ts`） */
export const issueSchema = z.object({ path: z.string(), message: z.string() })
export type Issue = z.infer<typeof issueSchema>

export interface ProjectReport {
  status: 'valid' | 'fixed' | 'invalid'
  document: ProjectDocument | null
  /** 已自动修复的项，需要用户确认后才写盘 */
  fixes: Issue[]
  /** 不改动数据的告知项 */
  warnings: Issue[]
  /** 拒绝打开的原因 */
  errors: Issue[]
}

const emptySlot = (): SlotItem => ({ photoId: null, focus: { x: DEFAULT_FOCUS, y: DEFAULT_FOCUS } })

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

function findDuplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id)
    else seen.add(id)
  }
  return [...duplicates]
}

/** 未知字段：读取时忽略并记录，写盘时由契约解析剔除（总体设计稿 §3） */
export function collectUnknownFields(raw: unknown): Issue[] {
  const issues: Issue[] = []
  walkSchema(raw, projectDocumentSchema, [], issues)
  return issues
}

/**
 * 沿契约走一遍原始 JSON，把契约里不存在的键记为告警。
 * schema 是唯一的字段清单来源，因此这里不做第二份白名单（SSOT）。
 */
function walkSchema(value: unknown, schema: unknown, path: string[], out: Issue[]): void {
  if (!(schema instanceof z.ZodType)) return
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    walkSchema(value, schema.unwrap(), path, out)
    return
  }
  if (Array.isArray(value) && schema instanceof z.ZodArray) {
    value.forEach((item, index) => walkSchema(item, schema.element, [...path, `${index}`], out))
    return
  }
  if (value !== null && typeof value === 'object' && schema instanceof z.ZodObject) {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const inner: unknown = schema.shape[key]
      if (inner === undefined) {
        out.push({ path: [...path, key].join('.'), message: '未知字段已剔除' })
      } else {
        walkSchema(record[key], inner, [...path, key], out)
      }
    }
  }
}

/**
 * 逐条断言不变式。
 * I-06（原图文件是否存在）需要文件系统，由 `projectStore` 在打开时执行。
 */
export function validateProject(raw: unknown, lookupPattern: PatternLookup): ProjectReport {
  const parsed = projectDocumentSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      status: 'invalid',
      document: null,
      fixes: [],
      warnings: [],
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    }
  }

  const document = parsed.data
  const fixes: Issue[] = []
  const warnings: Issue[] = collectUnknownFields(raw)
  const errors: Issue[] = []

  const duplicatePhotoIds = findDuplicates(document.photos.map((photo) => photo.id))
  if (duplicatePhotoIds.length > 0) {
    errors.push({ path: 'photos', message: `照片标识重复：${duplicatePhotoIds.join('、')}（I-02）` })
  }
  const duplicatePageIds = findDuplicates(document.pages.map((page) => page.id))
  if (duplicatePageIds.length > 0) {
    errors.push({ path: 'pages', message: `页面标识重复：${duplicatePageIds.join('、')}（I-02）` })
  }
  if (errors.length > 0) {
    return { status: 'invalid', document: null, fixes, warnings, errors }
  }

  const knownPhotoIds = new Set(document.photos.map((photo) => photo.id))

  // I-07：aspect 与显示宽高一致
  for (const photo of document.photos) {
    const expected = photo.displayWidth / photo.displayHeight
    if (Math.abs(expected - photo.aspect) > ASPECT_EPSILON) {
      photo.aspect = expected
      fixes.push({ path: `photos.${photo.id}`, message: '宽高比与显示尺寸不一致，已重算（I-07）' })
    }
  }

  // I-05：封面引用有效
  if (document.meta.coverPhotoId !== null && !knownPhotoIds.has(document.meta.coverPhotoId)) {
    document.meta.coverPhotoId = null
    fixes.push({ path: 'meta.coverPhotoId', message: '封面照片不存在，已清空（I-05）' })
  }

  for (const [pageIndex, page] of document.pages.entries()) {
    const at = `pages[${pageIndex}]`
    const spec = lookupPattern(page.patternId)
    let referenceInvalidated = false

    if (spec === undefined) {
      warnings.push({
        path: `${at}.patternId`,
        message: `版式 ${page.patternId} 不在当前模板内，该页需重排（I-08）`
      })
    }

    // I-03：引用失效的槽位清空，引用失效的文字块移除
    for (const slot of page.slots) {
      if (slot.photoId !== null && !knownPhotoIds.has(slot.photoId)) {
        slot.photoId = null
        referenceInvalidated = true
        fixes.push({ path: `${at}.slots`, message: '槽位引用的照片不存在，已清空（I-03）' })
      }
    }
    const droppedTexts = page.texts.filter(
      (text) => text.kind === 'photo-description' && !knownPhotoIds.has(text.photoId)
    )
    if (droppedTexts.length > 0) {
      page.texts = page.texts.filter(
        (text) => !(text.kind === 'photo-description' && !knownPhotoIds.has(text.photoId))
      )
      referenceInvalidated = true
      fixes.push({ path: `${at}.texts`, message: `文字块引用的照片不存在，已移除 ${droppedTexts.length} 块（I-03）` })
    }

    // 同页文字块标识必须唯一，否则无法与版式声明对应
    const duplicateTextKeys = findDuplicates(page.texts.map((text) => text.key))
    if (duplicateTextKeys.length > 0) {
      const kept = new Set<string>()
      page.texts = page.texts.filter((text) => {
        if (kept.has(text.key)) return false
        kept.add(text.key)
        return true
      })
      fixes.push({
        path: `${at}.texts`,
        message: `同页文字块标识重复：${duplicateTextKeys.join('、')}，已保留首个（I-08）`
      })
    }

    // I-04：同页不重复同一照片（版式显式允许除外）
    if (spec === undefined || !spec.allowRepeat) {
      const used = new Set<string>()
      for (const slot of page.slots) {
        if (slot.photoId === null) continue
        if (used.has(slot.photoId)) {
          slot.photoId = null
          referenceInvalidated = true
          fixes.push({ path: `${at}.slots`, message: '同页重复引用同一照片，已清除后者（I-04）' })
        } else {
          used.add(slot.photoId)
        }
      }
    }

    // I-08：数量对齐放在引用与去重之后，保证修复结果与版式声明一致
    if (spec !== undefined) {
      if (page.slots.length > spec.slotCount) {
        const removed = page.slots.length - spec.slotCount
        page.slots.length = spec.slotCount
        fixes.push({ path: `${at}.slots`, message: `槽位数多于版式声明，已裁去 ${removed} 项（I-08）` })
      }
      const missingSlots = spec.slotCount - page.slots.length
      if (missingSlots > 0) {
        for (let index = 0; index < missingSlots; index += 1) page.slots.push(emptySlot())
        fixes.push({ path: `${at}.slots`, message: `槽位数少于版式声明，已补 ${missingSlots} 个空槽（I-08）` })
      }
      if (page.texts.length > spec.textCount) {
        page.texts.length = spec.textCount
        fixes.push({ path: `${at}.texts`, message: '文字块数多于版式声明，已裁去多余项（I-08）' })
      }
      if (page.texts.length < spec.textCount) {
        warnings.push({ path: `${at}.texts`, message: '文字块数少于版式声明，缺失块留空（I-08）' })
      }
    }

    if (page.locked && referenceInvalidated) {
      page.locked = false
      fixes.push({ path: `${at}.locked`, message: '该页因引用失效被调整，已解除锁定并重排（I-03）' })
    }

    // I-09：裁切视点与缩放范围
    for (const [slotIndex, slot] of page.slots.entries()) {
      const x = clamp01(slot.focus.x)
      const y = clamp01(slot.focus.y)
      if (x !== slot.focus.x || y !== slot.focus.y) {
        slot.focus = { x, y }
        fixes.push({ path: `${at}.slots[${slotIndex}].focus`, message: '裁切视点超出 0–1，已收敛（I-09）' })
      }
      if (slot.zoom !== undefined && slot.zoom < 1) {
        slot.zoom = 1
        fixes.push({ path: `${at}.slots[${slotIndex}].zoom`, message: '缩放小于 1，已置为 1（I-09）' })
      }
    }
  }

  return {
    status: fixes.length > 0 ? 'fixed' : 'valid',
    document,
    fixes,
    warnings,
    errors
  }
}
