/**
 * EXIF 拍摄时间换算（总体设计稿 D-19）：把"墙上时间 + 亚秒 + 时区偏移"三个标签
 * 换算成一个绝对时刻，是整个应用里**唯一**解释 EXIF 时间的地方。
 *
 * 为什么不让 exifr 直接给 Date：它把墙上时间一律按本机时区解释，`OffsetTimeOriginal`
 * 读得到却不参与换算（实测 JPEG 与真机 HEIC 都是这条规则），换台机器重导同一批照片就会漂移。
 * 所以这里只吃**原始标签字符串**：两种容器喂进来同样的标签，必然得到同样的绝对时刻。
 *
 * 换算规则：
 * - 偏移可读 → `绝对时刻 = 墙上时间 − 偏移`（偏移的含义是"本地比 UTC 快多少"）
 * - 偏移缺失或写法不成样子 → 按导入机时区解释，夏令时交给运行环境的本地语义
 * - 墙上时间本身读不出 → 返回 null，不猜、也不阻断导入
 */

export interface ExifTimeParts {
  /** `DateTimeOriginal` 之类的原样值：`2025:05:18 20:27:40`，也见过 `2025-05-18 20:27:40` */
  dateTime: string
  /** `SubSecTime*`：小数点后的数字串，`449` 表示 0.449 秒 */
  subsec: string
  /** `OffsetTime*`：`-04:00` / `+05:30`；没有就传空串 */
  offset: string
}

/**
 * `YYYY:MM:DD HH:MM:SS`。日期分隔符两种容器各写各的（JPEG 冒号、Apple HEIC 连字符），
 * 日期与时间之间见过空格也见过 `T`，秒可以整段缺省，少数机器把小数秒直接缀在末尾。
 */
const DATE_TIME = /^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?$/

/** `±HH:MM`，EXIF 只有这一种写法；`GMT-4`、`+4`、`-0400` 这类不规范值按"没有偏移"处理 */
const OFFSET = /^([+-])(\d{2}):(\d{2})$/

/** 早于这个年份的 EXIF 时间都是坏数据：JS 会把 0–99 年映射到 1900+，不挡住就悄悄错一个世纪 */
const MIN_CREDIBLE_YEAR = 1900

const within = (value: number, min: number, max: number): boolean => value >= min && value <= max

/** 小数秒数字串 → 毫秒：位数不足右侧补零，超三位截断，不成数字就当没有 */
function milliOf(subsec: string, fromDateTime: string | undefined): number {
  const digits = /^\d+$/.test(subsec) ? subsec : (fromDateTime ?? '')
  if (digits === '') return 0
  return Number(`${digits}00`.slice(0, 3))
}

/** 偏移 → "本地比 UTC 快多少分钟"；读不出可用的偏移返回 null，交由调用方回落到本机时区 */
function offsetMinutesOf(raw: string): number | null {
  const matched = OFFSET.exec(raw.trim())
  if (matched === null) return null
  const hours = Number(matched[2])
  const minutes = Number(matched[3])
  if (!within(hours, 0, 23) || !within(minutes, 0, 59)) return null
  return (hours * 60 + minutes) * (matched[1] === '-' ? -1 : 1)
}

/**
 * @param parts 三个原始 EXIF 标签，取不到的给空串
 * @returns ISO 8601 的 UTC 时刻；墙上时间读不出返回 null
 */
export function instantFromExifTime(parts: ExifTimeParts): string | null {
  const matched = DATE_TIME.exec(parts.dateTime.trim())
  if (matched === null) return null

  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const hour = Number(matched[4])
  const minute = Number(matched[5])
  const second = matched[6] === undefined ? 0 : Number(matched[6])
  if (year < MIN_CREDIBLE_YEAR) return null
  if (!within(month, 1, 12) || !within(day, 1, 31)) return null
  if (!within(hour, 0, 23) || !within(minute, 0, 59) || !within(second, 0, 59)) return null

  const milli = milliOf(parts.subsec.trim(), matched[7])
  const offset = offsetMinutesOf(parts.offset)
  const at =
    offset === null
      ? new Date(year, month - 1, day, hour, minute, second, milli)
      : new Date(Date.UTC(year, month - 1, day, hour, minute, second, milli) - offset * 60_000)

  return at.toISOString()
}
