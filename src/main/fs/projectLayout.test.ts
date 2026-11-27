import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_DIRS, PROJECT_FILES, PROJECT_SKELETON_DIRS } from '@shared/domain/constants'
import { projectPath } from './projectPath'
import { ensureProjectSkeleton, sweepProjectScratch } from './projectLayout'

/** 真实磁盘目录，不使用内存桩（AGENTS.md §2.2） */

const created: string[] = []
const isDir = async (target: string): Promise<boolean> =>
  (await stat(target).catch(() => null))?.isDirectory() ?? false

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pz-layout-'))
  created.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ensureProjectSkeleton', () => {
  it('一次性建出全部目录，含嵌套的 derived 子目录', async () => {
    const root = await makeRoot()
    await ensureProjectSkeleton(root)
    for (const dir of PROJECT_SKELETON_DIRS) {
      expect(await isDir(projectPath(root, dir)), dir).toBe(true)
    }
  })

  it('幂等：重复调用不报错，已有文件与内容不受影响', async () => {
    const root = await makeRoot()
    const photo = projectPath(root, `${PROJECT_DIRS.photos}/国庆.jpg`)
    await mkdir(path.dirname(photo), { recursive: true })
    await writeFile(photo, '原始字节', 'utf8')

    await ensureProjectSkeleton(root)
    await ensureProjectSkeleton(root)

    expect(await readFile(photo, 'utf8')).toBe('原始字节')
  })

  it('缓存目录被删掉后重新打开即可补回（AGENTS.md §5.5）', async () => {
    const root = await makeRoot()
    await ensureProjectSkeleton(root)
    await rm(projectPath(root, PROJECT_DIRS.thumbnails), { recursive: true, force: true })
    await rm(projectPath(root, PROJECT_DIRS.derivedPrint), { recursive: true, force: true })

    await ensureProjectSkeleton(root)

    expect(await isDir(projectPath(root, PROJECT_DIRS.thumbnails))).toBe(true)
    expect(await isDir(projectPath(root, PROJECT_DIRS.derivedPrint))).toBe(true)
  })
})

describe('sweepProjectScratch', () => {
  it('清掉 .tmp 里的半成品目录与散落文件，但保留 .tmp 本身', async () => {
    const root = await makeRoot()
    await ensureProjectSkeleton(root)
    const scratch = projectPath(root, PROJECT_DIRS.scratch)
    const halfImport = path.join(scratch, '3f2a1b0c-0000-4000-8000-000000000001')
    await mkdir(halfImport, { recursive: true })
    await writeFile(path.join(halfImport, 'IMG_0001.jpg'), '半张图', 'utf8')
    await writeFile(path.join(scratch, 'export-part.pdf'), '半本 PDF', 'utf8')

    await sweepProjectScratch(root)

    expect(await isDir(scratch)).toBe(true)
    expect(await readdir(scratch)).toEqual([])
  })

  it('清掉上次崩溃留下的写盘半成品，项目数据与导出产物不动', async () => {
    const root = await makeRoot()
    await ensureProjectSkeleton(root)
    const staging = projectPath(root, PROJECT_FILES.staging)
    const exported = projectPath(root, `${PROJECT_DIRS.export}/杂志.pdf`)
    await writeFile(staging, '{"schemaVersion":1, 截断', 'utf8')
    await writeFile(exported, '成品', 'utf8')

    await sweepProjectScratch(root)

    expect(await stat(staging).catch(() => null)).toBeNull()
    expect(await readFile(exported, 'utf8')).toBe('成品')
  })

  it('.tmp 不存在或只是空目录时都不报错', async () => {
    const root = await makeRoot()
    await expect(sweepProjectScratch(root)).resolves.toBeUndefined()
    await ensureProjectSkeleton(root)
    await expect(sweepProjectScratch(root)).resolves.toBeUndefined()
  })
})
