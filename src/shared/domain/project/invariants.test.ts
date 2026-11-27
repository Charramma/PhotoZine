import { describe, expect, it } from 'vitest'
import { makeDocument, makePhoto, PAGE_IDS, PHOTO_IDS } from './__fixtures__/document'
import { validateProject, type PatternLookup, type PatternSpec } from './invariants'
import { projectDocumentSchema, type PageItem } from './schema'

const patterns = new Map<string, PatternSpec>([
  ['cover', { slotCount: 1, textCount: 1, allowRepeat: false }],
  ['pair', { slotCount: 2, textCount: 0, allowRepeat: false }],
  ['two-texts', { slotCount: 1, textCount: 2, allowRepeat: false }],
  ['collage', { slotCount: 3, textCount: 0, allowRepeat: true }]
])
const lookup: PatternLookup = (patternId) => patterns.get(patternId)

const slot = (photoId: string | null): PageItem['slots'][number] => ({
  photoId,
  focus: { x: 0.5, y: 0.5 }
})

function page(patch: Partial<PageItem> = {}): PageItem {
  return {
    id: PAGE_IDS[0] as string,
    patternId: 'cover',
    locked: false,
    slots: [slot(PHOTO_IDS[0] as string)],
    texts: [{ key: 'title', kind: 'photo-description', photoId: PHOTO_IDS[0] as string }],
    ...patch
  }
}

describe('不变式校验', () => {
  it('合法文档不产生任何修复与告警', () => {
    const report = validateProject(makeDocument({ pages: [page()] }), lookup)
    expect(report.status).toBe('valid')
    expect(report.fixes).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.errors).toEqual([])
    expect(report.document?.pages[0]?.slots[0]?.photoId).toBe(PHOTO_IDS[0])
  })

  it('形状不合法时逐条报出字段路径（拒绝打开）', () => {
    const report = validateProject({ ...makeDocument(), photos: [{ id: 'x' }] }, lookup)
    expect(report.status).toBe('invalid')
    expect(report.document).toBeNull()
    expect(report.errors.length).toBeGreaterThan(0)
  })

  it('I-02 照片标识重复 → 拒绝打开并报出具体标识', () => {
    const report = validateProject(
      makeDocument({ photos: [makePhoto(0), makePhoto(0)] }),
      lookup
    )
    expect(report.status).toBe('invalid')
    expect(report.errors[0]?.message).toContain(PHOTO_IDS[0])
  })

  it('I-02 页面标识重复同样拒绝打开', () => {
    const report = validateProject(makeDocument({ pages: [page(), page()] }), lookup)
    expect(report.status).toBe('invalid')
    expect(report.errors.some((issue) => issue.message.includes('页面标识重复'))).toBe(true)
  })

  it('I-03 失效引用清空槽位并解除锁定，失效文字块移除', () => {
    const ghost = '99999999-9999-4999-8999-999999999999'
    const report = validateProject(
      makeDocument({
        pages: [
          page({
            locked: true,
            slots: [slot(ghost)],
            texts: [{ key: 'title', kind: 'photo-description', photoId: ghost }]
          })
        ]
      }),
      lookup
    )
    expect(report.status).toBe('fixed')
    const first = report.document?.pages[0]
    expect(first?.slots[0]?.photoId).toBeNull()
    expect(first?.texts).toEqual([])
    expect(first?.locked).toBe(false)
    expect(report.fixes.map((fix) => fix.message).join('\n')).toContain('解除锁定')
  })

  it('I-04 同页重复引用同一照片时清除后者，版式允许重复时保留', () => {
    const rejected = validateProject(
      makeDocument({
        pages: [page({ patternId: 'pair', slots: [slot(PHOTO_IDS[0] as string), slot(PHOTO_IDS[0] as string)], texts: [] })]
      }),
      lookup
    )
    expect(rejected.document?.pages[0]?.slots.map((item) => item.photoId)).toEqual([PHOTO_IDS[0], null])
    expect(rejected.fixes.some((fix) => fix.message.includes('I-04'))).toBe(true)

    const allowed = validateProject(
      makeDocument({
        pages: [
          page({
            patternId: 'collage',
            slots: [slot(PHOTO_IDS[0] as string), slot(PHOTO_IDS[0] as string), slot(PHOTO_IDS[0] as string)],
            texts: []
          })
        ]
      }),
      lookup
    )
    expect(allowed.status).toBe('valid')
    expect(allowed.fixes).toEqual([])
  })

  it('I-05 封面照片不存在时清空并记录修复', () => {
    const report = validateProject(
      makeDocument({ meta: { ...makeDocument().meta, coverPhotoId: '99999999-9999-4999-8999-999999999999' } }),
      lookup
    )
    expect(report.document?.meta.coverPhotoId).toBeNull()
    expect(report.fixes.some((fix) => fix.path === 'meta.coverPhotoId')).toBe(true)
  })

  it('I-07 宽高比与显示尺寸不一致时按尺寸重算', () => {
    const report = validateProject(
      makeDocument({ photos: [makePhoto(0, { displayWidth: 3000, displayHeight: 4000, aspect: 4 / 3 })] }),
      lookup
    )
    expect(report.document?.photos[0]?.aspect).toBeCloseTo(0.75, 6)
    expect(report.fixes.some((fix) => fix.message.includes('I-07'))).toBe(true)
  })

  it('I-08 槽位数按版式声明补齐或裁去', () => {
    const report = validateProject(
      makeDocument({
        pages: [
          page({
            patternId: 'collage',
            slots: [slot(PHOTO_IDS[0] as string), slot(PHOTO_IDS[1] as string)],
            texts: []
          })
        ]
      }),
      lookup
    )
    const slots = report.document?.pages[0]?.slots ?? []
    expect(slots).toHaveLength(3)
    expect(slots[2]?.photoId).toBeNull()
    expect(slots[2]?.focus).toEqual({ x: 0.5, y: 0.5 })

    const trimmed = validateProject(
      makeDocument({ pages: [page({ slots: [slot(PHOTO_IDS[0] as string), slot(PHOTO_IDS[1] as string)] })] }),
      lookup
    )
    expect(trimmed.document?.pages[0]?.slots).toHaveLength(1)
  })

  it('版式未知名 → 记为告警并标记需重排，不猜测槽位数量', () => {
    const report = validateProject(
      makeDocument({ pages: [page({ patternId: 'gone-template', slots: [slot(PHOTO_IDS[0] as string), slot(PHOTO_IDS[1] as string)] })] }),
      lookup
    )
    expect(report.warnings.some((issue) => issue.message.includes('gone-template'))).toBe(true)
    expect(report.document?.pages[0]?.slots).toHaveLength(2)
    expect(report.status).toBe('valid')
  })

  it('I-08 同页文字块标识重复时保留首个', () => {
    const report = validateProject(
      makeDocument({
        pages: [
          page({
            patternId: 'two-texts',
            slots: [slot(PHOTO_IDS[0] as string)],
            texts: [
              { key: 'title', kind: 'meta', metaField: 'name' },
              { key: 'title', kind: 'meta', metaField: 'subtitle' }
            ]
          })
        ]
      }),
      lookup
    )
    expect(report.document?.pages[0]?.texts).toHaveLength(1)
    expect(report.fixes.some((fix) => fix.message.includes('文字块标识重复'))).toBe(true)
  })

  it('I-09 裁切视点收敛到 0–1，缩放不小于 1', () => {
    const report = validateProject(
      makeDocument({
        pages: [
          page({
            slots: [{ photoId: PHOTO_IDS[0] as string, focus: { x: 1.4, y: -0.2 }, zoom: 0.3 }]
          })
        ]
      }),
      lookup
    )
    const first = report.document?.pages[0]?.slots[0]
    expect(first?.focus).toEqual({ x: 1, y: 0 })
    expect(first?.zoom).toBe(1)
    expect(report.fixes.filter((fix) => fix.message.includes('I-09'))).toHaveLength(2)
  })

  it('未知字段记为告警且不改数据', () => {
    const raw = {
      ...(makeDocument({ pages: [page()] }) as object),
      legacyField: 1,
      photos: [{ ...(makePhoto(0) as object), deprecated: true }]
    }
    const report = validateProject(raw, lookup)
    expect(report.status).toBe('valid')
    expect(report.warnings.map((issue) => issue.path).sort()).toEqual(['legacyField', 'photos.0.deprecated'])
  })

  it('修复结果仍是合法文档：可原样写回磁盘', () => {
    const report = validateProject(
      makeDocument({
        meta: { ...makeDocument().meta, coverPhotoId: '99999999-9999-4999-8999-999999999999' },
        pages: [page({ locked: true, slots: [slot('99999999-9999-4999-8999-999999999999')] })]
      }),
      lookup
    )
    expect(report.document).not.toBeNull()
    // 修复后的文档必须再次通过形状校验，否则等于把坏数据写回去
    expect(projectDocumentSchema.safeParse(report.document).success).toBe(true)
  })
})
