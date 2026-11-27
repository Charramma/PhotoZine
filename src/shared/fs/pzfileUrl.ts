import { PZFILE_SCHEME } from '../domain/constants'
import { normalizeRelativePath } from './relativePath'

/**
 * 构造 `pzfile://<根名>/<相对路径>`：界面取项目文件的唯一方式（AGENTS.md §3.3）。
 *
 * 逐段编码与协议侧"解码一次再做越界判定"是对称的：整条路径一次性 `encodeURI` 会把
 * `%2e%2e%2f` 这类越界写法原样送出去，而一次性 `encodeURIComponent` 又会把合法的分隔符
 * 也吃掉，所以必须按段处理。名字里本来就带 `%` 的文件（`50%折扣.jpg`）只有逐段编码才取得到。
 * 判定不合法时返回 null，由调用方决定不显示 —— 不在这里猜意图。
 */
export function pzfileUrl(rootName: string, relative: string): string | null {
  const safe = normalizeRelativePath(relative)
  if (safe === null) return null
  return `${PZFILE_SCHEME}://${rootName}/${safe.split('/').map(encodeURIComponent).join('/')}`
}
