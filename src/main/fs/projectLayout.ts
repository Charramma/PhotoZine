import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { PROJECT_DIRS, PROJECT_FILES, PROJECT_SKELETON_DIRS } from '@shared/domain/constants'
import { projectPath } from './projectPath'

/**
 * 项目目录骨架与半成品清理（总体设计稿 §3 目录、§7 故障表）。
 *
 * 骨架只在持有项目锁时建立与清扫：另一个实例可能正在往 `.tmp/<uuid>/` 写导入半成品，
 * 没拿到锁的一方绝不能删它的文件（D-12）。
 */

/** 建出目录骨架。幂等：已存在不报错，也不触碰任何已有文件（AGENTS.md §5.5 缺失即重建） */
export async function ensureProjectSkeleton(root: string): Promise<void> {
  await Promise.all(
    PROJECT_SKELETON_DIRS.map((dir) => mkdir(projectPath(root, dir), { recursive: true }))
  )
}

/**
 * 清扫半成品：`.tmp/` 下的一切与根目录遗留的写盘临时文件都可丢弃（总体设计稿 §7）。
 * 保留 `.tmp` 目录本身，由骨架初始化负责其存在性。
 */
export async function sweepProjectScratch(root: string): Promise<void> {
  const scratch = projectPath(root, PROJECT_DIRS.scratch)
  const leftovers = await readdir(scratch, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    leftovers.map((entry) => rm(path.join(scratch, entry.name), { recursive: true, force: true }))
  )
  await rm(projectPath(root, PROJECT_FILES.staging), { force: true })
}
