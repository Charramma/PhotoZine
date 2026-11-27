import { describe, expect, it } from 'vitest'
import { makeDocument } from './__fixtures__/document'
import { migrateProject, projectMigrations, type Migration } from './migrate'
import { PROJECT_SCHEMA_VERSION } from './schema'

/** 当前只有 v1，尚无真实历史文件；第一个真实版本升级落地时必须补磁盘历史夹具用例（总体设计稿 §9） */
const legacyV0 = {
  version: 0,
  title: '夏日纪行',
  items: [{ file: 'IMG_1.jpg', note: '海边的清晨' }],
  pages: []
} as Record<string, unknown>

const v0ToV1: Migration = {
  from: 0,
  to: PROJECT_SCHEMA_VERSION,
  label: '引入结构化描述',
  apply: (document) => ({
    schemaVersion: document['schemaVersion'],
    meta: {
      id: '00000000-0000-4000-8000-000000000001',
      name: document['title'],
      subtitle: '',
      coverPhotoId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    layout: { templateId: 'editorial-white', pageSize: 'A4-portrait', showPageNumbers: true },
    export: { quality: 'dpi300', includeCover: true },
    photos: [],
    pages: document['pages']
  })
}

describe('schemaVersion 迁移链', () => {
  it('当前版本没有需要执行的迁移', () => {
    expect(projectMigrations).toEqual([])
  })

  it('当前版本原样返回，不产生迁移步骤', () => {
    const document = makeDocument()
    const outcome = migrateProject(document, projectMigrations)
    expect(outcome.kind).toBe('current')
    if (outcome.kind === 'current') expect(outcome.document).toEqual(document)
  })

  it('文件版本高于应用时交只读处理，不尝试迁移', () => {
    const source = { ...makeDocument(), schemaVersion: PROJECT_SCHEMA_VERSION + 2 }
    const outcome = migrateProject(source, projectMigrations)
    expect(outcome.kind).toBe('newer-version')
    if (outcome.kind !== 'newer-version') return
    expect(outcome.version).toBe(PROJECT_SCHEMA_VERSION + 2)
    // 原样交给只读路径，由存储层用宽松形状读取
    expect(outcome.document).toEqual(source)
  })

  it('I-01：schemaVersion 缺失、非整数或负数判为损坏', () => {
    const chain = [v0ToV1]
    for (const raw of [{}, { schemaVersion: -1 }, { schemaVersion: 1.5 }, { schemaVersion: '1' }, { schemaVersion: null }]) {
      expect(migrateProject(raw, chain).kind).toBe('invalid')
    }
    expect(migrateProject([], chain).kind).toBe('invalid')
    expect(migrateProject('text', chain).kind).toBe('invalid')
    expect(migrateProject(null, chain).kind).toBe('invalid')
  })

  it('版本低于迁移链起点时报"不支持"，而不是当成损坏', () => {
    expect(migrateProject({ schemaVersion: 0 }, projectMigrations)).toEqual({ kind: 'unsupported-version', version: 0 })
  })

  it('注入历史链时逐级向上，版本由框架统一写回', () => {
    const outcome = migrateProject({ ...legacyV0, schemaVersion: 0 }, [v0ToV1])
    expect(outcome.kind).toBe('migrated')
    if (outcome.kind !== 'migrated') return
    expect(outcome.document['schemaVersion']).toBe(PROJECT_SCHEMA_VERSION)
    expect(outcome.steps.map((step) => step.message).join()).toContain('v0 → v1')
    expect(outcome.document['meta']).toMatchObject({ name: '夏日纪行' })
    expect(outcome.document['version']).toBeUndefined()
  })

  it('迁移函数自己写错版本号也会被框架纠正', () => {
    const rogue: Migration = {
      from: 0,
      to: PROJECT_SCHEMA_VERSION,
      label: '忽略入参版本',
      apply: () => ({ schemaVersion: 0, stale: true })
    }
    const outcome = migrateProject({ schemaVersion: 0 }, [rogue])
    expect(outcome.kind === 'migrated' ? outcome.document['schemaVersion'] : null).toBe(PROJECT_SCHEMA_VERSION)
  })

  it('链中版本不倒退，配置错误时判为损坏而不是死循环', () => {
    const backward: Migration = {
      from: 0,
      to: 0,
      label: '错误链',
      apply: (document) => document
    }
    expect(migrateProject({ schemaVersion: 0 }, [backward]).kind).toBe('invalid')
  })
})
