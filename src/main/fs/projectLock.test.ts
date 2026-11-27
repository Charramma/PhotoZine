import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROJECT_FILES, PROJECT_LOCK } from '@shared/domain/constants'
import {
  acquireProjectLock,
  releaseProjectLock,
  startProjectLockHeartbeat,
  type LockOwner
} from './projectLock'

let dir = ''
const lockFile = (): string => path.join(dir, PROJECT_FILES.lock)

async function putLock(owner: LockOwner): Promise<void> {
  await writeFile(lockFile(), JSON.stringify(owner), 'utf8')
}

async function readLock(): Promise<LockOwner> {
  return JSON.parse(await readFile(lockFile(), 'utf8')) as LockOwner
}

const staleBeat = (): string => new Date(Date.now() - PROJECT_LOCK.staleMs - 5000).toISOString()

const foreignAlive: LockOwner = {
  pid: 999_999,
  machine: 'other-machine',
  heartbeatAt: new Date().toISOString()
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pz-lock-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('项目锁', () => {
  it('无锁时获取成功，锁内写明本机与进程号；释放后文件消失', async () => {
    const result = await acquireProjectLock(dir)
    expect(result.kind).toBe('acquired')
    if (result.kind !== 'acquired') return

    const owner = JSON.parse(await readFile(lockFile(), 'utf8')) as LockOwner
    expect(owner).toMatchObject({ pid: process.pid, machine: hostname() })

    await releaseProjectLock(result.lock)
    await expect(readFile(lockFile(), 'utf8')).rejects.toThrow()
  })

  it('他机持有且心跳新鲜时拒绝，并回显持有者', async () => {
    await putLock(foreignAlive)
    const result = await acquireProjectLock(dir)
    expect(result.kind).toBe('busy')
    if (result.kind === 'busy') expect(result.owner.machine).toBe('other-machine')
  })

  it('同机但进程已不存在 → 立即抢占，不必等心跳超时', async () => {
    await putLock({ pid: 999_998, machine: hostname(), heartbeatAt: new Date().toISOString() })
    expect((await acquireProjectLock(dir)).kind).toBe('acquired')
  })

  it('心跳超过陈旧阈值 → 抢占', async () => {
    await putLock({ ...foreignAlive, heartbeatAt: staleBeat() })
    expect((await acquireProjectLock(dir)).kind).toBe('acquired')
  })

  it('锁文件内容损坏时视为陈旧锁，不因此打不开项目', async () => {
    await writeFile(lockFile(), 'not-json', 'utf8')
    expect((await acquireProjectLock(dir)).kind).toBe('acquired')
  })

  it('释放只删自己的锁，绝不删除他人锁', async () => {
    await putLock(foreignAlive)
    await releaseProjectLock({ root: dir, file: lockFile() })
    expect((await readLock()).machine).toBe('other-machine')
  })

  it('本进程遗留的锁可重新获取，保证关闭后能再次打开', async () => {
    await putLock({ pid: process.pid, machine: hostname(), heartbeatAt: new Date().toISOString() })
    expect((await acquireProjectLock(dir)).kind).toBe('acquired')
  })

  it('心跳持续续期，被接管后停止续期并通知', async () => {
    const acquired = await acquireProjectLock(dir)
    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired') return

    const stop = startProjectLockHeartbeat(acquired.lock, () => undefined, 20)
    const before = (await readLock()).heartbeatAt
    await new Promise((resolve) => setTimeout(resolve, 90))
    stop()
    const after = (await readLock()).heartbeatAt
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before))

    let takenOver = false
    const stopSecond = startProjectLockHeartbeat(acquired.lock, () => {
      takenOver = true
    }, 20)
    await putLock(foreignAlive)
    await new Promise((resolve) => setTimeout(resolve, 90))
    stopSecond()
    expect(takenOver).toBe(true)
    // 被接管后不得再把锁抢回自己名下
    expect((await readLock()).machine).toBe('other-machine')
  })

  it('锁文本定宽：每次写入同一字节长度，原地覆写不留上一任的尾巴（总体设计稿 §7）', async () => {
    const acquired = await acquireProjectLock(dir)
    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired') return

    const first = await readLock()
    expect((await readFile(lockFile())).length).toBe(PROJECT_LOCK.textWidth)

    const stop = startProjectLockHeartbeat(acquired.lock, () => undefined, 20)
    await new Promise((resolve) => setTimeout(resolve, 60))
    stop()

    const bytes = await readFile(lockFile())
    const later = JSON.parse(bytes.toString('utf8')) as LockOwner
    expect(bytes.length).toBe(PROJECT_LOCK.textWidth)
    expect(Date.parse(later.heartbeatAt)).toBeGreaterThan(Date.parse(first.heartbeatAt))
  })

  it('双实例：另一个进程持锁期间不得写入，其死亡后可抢占', async () => {
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const file=path.join(process.argv[1],'${PROJECT_FILES.lock}');
fs.writeFileSync(file,JSON.stringify({pid:process.pid,machine:os.hostname(),heartbeatAt:new Date().toISOString()}));
process.stdout.write('locked');
setInterval(()=>{},1000);`,
        dir
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    )

    let output = ''
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('持锁子进程未就绪')), 15000)
      holder.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('locked')) {
          clearTimeout(timer)
          resolve()
        }
      })
      holder.once('error', reject)
    })

    const owner = JSON.parse(await readFile(lockFile(), 'utf8')) as LockOwner
    expect(owner.pid).not.toBe(process.pid)
    expect((await acquireProjectLock(dir)).kind).toBe('busy')

    holder.kill()
    // 子进程消失后同机死锁可立即抢占，不需要等心跳超时
    const deadline = Date.now() + 5000
    let taken = false
    while (Date.now() < deadline) {
      const result = await acquireProjectLock(dir)
      if (result.kind === 'acquired') {
        taken = true
        await releaseProjectLock(result.lock)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(taken).toBe(true)
  })
})
