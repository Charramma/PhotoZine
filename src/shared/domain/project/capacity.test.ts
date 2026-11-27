import { describe, expect, it } from 'vitest'
import { TEXT_METRICS } from '@shared/domain/constants'
import { estimateCapacity, typesetChars } from './capacity'
import { richTextSchema, type RichText } from './schema'

/** 排版度量（总体设计稿 §4.2 按字计、§4.4 容量公式）：只测这两条口径，不测实现细节 */

const rich = (source: string): RichText => ({
  blocks: source.split('\n').map((line) => ({ runs: [{ text: line }] }))
})

describe('typesetChars', () => {
  it('中文按字计，一个字算一字', () => {
    expect(typesetChars(rich('海边的清晨'))).toBe(5)
  })

  it('拉丁字母按折算系数计', () => {
    expect(typesetChars(rich('abc'))).toBeCloseTo(3 * TEXT_METRICS.latinWeight, 10)
  })

  it('混排相加', () => {
    expect(typesetChars(rich('你好abc'))).toBeCloseTo(2 + 3 * TEXT_METRICS.latinWeight, 10)
  })

  it('全角标点与中文括注按字计', () => {
    expect(typesetChars(rich('，。、「」！'))).toBe(6)
  })

  it('假名与谚文按字计', () => {
    expect(typesetChars(rich('かなカク한글'))).toBe(6)
  })

  it('数字、拉丁空格与半角标点按折算计，省略号与破折号属歧义宽度也按折算计', () => {
    expect(typesetChars(rich('2026 年'))).toBeCloseTo(5 * TEXT_METRICS.latinWeight + 1, 10)
    expect(typesetChars(rich('——…'))).toBeCloseTo(3 * TEXT_METRICS.latinWeight, 10)
  })

  it('全角空格按字计', () => {
    expect(typesetChars(rich('　'))).toBe(1)
  })

  it('跨片段与跨段落累加', () => {
    const text: RichText = {
      blocks: [
        { runs: [{ text: '海边' }, { text: 'morning', bold: true }] },
        { runs: [{ text: '山', breakBefore: true }, { text: 'wind' }] }
      ]
    }
    expect(typesetChars(text)).toBeCloseTo(3 + 11 * TEXT_METRICS.latinWeight, 10)
    expect(richTextSchema.parse(text)).toBeDefined()
  })

  it('空描述是 0 字', () => {
    expect(typesetChars({ blocks: [] })).toBe(0)
  })

  it('代理对（生僻字）算一个字，不按 UTF-16 长度计', () => {
    expect(typesetChars(rich('𠮷野家'))).toBe(3)
  })
})

describe('estimateCapacity', () => {
  const frame = { widthMm: 80, heightMm: 20, sizeMm: 3.5, lineHeight: 1.6 }

  it('按 §4.4 公式取整：先算行列再乘松紧系数', () => {
    const cols = Math.floor(80 / 3.5)
    const rows = Math.floor(20 / (3.5 * 1.6))
    expect(estimateCapacity(frame)).toBe(Math.floor(cols * rows * TEXT_METRICS.packingFactor))
  })

  it('结果是整数，可直接与字数比较', () => {
    expect(Number.isInteger(estimateCapacity(frame))).toBe(true)
  })

  it('字号越大容量越小', () => {
    expect(estimateCapacity({ ...frame, sizeMm: 4 })).toBeLessThan(estimateCapacity(frame))
  })

  it('放不下一个字或一行时为 0', () => {
    expect(estimateCapacity({ ...frame, widthMm: 1 })).toBe(0)
    expect(estimateCapacity({ ...frame, heightMm: 1 })).toBe(0)
  })

  it('非正数尺寸不是合法文字块，返回 0', () => {
    expect(estimateCapacity({ ...frame, sizeMm: 0 })).toBe(0)
    expect(estimateCapacity({ ...frame, lineHeight: 0 })).toBe(0)
    expect(estimateCapacity({ ...frame, widthMm: -80 })).toBe(0)
  })

  it('非有限数值返回 0，不把 Infinity 当容量', () => {
    expect(estimateCapacity({ ...frame, widthMm: Number.POSITIVE_INFINITY })).toBe(0)
    expect(estimateCapacity({ ...frame, sizeMm: Number.NaN })).toBe(0)
  })
})
