// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { parseRichText, renderRichText } from './richTextDom'
import { richTextSchema, type RichText } from '@shared/domain/project/schema'

/**
 * 富文本 ⇄ 编辑现场（contenteditable DOM）的映射（总体设计稿 D-07）。
 * 契约有两半：解析只认能力集内的标记，能力集之外一律剥掉；
 * 渲染与解析互为逆运算，所以 `parse(render(x))` 必须等于 x。
 */

function host(html: string): HTMLElement {
  const node = document.createElement('div')
  node.innerHTML = html
  return node
}

function mounted(text: RichText): HTMLElement {
  const node = document.createElement('div')
  renderRichText(node, text)
  return node
}

/** 每个用例都顺带确认产出满足落盘契约（空片段、空段落在这一层就不该出现） */
function parse(html: string): RichText {
  const text = parseRichText(host(html))
  return richTextSchema.parse(text)
}

describe('parseRichText：段落切分', () => {
  it('块级元素各成一段，回车产生的 div 也是段落', () => {
    expect(parse('<div>上午</div><div>下午</div>')).toEqual({
      blocks: [{ runs: [{ text: '上午' }] }, { runs: [{ text: '下午' }] }]
    })
  })

  it('丢弃没有文字的段落，不留下空段', () => {
    expect(parse('<p>一</p><p><br></p><p>二</p>')).toEqual({
      blocks: [{ runs: [{ text: '一' }] }, { runs: [{ text: '二' }] }]
    })
  })

  it('丢弃块之间的换行缩进，但保留段落内的空白', () => {
    expect(parse('<p>a</p>\n  <p>b</p>')).toEqual({
      blocks: [{ runs: [{ text: 'a' }] }, { runs: [{ text: 'b' }] }]
    })
    expect(parse('<p>　　海边</p>')).toEqual({ blocks: [{ runs: [{ text: '　　海边' }] }] })
  })

  it('列表按条目切分，表格按单元格切分', () => {
    expect(parse('<ul><li>一</li><li>二</li></ul>')).toEqual({
      blocks: [{ runs: [{ text: '一' }] }, { runs: [{ text: '二' }] }]
    })
    expect(parse('<table><tr><td>甲</td><td>乙</td></tr></table>')).toEqual({
      blocks: [{ runs: [{ text: '甲' }] }, { runs: [{ text: '乙' }] }]
    })
  })

  it('裸文本也算一段', () => {
    expect(parse('直接写在容器里的字')).toEqual({ blocks: [{ runs: [{ text: '直接写在容器里的字' }] }] })
  })
})

describe('parseRichText：能力集裁剪', () => {
  it('粗体与斜体，含嵌套', () => {
    expect(parse('<p><b>粗</b>普通<i>斜</i><strong><em>又粗又斜</em></strong></p>')).toEqual({
      blocks: [{ runs: [{ text: '粗', bold: true }, { text: '普通' }, { text: '斜', italic: true }, { text: '又粗又斜', bold: true, italic: true }] }]
    })
  })

  it('用内联样式表达的粗斜体同样认，因为粗斜在能力集内', () => {
    expect(parse('<p><span style="font-weight: bold">粗</span><span style="font-style: italic">斜</span></p>')).toEqual({
      blocks: [{ runs: [{ text: '粗', bold: true }, { text: '斜', italic: true }] }]
    })
  })

  it('标记跨文本节点时合并成同一个片段', () => {
    expect(parse('<p><b>并</b><b>成一段</b></p>')).toEqual({ blocks: [{ runs: [{ text: '并成一段', bold: true }] }] })
  })

  it('链接、颜色、下划线、字号、图片一律只留文字', () => {
    expect(parse('<p><a href="https://example.com">链接</a><span style="color: red"><u>红</u></span><font size="7">大</font><img src="x.png" alt="图">字</p>')).toEqual({
      blocks: [{ runs: [{ text: '链接红大字' }] }]
    })
  })

  it('标题降级成普通段落', () => {
    expect(parse('<h2>标题</h2><p>正文</p>')).toEqual({
      blocks: [{ runs: [{ text: '标题' }] }, { runs: [{ text: '正文' }] }]
    })
  })

  it('对齐取块级的居中与右对齐，左对齐是缺省不写', () => {
    expect(parse('<p style="text-align: center">中</p><p style="text-align: right">右</p><p style="text-align: left">左</p><p style="text-align: justify">两端</p>')).toEqual({
      blocks: [{ align: 'center', runs: [{ text: '中' }] }, { align: 'right', runs: [{ text: '右' }] }, { runs: [{ text: '左' }] }, { runs: [{ text: '两端' }] }]
    })
  })

  it('从祖先继承的对齐落实到每一段', () => {
    expect(parse('<div style="text-align: center"><p>一</p><p>二</p></div>')).toEqual({
      blocks: [{ align: 'center', runs: [{ text: '一' }] }, { align: 'center', runs: [{ text: '二' }] }]
    })
  })

  it('软换行归到下一段的开头，连续的换行折叠成一个', () => {
    expect(parse('<p>风很大<br>但想再来</p>')).toEqual({
      blocks: [{ runs: [{ text: '风很大' }, { text: '但想再来', breakBefore: true }] }]
    })
    expect(parse('<p>一<br><br>二</p>')).toEqual({ blocks: [{ runs: [{ text: '一' }, { text: '二', breakBefore: true }] }] })
  })

  it('文本节点里的换行符同样按软换行处理', () => {
    expect(parse('<p>一\n二</p>')).toEqual({ blocks: [{ runs: [{ text: '一' }, { text: '二', breakBefore: true }] }] })
  })

  it('不换行空格折回普通空格', () => {
    expect(parse('<p>a&nbsp;&nbsp;b</p>')).toEqual({ blocks: [{ runs: [{ text: 'a  b' }] }] })
  })
})

describe('renderRichText', () => {
  it('空描述留一个可放置光标的空段落', () => {
    const node = mounted({ blocks: [] })
    expect(node.querySelectorAll('p')).toHaveLength(1)
    expect(node.textContent).toBe('')
    expect(parseRichText(node)).toEqual({ blocks: [] })
  })

  it('渲染会清掉编辑现场原有的内容', () => {
    const node = host('<p>旧的</p>')
    renderRichText(node, { blocks: [{ runs: [{ text: '新的' }] }] })
    expect(node.textContent).toBe('新的')
  })

  it('样式落到标记元素上', () => {
    const node = mounted({ blocks: [{ align: 'center', runs: [{ text: '粗斜', bold: true, italic: true }, { text: '普通' }] }] })
    const paragraph = node.querySelector('p')
    expect(paragraph?.style.textAlign).toBe('center')
    expect(paragraph?.querySelector('strong > em')?.textContent).toBe('粗斜')
    expect(node.textContent).toBe('粗斜普通')
  })
})

describe('render 与 parse 互为逆运算', () => {
  const samples: RichText[] = [
    { blocks: [] },
    { blocks: [{ runs: [{ text: '海边的清晨' }] }] },
    { blocks: [{ runs: [{ text: '风很大' }, { text: '但想再来', breakBefore: true }] }] },
    {
      blocks: [
        { runs: [{ text: '加粗', bold: true }, { text: '与' }, { text: '斜体', italic: true }] },
        { align: 'center', runs: [{ text: '居中' }] },
        { align: 'right', runs: [{ text: 'Both', bold: true, italic: true }] },
        { runs: [{ text: '  前后空格与 a  b  ' }] },
        { runs: [{ text: '软换行', breakBefore: true }] }
      ]
    }
  ]

  for (const [index, sample] of samples.entries()) {
    it(`样例 ${index + 1} 往返不变`, () => {
      expect(richTextSchema.parse(parseRichText(mounted(sample)))).toEqual(sample)
    })
  }
})
