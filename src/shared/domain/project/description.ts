import type { ProjectDocument, RichText } from './schema'

/**
 * 描述相关的纯函数（需求文档 FR-PHOTO-02 / FR-DESC-01）：摘要、等价判定与文档内的描述替换。
 * 都不产生新状态：真值始终在 `photo.description`，改文档一律由调用方交给命令入口（总体设计稿 D-20）。
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

/**
 * 两份描述是否是**同一段文字**：缺省的样式标记与显式 `false`、显式左对齐与不写对齐都算相同，
 * 因为渲染结果一样；片段边界仍要一致（合并过的片段与拆开的片段不是同一份编辑现场）。
 *
 * 用途：命令入口据此判断"这次编辑其实没改任何东西"（不标脏、不落盘），
 * 描述编辑器据此判断"store 里的这份是不是我刚写出去的那份"（落盘回写会换引用，不该重建编辑现场）。
 */
export function sameRichText(a: RichText, b: RichText): boolean {
  if (a === b) return true
  if (a.blocks.length !== b.blocks.length) return false
  // 长度已比对，下面的 undefined 分支只是 `noUncheckedIndexedAccess` 要求的收窄
  for (const [index, block] of a.blocks.entries()) {
    const other = b.blocks[index]
    if (other === undefined) return false
    if ((block.align ?? 'left') !== (other.align ?? 'left') || block.runs.length !== other.runs.length) return false
    for (const [runIndex, run] of block.runs.entries()) {
      const peek = other.runs[runIndex]
      if (
        peek === undefined ||
        run.text !== peek.text ||
        (run.bold ?? false) !== (peek.bold ?? false) ||
        (run.italic ?? false) !== (peek.italic ?? false) ||
        (run.breakBefore ?? false) !== (peek.breakBefore ?? false)
      ) {
        return false
      }
    }
  }
  return true
}

/**
 * 换掉某一张照片的描述；那张照片不在项目里或内容没变都返回 null（即"没有改动"）。
 * 只重建 `photos` 数组与被改的那一项，其余字段沿用原引用。
 */
export function setDescriptionInDocument(
  document: ProjectDocument,
  photoId: string,
  description: RichText
): ProjectDocument | null {
  const current = document.photos.find((photo) => photo.id === photoId)
  if (current === undefined || sameRichText(current.description, description)) return null
  return {
    ...document,
    photos: document.photos.map((photo) => (photo.id === photoId ? { ...photo, description } : photo))
  }
}
