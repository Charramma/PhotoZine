import { describe, expect, it } from 'vitest'
import { instantFromExifTime, type ExifTimeParts } from './exifTime'

/**
 * EXIF 墙上时间 → 绝对时刻的换算（总体设计稿 D-19）。
 * 用例里的标签值全部来自实测：JPEG 用冒号分隔日期、Apple HEIC 用连字符，
 * 两者都可能出现，所以两条写法都得走同一条换算路径。
 */

const parts = (over: Partial<ExifTimeParts> = {}): ExifTimeParts => ({
  dateTime: '2025:05:18 20:27:40',
  subsec: '',
  offset: '',
  ...over
})

/** 本机时区下，这个墙上时刻对应的绝对时刻 */
const asLocal = (year: number, month: number, day: number, hour: number, minute: number, second: number): string =>
  new Date(year, month - 1, day, hour, minute, second, 0).toISOString()

describe('instantFromExifTime 带时区偏移', () => {
  it('真机 iPhone 样本：负偏移往回推，跨到次日', () => {
    // 同一张片的 GPS 时间戳是 2025-05-19 00:27:40.44 UTC，与换算结果互为佐证
    expect(instantFromExifTime(parts({ dateTime: '2025-05-18 20:27:40', subsec: '449', offset: '-04:00' }))).toBe(
      '2025-05-19T00:27:40.449Z'
    )
  })

  it('正偏移往回推，跨到上一年', () => {
    expect(instantFromExifTime(parts({ dateTime: '2026:01:01 00:15:00', offset: '+05:30' }))).toBe(
      '2025-12-31T18:45:00.000Z'
    )
  })

  it('零偏移就是墙上时间本身', () => {
    expect(instantFromExifTime(parts({ dateTime: '2025:05:18 20:27:40', offset: '+00:00' }))).toBe(
      '2025-05-18T20:27:40.000Z'
    )
  })

  it('跨日与跨月：偏移把时刻推到前一天', () => {
    expect(instantFromExifTime(parts({ dateTime: '2025:12:01 00:10:00', offset: '+08:00' }))).toBe(
      '2025-11-30T16:10:00.000Z'
    )
  })
})

describe('instantFromExifTime 无可用偏移', () => {
  it('缺偏移时按导入机时区解释，换回本地时间分毫不差', () => {
    const iso = instantFromExifTime(parts({ dateTime: '2026:03:04 15:26:33' }))

    expect(iso).toBe(asLocal(2026, 3, 4, 15, 26, 33))
    const back = new Date(String(iso))
    expect([
      back.getFullYear(),
      back.getMonth() + 1,
      back.getDate(),
      back.getHours(),
      back.getMinutes(),
      back.getSeconds()
    ]).toEqual([2026, 3, 4, 15, 26, 33])
  })

  it('偏移写得不成样子时按无偏移处理，而不是整个丢掉拍摄时间', () => {
    for (const offset of ['GMT-4', '+4', '-0400', '-4:00', 'UTC', '  ']) {
      expect(instantFromExifTime(parts({ dateTime: '2026:03:04 15:26:33', offset })), offset).toBe(
        asLocal(2026, 3, 4, 15, 26, 33)
      )
    }
  })
})

describe('instantFromExifTime 标签写法', () => {
  it('两种日期分隔符与 T 分隔的都认（JPEG 冒号 / HEIC 连字符）', () => {
    const expected = '2025-05-18T20:27:40.000Z'
    for (const dateTime of [
      '2025:05:18 20:27:40',
      '2025-05-18 20:27:40',
      '2025-05-18T20:27:40',
      ' 2025:05:18 20:27:40 '
    ]) {
      expect(instantFromExifTime(parts({ dateTime, offset: '+00:00' })), dateTime).toBe(expected)
    }
  })

  it('秒可以缺省', () => {
    expect(instantFromExifTime(parts({ dateTime: '2025:05:18 12:27', offset: '+00:00' }))).toBe(
      '2025-05-18T12:27:00.000Z'
    )
  })

  it('亚秒是小数位的数字串：位数不足补零，超出三位截断', () => {
    const base = { dateTime: '2025:05:18 20:27:40', offset: '+00:00' }
    expect(instantFromExifTime(parts({ ...base, subsec: '4' }))).toBe('2025-05-18T20:27:40.400Z')
    expect(instantFromExifTime(parts({ ...base, subsec: '449' }))).toBe('2025-05-18T20:27:40.449Z')
    expect(instantFromExifTime(parts({ ...base, subsec: '060' }))).toBe('2025-05-18T20:27:40.060Z')
    expect(instantFromExifTime(parts({ ...base, subsec: '123456' }))).toBe('2025-05-18T20:27:40.123Z')
  })

  it(' dateTime 里自带小数秒时也认', () => {
    expect(instantFromExifTime(parts({ dateTime: '2025:05:18 20:27:40.25', offset: '+00:00' }))).toBe(
      '2025-05-18T20:27:40.250Z'
    )
  })
})

describe('instantFromExifTime 读不出就不猜', () => {
  it('越界的日期时间与压根不是时间的串一律返回 null', () => {
    for (const dateTime of [
      '',
      '   ',
      '0000:00:00 00:00:00',
      '2025:13:01 00:00:00',
      '2025:05:32 00:00:00',
      '2025:05:18 25:00:00',
      '2025:05:18 20:60:00',
      '2025:05:18',
      '20250518 202740',
      'GARBAGE'
    ]) {
      expect(instantFromExifTime(parts({ dateTime })), dateTime).toBeNull()
    }
  })

  it('亚秒串不成数字时退化为整秒，不牵连整个时间', () => {
    expect(instantFromExifTime(parts({ dateTime: '2025:05:18 20:27:40', subsec: 'NA', offset: '+00:00' }))).toBe(
      '2025-05-18T20:27:40.000Z'
    )
  })
})
