import { describe, expect, it } from 'vitest'
import { makeDocument, makePhoto } from './__fixtures__/document'
import {
  PROJECT_SCHEMA_VERSION,
  countCharacters,
  forwardCompatibleDocumentSchema,
  projectNameSchema,
  projectDocumentSchema,
  boundedRichTextSchema,
  photoSchema
} from './schema'

/** 形状层只负责"能不能读"，语义一致性见 invariants.test.ts */
describe('project.json 契约（形状）', () => {
  it('夹具与契约同源：默认文档必然通过校验', () => {
    expect(projectDocumentSchema.safeParse(makeDocument()).success).toBe(true)
  })

  it('未知字段被剔除而不是报错，供不变式层记为 warning', () => {
    const raw = { ...(makeDocument() as object), legacyCover: 'x' }
    const parsed = projectDocumentSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).not.toHaveProperty('legacyCover')
  })

  it('schemaVersion 必须是当前版本，更高的版本由宽松形状承接', () => {
    expect(projectDocumentSchema.safeParse({ ...makeDocument(), schemaVersion: PROJECT_SCHEMA_VERSION + 1 }).success)
      .toBe(false)
    expect(forwardCompatibleDocumentSchema.safeParse({ ...makeDocument(), schemaVersion: 9 }).success).toBe(true)
  })

  it('缺少必填字段时报出字段路径', () => {
    const photo = { ...makePhoto(0) } as Record<string, unknown>
    delete photo['bytes']
    const parsed = projectDocumentSchema.safeParse({ ...makeDocument(), photos: [photo] })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('photos.0.bytes')
    }
  })

  it('照片文件名不允许带路径分隔符', () => {
    expect(photoSchema.safeParse({ ...makePhoto(0), fileName: '../escape.jpg' }).success).toBe(false)
    expect(photoSchema.safeParse({ ...makePhoto(0), fileName: 'photos/a.jpg' }).success).toBe(false)
    expect(photoSchema.safeParse({ ...makePhoto(0), fileName: 'IMG_1.jpg' }).success).toBe(true)
  })

  it('哈希必须是 sha256 十六进制', () => {
    expect(photoSchema.safeParse({ ...makePhoto(0), hash: 'nope' }).success).toBe(false)
  })

  it('页面尺寸只接受预设档位', () => {
    expect(projectDocumentSchema.safeParse({ ...makeDocument(), layout: { ...makeDocument().layout, pageSize: 'B5' } })
      .success).toBe(false)
  })

  it('裁切视点与宽高比越界不在形状层报错，交给不变式自动修复', () => {
    expect(
      projectDocumentSchema.safeParse({
        ...makeDocument(),
        pages: [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            patternId: 'cover',
            locked: false,
            slots: [{ photoId: null, focus: { x: 1.8, y: -0.4 } }],
            texts: []
          }
        ]
      }).success
    ).toBe(true)
    expect(photoSchema.safeParse({ ...makePhoto(0), aspect: 0 }).success).toBe(true)
  })

  it('描述超过上限报错，字符数按 run 累计', () => {
    const long = '一'.repeat(2001)
    expect(boundedRichTextSchema.safeParse({ blocks: [{ runs: [{ text: long }] }] }).success).toBe(false)
    const text = {
      blocks: [
        { runs: [{ text: 'abc' }, { text: 'de' }] },
        { runs: [{ text: 'f' }] }
      ]
    }
    expect(countCharacters(text)).toBe(6)
    expect(boundedRichTextSchema.safeParse(text).success).toBe(true)
  })

  it('段落内空 run 与空块被拒绝', () => {
    expect(boundedRichTextSchema.safeParse({ blocks: [{ runs: [] }] }).success).toBe(false)
    expect(boundedRichTextSchema.safeParse({ blocks: [{ runs: [{ text: '' }] }] }).success).toBe(false)
  })

  it('项目名去首尾空白后入库，并拒绝非法字符与保留名', () => {
    expect(projectNameSchema.parse('  夏日纪行  ')).toBe('夏日纪行')
    expect(projectNameSchema.parse('结尾空格 ')).toBe('结尾空格')
    for (const bad of ['', '   ', 'a/b', 'a\\b', 'con', 'NUL', '结尾点.', 'x'.repeat(61)]) {
      expect(projectNameSchema.safeParse(bad).success).toBe(false)
    }
    expect(projectNameSchema.safeParse('2026·国庆').success).toBe(true)
  })
})
