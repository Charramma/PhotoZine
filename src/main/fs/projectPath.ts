import path from 'node:path'
import { normalizeRelativePath } from '@shared/fs/relativePath'

/**
 * 项目根内路径的**唯一**解析与边界判定（总体设计稿 §3 路径规则、AGENTS.md §5.3）。
 *
 * 分两层：`projectPath` 只做逐段拼接（输入来自常量），`resolveInRoot` 在此基础上
 * 先过词法校验再断言结果仍在根内（输入来自 `project.json` 或渲染进程的 URL）。
 * 边界判定用 `path.relative` 而不是 `startsWith`：后者会把 `D:\proj` 的兄弟目录
 * `D:\projX` 误判为"根内"。
 */

/** Windows 文件系统不区分大小写，类 Unix 区分；比较键的归一化必须与平台一致 */
function comparisonKey(absolutePath: string): string {
  const normalized = path.normalize(absolutePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 项目根的身份标识：同一目录的不同写法得到同一个键（会话表、项目锁都以此分片） */
export function rootKey(root: string): string {
  return comparisonKey(path.resolve(root))
}

/** 拼接项目内的路径：`relative` 用 POSIX 分隔符（落盘约定的形式），结果是平台绝对路径 */
export function projectPath(root: string, relative: string): string {
  return path.join(path.resolve(root), ...relative.split('/'))
}

/** `target` 是否落在 `root` 内（含根自身）。两个参数都按绝对路径解析后再比较 */
export function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(rootKey(root), comparisonKey(path.resolve(target)))
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  // 只把 `..` 与 `..\` 开头的视为越界：以 `..` 起始的合法文件名（`..草稿.jpg`）不算
  return relative !== '..' && !relative.startsWith('..' + path.sep)
}

/**
 * 把不可信的相对路径解析为项目根内的绝对路径；任何越界或非法写法返回 null。
 * 调用方必须拒绝而不是继续猜测（`pzfile` 协议据此直接回 403）。
 */
export function resolveInRoot(root: string, relative: string): string | null {
  const safe = normalizeRelativePath(relative)
  if (safe === null) return null

  const target = projectPath(root, safe)
  return isWithinRoot(root, target) ? target : null
}
