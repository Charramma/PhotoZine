import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { emptyProject } from './emptyProject.mjs'

/**
 * 开发期用的新建项目命令：`node scripts/new-project.mjs <父目录> <项目名>`
 *
 * 只写一个 `project.json`，目录骨架由应用打开项目时（持有项目锁）补齐。
 * 正式的"创建项目"入口（名称校验、父目录预检、同名建议）属需求文档 FR-PROJ-01，
 * 那一步落地后本脚本就可以删除。
 */
const [parent, name] = process.argv.slice(2)
if (parent === undefined || name === undefined || name.trim() === '') {
  console.error('用法：node scripts/new-project.mjs <父目录> <项目名>')
  process.exitCode = 1
} else {
  const root = path.join(path.resolve(parent), name.trim())
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'project.json'), `${JSON.stringify(emptyProject({ name: name.trim() }), null, 2)}\n`, 'utf8')
  console.log(root)
}
