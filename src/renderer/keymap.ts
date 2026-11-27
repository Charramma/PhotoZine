/**
 * 键位表机制（AGENTS.md §4.14）：全应用只有这一处 `keydown` 监听，
 * 键位在 `keybindings.ts` 一处声明，禁止任何组件自己 `addEventListener('keydown')`。
 */

/** 判定需要的最小按键信息，`KeyboardEvent` 天然满足，也让命中规则可单测 */
export interface KeySignal {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export interface KeySpec {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export interface KeyBinding {
  id: string
  /** 形如 `Alt+ArrowUp`：修饰键用 `Ctrl/Alt/Shift/Meta`，主键按 `event.key` 写（字母不分大小写） */
  keys: string
  /** 焦点在文本框里时是否仍然响应，默认不响应 —— 打字时的方向键属于输入区 */
  allowInTextEntry?: boolean
  /** 当前界面状态下这条键位是否可用（例如没有选中照片时不移动） */
  enabled?(): boolean
  run(event: KeyboardEvent): void
}

const MODIFIERS: Record<string, keyof Omit<KeySpec, 'key'>> = {
  ctrl: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  meta: 'meta'
}

/** 写法不合法返回 null：注册时就报错，不等到用户按键才发现键位根本没生效 */
export function parseKeySpec(spec: string): KeySpec | null {
  const parts = spec.split('+')
  const key = parts.at(-1)
  if (key === undefined || key === '') return null
  const parsed: KeySpec = { key: key.toLowerCase(), ctrl: false, alt: false, shift: false, meta: false }
  for (const token of parts.slice(0, -1)) {
    const name = MODIFIERS[token.toLowerCase()]
    if (name === undefined) return null
    parsed[name] = true
  }
  return parsed
}

/** 修饰键必须精确匹配：`Alt+ArrowUp` 不会被裸 `ArrowUp` 命中，反之亦然 */
export function matchKeys(signal: KeySignal, spec: string): boolean {
  const parsed = parseKeySpec(spec)
  if (parsed === null) return false
  return (
    signal.key.toLowerCase() === parsed.key &&
    signal.ctrlKey === parsed.ctrl &&
    signal.altKey === parsed.alt &&
    signal.shiftKey === parsed.shift &&
    signal.metaKey === parsed.meta
  )
}

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** 输入区判定：用结构最小接口，界面侧传 `event.target`，测试侧传普通对象 */
export function isTextEntry(node: { tagName: string; isContentEditable: boolean } | null): boolean {
  if (node === null) return false
  return node.isContentEditable || TEXT_ENTRY_TAGS.has(node.tagName.toUpperCase())
}

export function registerKeyBindings(bindings: readonly KeyBinding[]): () => void {
  for (const binding of bindings) {
    if (parseKeySpec(binding.keys) === null) throw new Error(`键位写法不合法：${binding.keys}（${binding.id}）`)
  }
  const onKeydown = (event: KeyboardEvent): void => {
    // 模态对话框开着时按键属于对话框，不能让背后的列表抢键（总体设计稿 §7）
    if (document.querySelector('dialog[open]') !== null) return
    const target = event.target instanceof HTMLElement ? event.target : null
    for (const binding of bindings) {
      if (!matchKeys(event, binding.keys)) continue
      if (binding.allowInTextEntry !== true && isTextEntry(target)) return
      if (binding.enabled !== undefined && !binding.enabled()) return
      event.preventDefault()
      binding.run(event)
      return
    }
  }
  window.addEventListener('keydown', onKeydown)
  return () => window.removeEventListener('keydown', onKeydown)
}
