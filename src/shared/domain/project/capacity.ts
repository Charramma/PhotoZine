import { TEXT_METRICS } from '../constants'
import type { RichText } from './schema'

/**
 * 排版度量（总体设计稿 §4.2、§4.4）：把"这段文字有多长"和"这块地方能放多少字"
 * 折成同一个单位 —— **字**。两者的差就是界面提示与文字分档要的溢出信号。
 *
 * 与 `countCharacters`（schema）不是一回事：那条是落盘上限（FR-DESC-01 的 2000 字）的计数口径，
 * 按 UTF-16 长度算；这里是**排版口径**，占一格宽的字符记 1，其余按 0.55 折算，结果可以是小数。
 */

/** 按书写系统判定的全角字符：汉字与假名、谚文 */
const WIDE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * 按码位区间判定的全角标点与全角形式：
 * U+3000-U+303F 中文标点（含全角空格）、U+FF01-U+FF60 全角形式、U+FFE0-U+FFE4 杂项全角。
 * 省略号、破折号、弯引号这类"歧义宽度"标点按半角折算 —— 容量本身留了 8% 余量，
 * 不在这几个字上纠结，换取规则可以一句话说清。
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x3000, 0x303f],
  [0xff01, 0xff60],
  [0xffe0, 0xffe4]
]

/** 按字计的排版字数（§4.2 文字分档与 §4.4 容量比较都用它） */
export function typesetChars(text: RichText): number {
  let total = 0
  for (const block of text.blocks) {
    for (const run of block.runs) {
      for (const character of run.text) {
        const code = character.codePointAt(0) ?? 0
        const wide = WIDE_SCRIPT.test(character) || WIDE_RANGES.some(([from, to]) => code >= from && code <= to)
        total += wide ? TEXT_METRICS.cjkWeight : TEXT_METRICS.latinWeight
      }
    }
  }
  return total
}

/** 版面里一个文字块的几何与字号（mm）：`sizeMm` 是字号，`lineHeight` 是倍数 */
export interface TextFrame {
  widthMm: number
  heightMm: number
  sizeMm: number
  lineHeight: number
}

/**
 * 文字块约可容纳的字数（§4.4）：一行几个字 × 几行 × 松紧系数，向下取整。
 * 这是给模板设计者自检与编辑器提示用的**估计值**，实际断行由 Chromium 完成，渲染器不读它。
 * 尺寸不合法（非正、非有限）时返回 0，即"这块地方放不下字"。
 */
export function estimateCapacity(frame: TextFrame): number {
  const { widthMm, heightMm, sizeMm, lineHeight } = frame
  if (![widthMm, heightMm, sizeMm, lineHeight].every((value) => Number.isFinite(value) && value > 0)) return 0
  const columns = Math.floor(widthMm / sizeMm)
  const rows = Math.floor(heightMm / (sizeMm * lineHeight))
  if (columns < 1 || rows < 1) return 0
  return Math.floor(columns * rows * TEXT_METRICS.packingFactor)
}
