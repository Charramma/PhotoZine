import { describe, expect, it } from 'vitest'
import { mapWithConcurrency, throttleProgress } from './imagePipeline'

/** 队列只负责"有界并发 + 可取消 + 保持顺序"，业务成败由任务自己返回 */

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const running = new AbortController().signal

describe('mapWithConcurrency', () => {
  it('结果顺序与输入一致', async () => {
    const results = await mapWithConcurrency([5, 1, 4, 2, 0], async (value) => {
      await settle(value)
      return value
    }, running)

    expect(results).toEqual([5, 1, 4, 2, 0])
  })

  it('并发不超过上限', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), async () => {
      active += 1
      peak = Math.max(peak, active)
      await settle(2)
      active -= 1
      return null
    }, running, 4)

    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('空输入不启动任何任务', async () => {
    let runs = 0
    const results = await mapWithConcurrency([], async () => {
      runs += 1
      return null
    }, running)

    expect(results).toEqual([])
    expect(runs).toBe(0)
  })

  it('取消后不再启动新任务，在途任务收到同一个 signal', async () => {
    const controller = new AbortController()
    const started: number[] = []
    let observedSignal = false

    await expect(
      mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), async (value, _index, signal) => {
        started.push(value)
        if (value === 1) {
          controller.abort()
          await settle(10)
          observedSignal = signal.aborted
          return null
        }
        // 第 0 个任务先让出一次，确保两个工作位都已启动后再由第 1 个触发取消
        await settle(1)
        return null
      }, controller.signal, 2)
    ).rejects.toMatchObject({ name: 'AbortError' })

    // 等在途任务自己跑完，再判它在途期间是否看到了同一个 signal
    await settle(30)
    expect(observedSignal).toBe(true)
    expect(started).toEqual([0, 1])
  })

  it('进入前已经取消则一个任务都不跑', async () => {
    const controller = new AbortController()
    controller.abort()
    let runs = 0

    await expect(
      mapWithConcurrency([1, 2, 3], async () => {
        runs += 1
        return null
      }, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(runs).toBe(0)
  })

  it('任务自身抛错视为整体失败并向上传播', async () => {
    await expect(
      mapWithConcurrency([1, 2], async (value) => {
        if (value === 2) throw new Error('磁盘已满')
        return value
      }, running)
    ).rejects.toThrowError('磁盘已满')
  })
})

describe('throttleProgress', () => {
  it('首帧立即发，窗口内只保留最后一帧', async () => {
    const seen: number[] = []
    const throttle = throttleProgress<number>((value) => seen.push(value), 20)

    throttle.push(1)
    throttle.push(2)
    throttle.push(3)
    expect(seen).toEqual([1])
    await settle(35)
    expect(seen).toEqual([1, 3])
    throttle.close()
  })

  it('close 之后不补发：批次的真实结果由请求返回值给出', async () => {
    const seen: number[] = []
    const throttle = throttleProgress<number>((value) => seen.push(value), 20)

    throttle.push(1)
    throttle.push(2)
    throttle.close()
    await settle(35)
    expect(seen).toEqual([1])
  })

  it('窗口空了就重新立即发下一帧，不会把进度饿死', async () => {
    const seen: number[] = []
    const throttle = throttleProgress<number>((value) => seen.push(value), 15)

    throttle.push(1)
    await settle(30)
    throttle.push(2)
    expect(seen).toEqual([1, 2])
    throttle.close()
  })
})
