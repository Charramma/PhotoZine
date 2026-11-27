import { describe, expect, it } from 'vitest'
import { descriptionSummary, sameRichText, setDescriptionInDocument } from './description'
import { makeDocument, photoAt } from './__fixtures__/document'
import type { ProjectDocument, RichText } from './schema'

/** 列表里的描述摘要（需求文档 FR-PHOTO-02）：只要"首行"，且必须是一行 */

const rich = (source: string): RichText => ({
  blocks: source.split('\n').map((line) => ({ runs: [{ text: line }] }))
})

describe('descriptionSummary', () => {
  it('取第一段作为首行', () => {
    expect(descriptionSummary(rich('海边的清晨\n第二行不看'), 60)).toBe('海边的清晨')
  })

  it('段内软换行也算换行，只留软换行之前的部分', () => {
    const text: RichText = {
      blocks: [{ runs: [{ text: '风很大' }, { text: '但很想再来', breakBefore: true }] }]
    }
    expect(descriptionSummary(text, 60)).toBe('风很大')
  })

  it('跳过空段，取第一个有内容的项目', () => {
    const text: RichText = {
      blocks: [{ runs: [{ text: '   ' }] }, { runs: [{ text: '第一条真正的记录' }] }]
    }
    expect(descriptionSummary(text, 60)).toBe('第一条真正的记录')
  })

  it('把 run 内部的换行与连续空白折叠成一个空格，run 之间直接相连', () => {
    const text: RichText = {
      blocks: [{ runs: [{ text: '上午\t去了' }, { text: '海边\n踩水' }] }]
    }
    expect(descriptionSummary(text, 60)).toBe('上午 去了海边 踩水')
  })

  it('无段落得到空串', () => {
    expect(descriptionSummary({ blocks: [] }, 60)).toBe('')
  })

  it('超长截断并加省略号，总长不超过上限', () => {
    const summary = descriptionSummary(rich('一'.repeat(120)), 8)
    expect(summary).toBe(`${'一'.repeat(7)}…`)
    expect([...summary].length).toBeLessThanOrEqual(8)
  })

  it('首尾空白不进摘要（AGENTS.md §2.2）', () => {
    expect(descriptionSummary(rich('  山与海  '), 60)).toBe('山与海')
  })
})

describe('sameRichText', () => {
  it('同一份内容换了引用仍然相等（落盘回写会换引用）', () => {
    const a: RichText = { blocks: [{ align: 'center', runs: [{ text: '海边', bold: true }] }] }
    const b: RichText = { blocks: [{ align: 'center', runs: [{ text: '海边', bold: true }] }] }
    expect(sameRichText(a, b)).toBe(true)
  })

  it('缺省的样式标记与显式 false、左对齐等价，因为渲染结果相同', () => {
    expect(sameRichText({ blocks: [{ runs: [{ text: 'a' }] }] }, { blocks: [{ runs: [{ text: 'a', bold: false, italic: false }] }] })).toBe(true)
    expect(sameRichText({ blocks: [{ align: 'left', runs: [{ text: 'a' }] }] }, { blocks: [{ runs: [{ text: 'a' }] }] })).toBe(true)
  })

  it('文字、样式、软换行、对齐任一不同就不等', () => {
    const base: RichText = { blocks: [{ runs: [{ text: 'a' }, { text: 'b', breakBefore: true }] }] }
    expect(sameRichText(base, { blocks: [{ runs: [{ text: 'a' }, { text: 'b' }] }] })).toBe(false)
    expect(sameRichText(base, { blocks: [{ runs: [{ text: 'a', bold: true }, { text: 'b', breakBefore: true }] }] })).toBe(false)
    expect(sameRichText(base, { blocks: [{ align: 'right', runs: [{ text: 'a' }, { text: 'b', breakBefore: true }] }] })).toBe(false)
    expect(sameRichText(base, { blocks: [{ runs: [{ text: 'ab', breakBefore: true }] }] })).toBe(false)
  })

  it('段落数不同就不等，空描述只与空描述相等', () => {
    expect(sameRichText({ blocks: [] }, { blocks: [{ runs: [{ text: 'a' }] }] })).toBe(false)
    expect(sameRichText({ blocks: [] }, { blocks: [] })).toBe(true)
  })
})

describe('setDescriptionInDocument', () => {
  function changed(next: ProjectDocument | null): ProjectDocument {
    if (next === null) throw new Error('期望替换描述，实际返回 null')
    return next
  }

  it('只换掉那一张照片的描述，其余照片与其余字段沿用原引用', () => {
    const document = makeDocument()
    const next: RichText = { blocks: [{ align: 'center', runs: [{ text: '新描述' }] }] }
    const result = changed(setDescriptionInDocument(document, photoAt(document.photos, 0).id, next))
    expect(photoAt(result.photos, 0).description).toBe(next)
    expect(photoAt(result.photos, 1)).toBe(photoAt(document.photos, 1))
    expect(result.meta).toBe(document.meta)
    expect(result.photos).not.toBe(document.photos)
  })

  it('内容没变返回 null，不产生新文档也不触发落盘', () => {
    const document = makeDocument()
    const photo = photoAt(document.photos, 0)
    expect(setDescriptionInDocument(document, photo.id, photo.description)).toBeNull()
    expect(setDescriptionInDocument(document, photo.id, { blocks: [{ align: 'left', runs: [{ text: '海边的清晨', bold: false }] }] })).toBeNull()
  })

  it('那张照片已经不在项目里时返回 null', () => {
    const document = makeDocument()
    expect(setDescriptionInDocument(document, '00000000-0000-4000-8000-000000000000', { blocks: [{ runs: [{ text: 'a' }] }] })).toBeNull()
  })
})
