import { hostname } from 'node:os'
import { open, readFile, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { PROJECT_FILES, PROJECT_LOCK } from '@shared/domain/constants'
import { projectPath } from './projectPath'

/**
 * 项目锁（总体设计稿 §7、D-12）：每个项目一份 `project.json.lock`，
 * 内容为 PID + 机器名 + 心跳。抢不到锁的一律降级只读，绝不允许"再试一次就写"。
 */

const localMachine = hostname()

const lockOwnerSchema = z.object({
  pid: z.int().positive(),
  machine: z.string().min(1),
  heartbeatAt: z.iso.datetime()
})
export type LockOwner = z.infer<typeof lockOwnerSchema>

export interface ProjectLock {
  readonly root: string
  readonly file: string
}

export type LockOutcome =
  | { kind: 'acquired'; lock: ProjectLock }
  | { kind: 'busy'; owner: LockOwner }

function isSelf(owner: LockOwner): boolean {
  return owner.machine === localMachine && owner.pid === process.pid
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在只是无权探测；ESRCH 才是不存在
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 同机进程已消失可立即抢占；其余按心跳超时判定（崩溃未清理的锁最多阻塞一个超时窗口） */
function isStale(owner: LockOwner): boolean {
  if (owner.machine === localMachine && !isProcessAlive(owner.pid)) return true
  const beat = Date.parse(owner.heartbeatAt)
  if (Number.isNaN(beat)) return true
  return Date.now() - beat > PROJECT_LOCK.staleMs
}

async function readOwner(file: string): Promise<LockOwner | null> {
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  const owner = parseOwner(text)
  if (owner !== null) return owner
  // 独占创建与写入内容之间有微秒级空窗：读到空文件或半截内容时稍后再读一次，
  // 仍不可解析才判定为陈旧锁，避免把刚建立的锁误抢走
  await new Promise((resolve) => setTimeout(resolve, PROJECT_LOCK.readRetryMs))
  return parseOwner(await readFile(file, 'utf8').catch(() => ''))
}

function parseOwner(text: string): LockOwner | null {
  const parsed = lockOwnerSchema.safeParse(safeJsonParse(text))
  return parsed.success ? parsed.data : null
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 锁文本定宽（总体设计稿 §7）：右侧补空格到 `PROJECT_LOCK.textWidth` **字节**。
 * 补的是空白，`JSON.parse` 会忽略尾部空白，读取侧不必知道这个约定；
 * 定宽的目的是让每一次写入都同样长 —— 心跳用 `r+` 原地覆写时不会留下上一任的尾巴。
 */
function ownerBytes(owner: LockOwner): Buffer {
  const bytes = Buffer.from(JSON.stringify(owner), 'utf8')
  return bytes.length >= PROJECT_LOCK.textWidth
    ? bytes
    : Buffer.concat([bytes, Buffer.alloc(PROJECT_LOCK.textWidth - bytes.length, 0x20)])
}

function ownOwner(): LockOwner {
  return { pid: process.pid, machine: localMachine, heartbeatAt: new Date().toISOString() }
}

async function writeExclusive(file: string, owner: LockOwner): Promise<void> {
  const handle = await open(file, 'wx')
  try {
    await handle.write(ownerBytes(owner))
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * 续期写入：文本与文件同长（定宽），所以这里是纯原地覆写、不需要截断 ——
 * 并发读取永远拿到结构完整的 JSON，最多读到新旧混合的心跳时间戳（无害）。
 */
async function writeOver(file: string, owner: LockOwner): Promise<void> {
  const handle = await open(file, 'r+')
  try {
    await handle.write(ownerBytes(owner))
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * 尝试持有项目锁。
 * `wx` 独占创建是原子的，冲突时读取持有者：陈旧或本进程遗留则接管，最多重试一次。
 */
export async function acquireProjectLock(root: string): Promise<LockOutcome> {
  const file = projectPath(root, PROJECT_FILES.lock)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeExclusive(file, ownOwner())
      return { kind: 'acquired', lock: { root, file } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const existing = await readOwner(file)
    if (existing !== null && !isStale(existing) && !isSelf(existing)) {
      return { kind: 'busy', owner: existing }
    }
    // 锁文件损坏、持有者已死或本进程遗留：清掉后重试，语义等同抢占
    await unlink(file).catch(() => undefined)
  }

  const racing = await readOwner(file)
  if (racing !== null) return { kind: 'busy', owner: racing }
  return { kind: 'busy', owner: { pid: 1, machine: '未知持有者', heartbeatAt: new Date().toISOString() } }
}

/**
 * 心跳：只有仍属于自己时才续期；被接管后停止续期并通知调用方转只读。
 * `intervalMs` 默认取全局配置，测试可缩短以观察续期与接管。
 */
export function startProjectLockHeartbeat(
  lock: ProjectLock,
  onTakenOver: () => void,
  intervalMs: number = PROJECT_LOCK.heartbeatMs
): () => void {
  const timer = setInterval(() => {
    void (async () => {
      const existing = await readOwner(lock.file)
      if (existing === null || !isSelf(existing)) {
        clearInterval(timer)
        onTakenOver()
        return
      }
      await writeOver(lock.file, ownOwner()).catch(() => undefined)
    })()
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

/** 释放：只删除自己持有的锁，绝不动别人的文件 */
export async function releaseProjectLock(lock: ProjectLock): Promise<void> {
  const existing = await readOwner(lock.file)
  if (existing === null || isSelf(existing)) {
    await unlink(lock.file).catch(() => undefined)
  }
}
