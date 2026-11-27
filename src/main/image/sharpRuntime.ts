import sharpLib from 'sharp'

/**
 * sharp 在主进程的唯一入口（AGENTS.md §6.1、§8.3：原生依赖只出现在主进程侧）。
 *
 * `files: 0` 是关键：libvips 默认会缓存打开过的文件句柄，Windows 上残留句柄会让
 * 刚处理完的文件无法改名或删除（EBUSY），而导入的提交与取消回滚全靠改名和删除。
 * 操作结果缓存保留默认值，它不影响句柄。
 */
sharpLib.cache({ files: 0 })

export const sharp = sharpLib
/** 类型也从这里出：`import type { Sharp } from 'sharp'` 同样被收口规则拦下 */
export type { Sharp } from 'sharp'
