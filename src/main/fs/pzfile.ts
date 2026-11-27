import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { PZFILE_SCHEME } from '@shared/domain/constants'
import { resolveInRoot } from './projectPath'

/**
 * `pzfile://<根名>/<相对路径>` —— 渲染进程取用项目文件的唯一通道（AGENTS.md §3.3）。
 * 只有显式授权过的根目录可读，越界路径在词法校验阶段就被拒绝，不落到文件系统。
 *
 * 界面侧构造 URL 时必须**逐段** `encodeURIComponent`（`photos/50%折扣.jpg` 里的 `%`
 * 不编码就无法与转义序列区分），本模块按标准 URL 语义解码一次后再做越界判定。
 */

const roots = new Map<string, string>()

export function grantPzfileRoot(name: string, dir: string): void {
  roots.set(name, dir)
}

export function revokePzfileRoot(name: string): void {
  roots.delete(name)
}

/** 必须在 app ready 之前调用 */
export function registerPzfileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PZFILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

export function setupPzfileProtocol(): void {
  protocol.handle(PZFILE_SCHEME, async (request) => {
    const url = new URL(request.url)
    const root = roots.get(url.hostname)
    if (root === undefined) return new Response('forbidden', { status: 403 })

    // 标准协议的 pathname 必带前导斜杠，它表示"根的边界"，先去掉再校验剩余部分。
    // 百分号解码只在这一层做（文件名里合法的 `%` 不属于 URL 转义），
    // 解码后的字符串仍要过词法校验，`%2e%2e%2f` 这类编码形式的越界才拦得住。
    let requested: string
    try {
      requested = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    } catch {
      return new Response('forbidden', { status: 403 })
    }

    const target = resolveInRoot(root, requested)
    if (target === null) return new Response('forbidden', { status: 403 })

    try {
      return await net.fetch(pathToFileURL(target).toString())
    } catch {
      // file:// 取不到即视为不存在；T3 导入管线会按需细分权限与损坏错误
      return new Response('not found', { status: 404 })
    }
  })
}
