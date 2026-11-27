/**
 * 项目内相对路径的词法校验（总体设计稿 §3 路径规则、AGENTS.md §5.3）。
 *
 * 纯字符串实现，不依赖 `node:path`，因此界面侧与主进程共用同一份判定；
 * 只做词法归一化，**不做百分号解码** —— URL 取到的路径由 `pzfile` 协议侧先解码再交给本函数，
 * 否则文件名里合法的 `%` 会被误判（`50%折扣.jpg`）。
 * 返回 null 表示不安全或为空；调用方必须拒绝而不是猜测意图。
 */

/** Windows 文件名非法字符。反斜杠与正斜杠是分隔符，冒号还会引出备用数据流 */
const WINDOWS_ILLEGAL = /[\\/:*?"<>|]/

/** Windows 保留名（含带扩展名的形式），落盘会失败或指向设备 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Windows 会静默丢弃名字结尾的点号与空格，导致拼接结果与请求不一致（一整串都要处理） */
const TRAILING_DOT_OR_SPACE = /[. ]+$/

export function normalizeRelativePath(input: string): string | null {
  if (input === '') return null
  // 控制字符（含 DEL）逐个按码位判：写成正则会被 lint 拦住，也不如码位范围直白
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return null
  }
  if (input.includes('\\')) return null
  if (input.startsWith('/')) return null

  const segments: string[] = []
  for (const raw of input.split('/')) {
    if (raw === '' || raw === '.') continue
    if (raw === '..') return null
    if (WINDOWS_ILLEGAL.test(raw)) return null
    if (TRAILING_DOT_OR_SPACE.test(raw)) return null
    if (WINDOWS_RESERVED.test(raw)) return null
    segments.push(raw)
  }

  return segments.length > 0 ? segments.join('/') : null
}

/**
 * 单个名字（一个文件或目录的名字）：在相对路径判定之外再要求"只有一段"。
 * 项目文件夹名与 `photos/` 里的文件名都走这里，避免两处各写一份"不许含分隔符"的规则。
 */
export function normalizeNameSegment(input: string): string | null {
  const normalized = normalizeRelativePath(input)
  if (normalized === null || normalized.includes('/')) return null
  return normalized
}

/** 逐字符替换：控制字符与 Windows 非法字符都不能出现在磁盘名字里，统一换成下划线 */
function replaceIllegalCharacters(input: string): string {
  let output = ''
  for (let index = 0; index < input.length; index += 1) {
    const character = input.charAt(index)
    const code = input.charCodeAt(index)
    output += code < 0x20 || code === 0x7f || WINDOWS_ILLEGAL.test(character) ? '_' : character
  }
  return output
}

/**
 * 把任意来源的名字（用户文件名、外部导入的路径末段）清洗成可用于 `photos/` 的名字。
 *
 * 与 `normalizeNameSegment` 同处一地，是为了让"什么名字合法"只有一套字符规则：
 * 导入侧只做替换，判定仍然回到上面的校验，清洗不出合法名字就返回 null 由调用方拒绝，
 * 不允许出现"导入自己另定一套宽松规则、落盘再指望文件系统容忍"的分叉。
 */
export function sanitizeNameSegment(input: string): string | null {
  let name = replaceIllegalCharacters(input).replace(TRAILING_DOT_OR_SPACE, '')
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`
  return normalizeNameSegment(name)
}
