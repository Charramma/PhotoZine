import type { RichText, TextBlock, TextRun } from '@shared/domain/project/schema'

/**
 * 富文本契约 ⇄ 编辑现场（contenteditable DOM）的双向映射（总体设计稿 D-07）。
 *
 * 放在渲染层而不是 `shared/domain`：这份映射认识 DOM，而 `shared/domain` 由主进程侧
 * 一起编译（tsconfig.node.json 不带 `dom` lib），契约逻辑留在 shared、界面适配留在这里。
 *
 * 解析侧只认能力集：段落、粗体、斜体、左/中/右对齐、段内软换行。
 * 其余标记（链接、颜色、下划线、字号、列表、图片、表格）一律**只取文字**，
 * 所以从任何地方复制来的 HTML 都能直接当编辑现场解析，不需要额外的清洗步骤。
 *
 * 渲染与解析互为逆运算，`parseRichText(renderRichText(x))` 等于 x 的**规范形**：
 * 相邻同样式片段合并、缺省对齐不落字段（`align: 'left'` 编辑后归一为不写）、
 * 空段落不进契约（契约要求每段至少一个非空片段，段间视觉间距由样式承担）。
 */

/** 块内有效对齐；`left` 是缺省，只在规范形里表现为"不写字段" */
type Aligned = 'left' | 'center' | 'right'

/** 解析时沿 DOM 继承的标记状态：能力集里只有粗与斜 */
interface Marks {
  bold: boolean
  italic: boolean
}

const NO_MARKS: Marks = { bold: false, italic: false }

/** 段落边界：块级元素另起一段（`br` 是段内软换行，单独处理） */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN',
  'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
])

/** 版面里没有它们的位置：整体丢弃，连文字也不留 */
const DROPPED_TAGS = new Set([
  'AREA', 'AUDIO', 'BUTTON', 'CANVAS', 'EMBED', 'IFRAME', 'IMG', 'INPUT', 'MAP', 'NOSCRIPT',
  'OBJECT', 'PICTURE', 'PROGRESS', 'SCRIPT', 'SELECT', 'SOURCE', 'STYLE', 'SVG', 'TEXTAREA', 'TRACK', 'VIDEO'
])

/** 内联样式表达的粗斜体与标记表达的等价（都是能力集内的样式，浏览器两种写法都可能出现） */
const BOLD_WEIGHT = /^(?:bold(?:er)?|[6-9]00)$/

function marksOf(element: HTMLElement, inherited: Marks): Marks {
  const { tagName, style } = element
  const bold = inherited.bold || tagName === 'B' || tagName === 'STRONG' || BOLD_WEIGHT.test(style.fontWeight)
  const italic = inherited.italic || tagName === 'I' || tagName === 'EM' || style.fontStyle === 'italic'
  if (bold === inherited.bold && italic === inherited.italic) return inherited
  return { bold, italic }
}

/** 元素自己声明的对齐；没声明返回 null，交给祖先继承 */
function declaredAlign(element: HTMLElement): Aligned | null {
  const { textAlign } = element.style
  if (textAlign === '') return null
  return textAlign === 'center' || textAlign === 'right' ? textAlign : 'left'
}

/** 编辑现场 → 契约 */
export function parseRichText(root: HTMLElement): RichText {
  const blocks: TextBlock[] = []
  let runs: TextRun[] = []
  let breakPending = false
  let align: Aligned = 'left'

  const flush = (): void => {
    if (runs.length > 0) blocks.push(align === 'left' ? { runs } : { align, runs })
    runs = []
    breakPending = false
  }

  const append = (text: string, marks: Marks): void => {
    const last = runs[runs.length - 1]
    if (last !== undefined && !breakPending && Boolean(last.bold) === marks.bold && Boolean(last.italic) === marks.italic) {
      last.text += text
      return
    }
    runs.push({
      text,
      ...(marks.bold ? { bold: true } : {}),
      ...(marks.italic ? { italic: true } : {}),
      ...(breakPending ? { breakBefore: true } : {})
    })
    breakPending = false
  }

  const walk = (node: Node, marks: Marks, inherited: Aligned): void => {
    align = inherited
    for (const child of Array.from(node.childNodes)) {
      if (child instanceof Text) {
        const lines = child.data.replace(/\u00a0/g, ' ').split(/\r?\n/)
        for (const [line, segment] of lines.entries()) {
          // 文本节点开头的换行是源码里的排版缩进，段内已有的换行才是软换行
          if (line > 0 && runs.length > 0) breakPending = true
          if (segment === '' || (runs.length === 0 && segment.trim() === '')) continue
          append(segment, marks)
        }
        continue
      }
      // 注释、字符数据与 svg 这类非 HTML 元素在版面里没有位置：整块丢弃
      if (!(child instanceof HTMLElement)) continue
      const tag = child.tagName
      if (DROPPED_TAGS.has(tag)) continue
      if (tag === 'BR') {
        breakPending = true
        continue
      }
      if (BLOCK_TAGS.has(tag)) {
        flush()
        walk(child, marks, declaredAlign(child) ?? inherited)
        flush()
        align = inherited
        continue
      }
      walk(child, marksOf(child, marks), inherited)
    }
  }

  walk(root, NO_MARKS, declaredAlign(root) ?? 'left')
  flush()
  return { blocks }
}

/** 契约 → 编辑现场 */
export function renderRichText(container: HTMLElement, text: RichText): void {
  const paragraphs: HTMLElement[] = []
  for (const block of text.blocks) {
    const paragraph = document.createElement('p')
    if (block.align !== undefined) paragraph.style.textAlign = block.align
    for (const run of block.runs) {
      if (run.breakBefore) paragraph.appendChild(document.createElement('br'))
      let node: Node = document.createTextNode(run.text)
      if (run.italic) {
        const em = document.createElement('em')
        em.appendChild(node)
        node = em
      }
      if (run.bold) {
        const strong = document.createElement('strong')
        strong.appendChild(node)
        node = strong
      }
      paragraph.appendChild(node)
    }
    paragraphs.push(paragraph)
  }
  // 空描述也要有地方落脚光标
  if (paragraphs.length === 0) {
    const paragraph = document.createElement('p')
    paragraph.appendChild(document.createElement('br'))
    paragraphs.push(paragraph)
  }
  container.replaceChildren(...paragraphs)
}
