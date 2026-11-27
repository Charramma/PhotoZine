/**
 * 面向用户的错误说明（AGENTS.md §3.10）：只说"发生了什么 + 下一步怎么办"，
 * 堆栈与原生库的多行诊断留在日志里，不抛给用户。
 */

const REASON_MAX_CHARS = 200

/** 取错误信息的第一行并截断：libvips 等原生库会连吐几十行 seek 细节 */
export function userReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split(/\r?\n/).find((line) => line.trim() !== '') ?? message.trim()
  return firstLine.length > REASON_MAX_CHARS ? `${firstLine.slice(0, REASON_MAX_CHARS)}…` : firstLine
}
