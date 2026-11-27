import { IMAGE_PIPELINE } from '@shared/domain/constants'

/**
 * 图像管线的横切设施：有界并发队列与进度节流（AGENTS.md §6.1：并发与节奏集中配置，不在各处散写）。
 *
 * 队列只管三件事：**并发不超过上限、结果保持输入顺序、取消后不再启动新任务**。
 * 单张照片的业务成败由任务自己返回结果，不靠抛错表达 —— 抛错表示整批失败
 * （磁盘满、权限等环境级问题），此时界面必须停下来而不是继续往下走。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  task: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal: AbortSignal,
  limit: number = IMAGE_PIPELINE.concurrency
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const queue = [...items.entries()]
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      // 取消检查放在取号之前：已经取消就一个都不再启动
      signal.throwIfAborted()
      const entry = queue[cursor]
      if (entry === undefined) return
      cursor += 1
      const [index, item] = entry
      results[index] = await task(item, index, signal)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => worker()))
  return results
}

/** 按时间窗口合并进度回调（总体设计稿 §5） */
export interface ProgressThrottle<T> {
  push(value: T): void
  close(): void
}

/**
 * 进度节流：小图批量导入时每完成一张就发一次事件，几百张会换成每秒上百次跨进程广播与重绘，
 * 界面直接卡死。策略是"首帧立即可见 + 窗口内只保留最后一帧"，
 * 收尾那一帧不补发 —— 批次的真实结果由请求返回值给出，进度只是过程反馈。
 */
export function throttleProgress<T>(emit: (value: T) => void, windowMs: number): ProgressThrottle<T> {
  let pending: T | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (pending === null) {
      timer = null
      return
    }
    emit(pending)
    pending = null
    timer = setTimeout(flush, windowMs)
  }

  return {
    push: (value) => {
      if (timer === null) {
        emit(value)
        timer = setTimeout(flush, windowMs)
        return
      }
      pending = value
    },
    close: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = null
    }
  }
}
