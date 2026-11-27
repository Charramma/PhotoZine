import { describe, expect, it } from 'vitest'
import { isTextEntry, matchKeys, parseKeySpec } from './keymap'

/**
 * 键位表机制的纯逻辑部分（AGENTS.md §4.14）：监听器本身在集成冒烟里验，
 * 这里只盯"写法解析"和"命中判定"这两条最容易出错的地方。
 */

const signal = (patch: Partial<Parameters<typeof matchKeys>[0]> = {}) => ({
  key: 'ArrowUp',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...patch
})

describe('parseKeySpec', () => {
  it('拆出主键与修饰键，主键统一小写比较', () => {
    expect(parseKeySpec('Ctrl+Shift+Z')).toEqual({
      key: 'z',
      ctrl: true,
      shift: true,
      alt: false,
      meta: false
    })
    expect(parseKeySpec('Escape')).toEqual({ key: 'escape', ctrl: false, alt: false, shift: false, meta: false })
  })

  it('写法不合法（空串、没有主键、未知修饰键）返回 null，注册时就报错', () => {
    expect(parseKeySpec('')).toBeNull()
    expect(parseKeySpec('Ctrl+')).toBeNull()
    expect(parseKeySpec('Option+ArrowUp')).toBeNull()
  })
})

describe('matchKeys', () => {
  it('命中声明的组合键', () => {
    expect(matchKeys(signal({ altKey: true }), 'Alt+ArrowUp')).toBe(true)
    expect(matchKeys(signal({ key: 'Z', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Z')).toBe(true)
  })

  it('修饰键必须精确匹配：多按或不按都不算命中', () => {
    expect(matchKeys(signal(), 'Alt+ArrowUp')).toBe(false)
    expect(matchKeys(signal({ altKey: true }), 'ArrowUp')).toBe(false)
    expect(matchKeys(signal({ altKey: true, shiftKey: true }), 'Alt+ArrowUp')).toBe(false)
    expect(matchKeys(signal({ altKey: true, ctrlKey: true }), 'Alt+ArrowUp')).toBe(false)
  })

  it('主键不区分大小写，但修饰键状态仍单独判定', () => {
    expect(matchKeys(signal({ key: 'a' }), 'A')).toBe(true)
    expect(matchKeys(signal({ key: 'A' }), 'a')).toBe(true)
    expect(matchKeys(signal({ key: 'ArrowDown' }), 'Alt+ArrowUp')).toBe(false)
  })

  it('非法写法永不命中，也不会抛错打断输入', () => {
    expect(matchKeys(signal(), 'Option+ArrowUp')).toBe(false)
    expect(matchKeys(signal(), '')).toBe(false)
  })
})

describe('isTextEntry', () => {
  const node = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable })

  it('输入控件与可编辑区域内不劫持方向键', () => {
    expect(isTextEntry(node('INPUT'))).toBe(true)
    expect(isTextEntry(node('TEXTAREA'))).toBe(true)
    expect(isTextEntry(node('SELECT'))).toBe(true)
    expect(isTextEntry(node('DIV', true))).toBe(true)
    expect(isTextEntry(node('input'))).toBe(true)
  })

  it('列表、按钮与无目标不算输入区', () => {
    expect(isTextEntry(node('DIV'))).toBe(false)
    expect(isTextEntry(node('BUTTON'))).toBe(false)
    expect(isTextEntry(null)).toBe(false)
  })
})
