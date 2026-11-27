import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_DIRS, PROJECT_FILES, PROJECT_SKELETON_DIRS } from '@shared/domain/constants'
import { makeDocument, makeDocumentJson, PHOTO_IDS } from '@shared/domain/project/__fixtures__/document'
import type { PatternLookup } from '@shared/domain/project/invariants'
import { projectDocumentSchema, type ProjectDocument } from '@shared/domain/project/schema'
import type { LockOwner } from './projectLock'
import { projectPath } from './projectPath'
import { closeProject, openProject, saveProject, type OpenedProject } from './projectStore'

/** 真实磁盘目录 + 真实文件，不使用内存桩（AGENTS.md §2.2） */

const noPatterns: PatternLookup = () => undefined

const created: string[] = []

const dataPath = (root: string): string => path.join(root, PROJECT_FILES.data)
const backupPath = (root: string): string => path.join(root, PROJECT_FILES.backup)
const lockPath = (root: string): string => path.join(root, PROJECT_FILES.lock)
const damagedPath = (root: string): string => path.join(root, PROJECT_FILES.damaged)
const readText = (file: string): Promise<string> => readFile(file, 'utf8')
const writeText = (file: string, text: string): Promise<void> => writeFile(file, text, 'utf8')
const readJson = async <T extends object>(file: string): Promise<T> =>
  JSON.parse(await readText(file)) as T
const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false)
const readLock = (root: string): Promise<LockOwner> => readJson<LockOwner>(lockPath(root))

async function makeProjectRoot(document: ProjectDocument = makeDocument()): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pz-project-'))
  created.push(root)
  await mkdir(path.join(root, PROJECT_DIRS.photos), { recursive: true })
  for (const photo of document.photos) {
    await writeText(path.join(root, PROJECT_DIRS.photos, photo.fileName), '原始字节')
  }
  await writeText(dataPath(root), makeDocumentJson(document))
  return root
}

async function openOk(root: string): Promise<OpenedProject> {
  const outcome = await openProject(root, noPatterns)
  if (outcome.kind !== 'opened') {
    const detail = outcome.kind === 'corrupt' ? JSON.stringify(outcome.errors) : ''
    throw new Error(`打开项目失败：${outcome.kind} ${detail}`)
  }
  return outcome.project
}

async function savedOk(root: string, document: ProjectDocument): Promise<ProjectDocument> {
  const outcome = await saveProject(root, document)
  if (outcome.kind !== 'saved') throw new Error(`保存失败：${outcome.kind}`)
  return outcome.document
}

/** 保存一次以生成真实的 `.bak`（其内容是上一版落盘文本），然后关闭会话 */
async function seedBackup(root: string): Promise<void> {
  await savedOk(root, (await openOk(root)).document)
  await closeProject(root)
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map(async (root) => {
      await closeProject(root)
      await rm(root, { recursive: true, force: true })
    })
  )
})

describe('打开项目', () => {
  it('合法项目：文档可读、无修复项、锁文件已建立；关闭后锁消失', async () => {
    const root = await makeProjectRoot()
    const project = await openOk(root)

    expect(project.document).toEqual(makeDocument())
    expect(project.fixes).toEqual([])
    expect(project.warnings).toEqual([])
    expect(project.missingPhotoIds).toEqual([])
    expect(project.readOnlyReason).toBeNull()
    expect((await readLock(root)).pid).toBe(process.pid)

    await closeProject(root)
    expect(await exists(lockPath(root))).toBe(false)
  })

  it('目录里没有 project.json 时判为"不是项目"，不创建任何文件', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pz-empty-'))
    created.push(root)
    expect(await openProject(root, noPatterns)).toEqual({ kind: 'not-a-project' })
    expect(await exists(lockPath(root))).toBe(false)
  })

  it('同一进程重复打开同一目录直接拒绝，不产生第二份会话', async () => {
    const root = await makeProjectRoot()
    await openOk(root)
    expect(await openProject(path.join(root, '.'), noPatterns)).toEqual({ kind: 'already-open' })
  })

  it('I-06：原图文件缺失只标记，不阻断打开', async () => {
    const root = await makeProjectRoot()
    const project = await openOk(root)
    const gone = project.document.photos[1]
    if (!gone) throw new Error('夹具应有两张照片')
    await rm(path.join(root, PROJECT_DIRS.photos, gone.fileName))

    await closeProject(root)
    const reopened = await openOk(root)
    expect(reopened.missingPhotoIds).toEqual([gone.id])
    expect(reopened.warnings.some((issue) => issue.message.includes('I-06'))).toBe(true)
  })

  it('自动修复项只上报，打开过程绝不写盘', async () => {
    const broken = makeDocument({
      meta: { ...makeDocument().meta, coverPhotoId: '99999999-9999-4999-8999-999999999999' }
    })
    const root = await makeProjectRoot(broken)
    const before = await readText(dataPath(root))

    const project = await openOk(root)
    expect(project.document.meta.coverPhotoId).toBeNull()
    expect(project.fixes.some((fix) => fix.message.includes('I-05'))).toBe(true)
    expect(await readText(dataPath(root))).toBe(before)
  })

  it('未知字段记为告警并从内存文档中剔除', async () => {
    const root = await makeProjectRoot()
    await writeText(dataPath(root), JSON.stringify({ ...makeDocument(), legacyIntro: '旧字段' }, null, 2))

    const project = await openOk(root)
    expect(project.warnings.some((issue) => issue.message === '未知字段已剔除')).toBe(true)
    expect(project.document).not.toHaveProperty('legacyIntro')
  })

  it('文件版本高于应用：只读展示内容，不占项目锁，也不可写', async () => {
    const root = await makeProjectRoot()
    const newer = { ...makeDocument(), schemaVersion: 9 }
    await writeText(dataPath(root), JSON.stringify(newer, null, 2))

    const outcome = await openProject(root, noPatterns)
    expect(outcome.kind).toBe('newer-version')
    if (outcome.kind !== 'newer-version') return
    expect(outcome.version).toBe(9)
    expect(outcome.document.meta.name).toBe(makeDocument().meta.name)
    expect(await exists(lockPath(root))).toBe(false)
    expect(await saveProject(root, makeDocument())).toEqual({ kind: 'not-open' })
  })

  it('抢锁失败降级只读，写入被拒绝，且绝不抢走他人的锁（D-12）', async () => {
    const root = await makeProjectRoot()
    const foreign: LockOwner = { pid: 999_999, machine: 'other-machine', heartbeatAt: new Date().toISOString() }
    await writeText(lockPath(root), JSON.stringify(foreign))
    // 只读会话不碰用户目录：持有者可能正在往 `.tmp/<uuid>/` 写导入中的照片
    const otherSessionScratch = projectPath(root, `${PROJECT_DIRS.scratch}/另一实例的导入`)
    await mkdir(otherSessionScratch, { recursive: true })
    await writeText(path.join(otherSessionScratch, 'IMG_0001.jpg'), '半张图')

    const project = await openOk(root)
    expect(project.readOnlyReason).toContain('该项目已在别处打开')
    expect((await saveProject(root, project.document)).kind).toBe('refused')
    expect((await readLock(root)).machine).toBe('other-machine')
    expect(await readdir(otherSessionScratch)).toEqual(['IMG_0001.jpg'])
    expect(await exists(projectPath(root, PROJECT_DIRS.thumbnails))).toBe(false)
  })

  it('主文件损坏时回退备份，打开过程不改写任何文件', async () => {
    const root = await makeProjectRoot()
    await seedBackup(root)
    const backupText = await readText(backupPath(root))
    const corrupt = '{ 坏掉的主文件'
    await writeText(dataPath(root), corrupt)

    const project = await openOk(root)
    expect(project.document).toEqual(makeDocument())
    expect(project.warnings[0]?.message).toContain('已损坏')
    // 损坏文本原样留在磁盘，备份未被覆盖，也没有多出诊断文件
    expect(await readText(dataPath(root))).toBe(corrupt)
    expect(await readText(backupPath(root))).toBe(backupText)
    expect(await exists(damagedPath(root))).toBe(false)
  })

  it('主文件与备份都不可用时只报恢复指引，两个文件都不动', async () => {
    const root = await makeProjectRoot()
    const corrupt = '{ 坏掉的主文件'
    const corruptBackup = '{ 坏掉的备份文件'
    await writeText(dataPath(root), corrupt)
    await writeText(backupPath(root), corruptBackup)

    const outcome = await openProject(root, noPatterns)
    expect(outcome.kind).toBe('corrupt')
    expect(await readText(dataPath(root))).toBe(corrupt)
    expect(await readText(backupPath(root))).toBe(corruptBackup)
    expect(await exists(lockPath(root))).toBe(false)
  })

  it('断电模拟：上次中断留下的 project.json.tmp 不影响打开，且会被清掉', async () => {
    const root = await makeProjectRoot()
    const staging = path.join(root, PROJECT_FILES.staging)
    const original = await readText(dataPath(root))
    await writeText(staging, '{ 半成品')

    const project = await openOk(root)
    expect(project.document).toEqual(makeDocument())
    expect(await readText(dataPath(root))).toBe(original)
    expect(await exists(staging)).toBe(false)
  })
})

describe('保存项目', () => {
  it('原子写：新内容落到 project.json，上一次成功写入的内容进 .bak', async () => {
    const root = await makeProjectRoot()
    const project = await openOk(root)
    const first = { ...project.document, meta: { ...project.document.meta, name: '第一版' } }

    const saved = await savedOk(root, first)
    const onDisk = projectDocumentSchema.parse(await readJson(dataPath(root)))
    expect(onDisk.meta.name).toBe('第一版')
    expect(saved.meta.updatedAt).toBe(onDisk.meta.updatedAt)
    expect(Date.parse(onDisk.meta.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.meta.updatedAt))

    await savedOk(root, { ...onDisk, meta: { ...onDisk.meta, name: '第二版' } })
    const backup = projectDocumentSchema.parse(await readJson(backupPath(root)))
    const current = projectDocumentSchema.parse(await readJson(dataPath(root)))
    expect(backup.meta.name).toBe('第一版')
    expect(current.meta.name).toBe('第二版')
  })

  it('写盘串行队列：并发保存不交错，最后写入的是最后一次提交', async () => {
    const root = await makeProjectRoot()
    const project = await openOk(root)
    const outcomes = await Promise.all(
      ['甲', '乙', '丙'].map((name) =>
        saveProject(root, { ...project.document, meta: { ...project.document.meta, name } })
      )
    )
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['saved', 'saved', 'saved'])

    const onDisk = await readJson<{ meta: { name: string } }>(dataPath(root))
    expect(onDisk.meta.name).toBe('丙')
    expect(projectDocumentSchema.safeParse(onDisk).success).toBe(true)
  })

  it('回退备份后的首次保存：损坏文本进诊断文件而不是备份', async () => {
    const root = await makeProjectRoot()
    await seedBackup(root)
    const goodBackup = await readText(backupPath(root))
    const corrupt = '{ 坏掉的主文件'
    await writeText(dataPath(root), corrupt)

    const project = await openOk(root)
    const recovered = { ...project.document, meta: { ...project.document.meta, name: '恢复后' } }
    expect((await saveProject(root, recovered)).kind).toBe('saved')

    expect(await readText(backupPath(root))).toBe(goodBackup)
    expect(await readText(damagedPath(root))).toBe(corrupt)
    const onDisk = projectDocumentSchema.parse(await readJson(dataPath(root)))
    expect(onDisk.meta.name).toBe('恢复后')
  })

  it('磁盘被外部改动时拒绝写入并报冲突，不覆盖别人的内容', async () => {
    const root = await makeProjectRoot()
    const project = await openOk(root)
    const foreign = { ...makeDocument(), meta: { ...makeDocument().meta, name: '外部修改' } }
    await writeText(dataPath(root), makeDocumentJson(foreign))
    const later = new Date(Date.now() + 60_000)
    await utimes(dataPath(root), later, later)

    expect((await saveProject(root, project.document)).kind).toBe('conflict')
    expect(await readText(dataPath(root))).toBe(makeDocumentJson(foreign))
  })

  it('project.json 被外部删除时同样报冲突，而不是静默重建', async () => {
    const root = await makeProjectRoot()
    const project = await openOk(root)
    await rm(dataPath(root))

    expect(await saveProject(root, project.document)).toEqual({ kind: 'conflict', diskMtimeMs: 0 })
  })

  it('不符合契约的文档一律拒写，磁盘保持原样', async () => {
    const root = await makeProjectRoot()
    const project = await openOk(root)
    const original = await readText(dataPath(root))
    const invalid = { ...project.document, photos: [{ id: 'x' }] } as unknown as ProjectDocument

    expect((await saveProject(root, invalid)).kind).toBe('rejected')
    expect(await readText(dataPath(root))).toBe(original)
  })

  it('未打开的项目不可写', async () => {
    const root = await makeProjectRoot()
    expect(await saveProject(root, makeDocument())).toEqual({ kind: 'not-open' })
  })

  it('保存后再打开：重启顺序与内容不变（FR-ORDER-01 前置）', async () => {
    const root = await makeProjectRoot()
    const project = await openOk(root)
    const reordered = [...project.document.photos].reverse()
    await savedOk(root, { ...project.document, photos: reordered })
    await closeProject(root)

    const reopened = await openOk(root)
    expect(reopened.document.photos.map((photo) => photo.id)).toEqual([PHOTO_IDS[1], PHOTO_IDS[0]])
    expect(reopened.fixes).toEqual([])
  })
})

describe('目录骨架与半成品', () => {
  it('打开项目补齐骨架，被删掉的缓存目录再次打开时重建（AGENTS.md §5.5）', async () => {
    const root = await makeProjectRoot()
    await openOk(root)
    for (const dir of PROJECT_SKELETON_DIRS) {
      expect((await stat(projectPath(root, dir))).isDirectory(), dir).toBe(true)
    }

    await closeProject(root)
    await rm(projectPath(root, PROJECT_DIRS.derivedHeic), { recursive: true, force: true })
    await openOk(root)
    expect((await stat(projectPath(root, PROJECT_DIRS.derivedHeic))).isDirectory()).toBe(true)
  })

  it('打开时清掉 .tmp 半成品与遗留的写盘临时文件，项目数据一个字都不动', async () => {
    const root = await makeProjectRoot()
    const scratch = projectPath(root, PROJECT_DIRS.scratch)
    const halfImport = path.join(scratch, '3f2a1b0c-0000-4000-8000-000000000001')
    await mkdir(halfImport, { recursive: true })
    await writeText(path.join(halfImport, 'IMG_0001.jpg'), '半张图')
    await writeText(path.join(scratch, '导出半成品.pdf'), '半本')
    await writeText(projectPath(root, PROJECT_FILES.staging), '{"schemaVersion":1, 截断')
    const before = await readText(dataPath(root))

    await openOk(root)

    expect(await readdir(scratch)).toEqual([])
    expect(await exists(projectPath(root, PROJECT_FILES.staging))).toBe(false)
    expect(await readText(dataPath(root))).toBe(before)
  })
})
