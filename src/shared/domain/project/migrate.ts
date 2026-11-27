import { PROJECT_SCHEMA_VERSION } from './schema'
import type { Issue } from './invariants'

/**
 * `schemaVersion` 迁移链（总体设计稿 §3、AGENTS.md §5.7）。
 * 只支持向上；文件版本高于应用 → 交由调用方走只读打开，不写回。
 * 每次迁移后由本模块统一写回 `schemaVersion`，迁移函数不必（也不允许）自己改版本号。
 */

export interface Migration {
  readonly from: number
  readonly to: number
  readonly label: string
  readonly apply: (document: Record<string, unknown>) => Record<string, unknown>
}

/** v1 是当前版本，尚无历史版本需要迁移；新增版本时在此按序追加并补夹具测试 */
export const projectMigrations: readonly Migration[] = []

export type MigrationOutcome =
  | { kind: 'current'; document: Record<string, unknown> }
  | { kind: 'migrated'; document: Record<string, unknown>; steps: Issue[] }
  | { kind: 'newer-version'; version: number; document: Record<string, unknown> }
  | { kind: 'unsupported-version'; version: number }
  | { kind: 'invalid'; message: string }

export function migrateProject(raw: unknown, migrations: readonly Migration[]): MigrationOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'invalid', message: '项目文件内容不是 JSON 对象' }
  }

  const document: Record<string, unknown> = raw as Record<string, unknown>
  const declared: unknown = document['schemaVersion']
  // 0 是合法的历史起点（迁移链未覆盖它时报"不支持的版本"），缺失/非整数/负数才是损坏
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 0) {
    return { kind: 'invalid', message: '缺少 schemaVersion 或其不是非负整数（I-01）' }
  }
  if (declared > PROJECT_SCHEMA_VERSION) {
    return { kind: 'newer-version', version: declared, document }
  }
  if (declared === PROJECT_SCHEMA_VERSION) {
    return { kind: 'current', document }
  }

  let current = document
  let from = declared
  const steps: Issue[] = []
  while (from < PROJECT_SCHEMA_VERSION) {
    const migration = migrations.find((candidate) => candidate.from === from)
    if (migration === undefined) {
      return { kind: 'unsupported-version', version: declared }
    }
    if (migration.to <= from) {
      return { kind: 'invalid', message: `迁移链配置错误：${migration.label}` }
    }
    current = migration.apply(current)
    current['schemaVersion'] = migration.to
    steps.push({ path: 'schemaVersion', message: `已迁移 v${migration.from} → v${migration.to}（${migration.label}）` })
    from = migration.to
  }

  return { kind: 'migrated', document: current, steps }
}
