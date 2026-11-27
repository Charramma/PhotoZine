import type { RichText } from './schema'

/**
 * 描述相关的派生只读计算（需求文档 FR-PHOTO-02 / FR-DESC-01）。
 * 这里不产生新状态，也不改文档：真值始终在 `photo.description`。
 */

/**
 * 列表里的"描述首行摘要"：取第一段的第一行（段内软换行也算换行），
 * 空白段跳过，run 之间的空白折叠成单个空格，结果保证是单行。
 */
export function descriptionSummary(text: RichText, maxChars: number): string {
  for (const block of text.blocks) {
    let line = ''
    for (const run of block.runs) {
      if (run.breakBefore && line !== '') break
      line += run.text
    }
    const singleLine = line.replace(/\s+/g, ' ').trim()
    if (singleLine === '') continue
    const characters = [...singleLine]
    return characters.length > maxChars ? `${characters.slice(0, maxChars - 1).join('')}…` : singleLine
  }
  return ''
}
