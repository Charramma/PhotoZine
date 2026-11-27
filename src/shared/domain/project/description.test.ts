import { describe, expect, it } from 'vitest'
import { descriptionSummary } from './description'
import type { RichText } from './schema'

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
