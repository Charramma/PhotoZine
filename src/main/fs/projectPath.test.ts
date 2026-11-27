import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWithinRoot, projectPath, resolveInRoot } from './projectPath'

/** 项目根内路径解析的唯一实现（AGENTS.md §5.3）：越界必须返回 null，而不是猜测意图 */

const ROOT = process.platform === 'win32' ? 'D:\\相册\\我的项目' : '/相册/我的项目'
const ASCII_ROOT = process.platform === 'win32' ? 'D:\\Pz\\Root' : '/Pz/Root'
const onWindows = process.platform === 'win32'

describe('projectPath', () => {
  it('把 POSIX 相对路径拼成平台绝对路径', () => {
    const joined = projectPath(ROOT, 'derived/preview')
    expect(path.isAbsolute(joined)).toBe(true)
    expect(joined.endsWith(`preview`)).toBe(true)
    expect(isWithinRoot(ROOT, joined)).toBe(true)
  })

  it.runIf(onWindows)('不残留 POSIX 分隔符，根目录多余尾分隔符也不影响结果', () => {
    const joined = projectPath(ROOT, 'derived/preview')
    expect(joined).not.toContain('/')
    expect(projectPath(ROOT + '\\', 'photos')).toBe(projectPath(ROOT, 'photos'))
  })
})

describe('resolveInRoot', () => {
  it('根内的正常路径解析为绝对路径', () => {
    expect(resolveInRoot(ROOT, 'photos/国庆.jpg')).toBe(projectPath(ROOT, 'photos/国庆.jpg'))
    expect(resolveInRoot(ROOT, 'derived/print/p1.jpg')).toBe(projectPath(ROOT, 'derived/print/p1.jpg'))
    expect(resolveInRoot(ROOT, 'export/杂志.pdf')).toBe(projectPath(ROOT, 'export/杂志.pdf'))
  })

  it('折叠 . 与结尾分隔符', () => {
    expect(resolveInRoot(ROOT, 'photos/./国庆.jpg')).toBe(projectPath(ROOT, 'photos/国庆.jpg'))
    expect(resolveInRoot(ROOT, 'thumbnails/x/')).toBe(projectPath(ROOT, 'thumbnails/x'))
  })

  it('以 .. 起始的合法文件名不算越界', () => {
    expect(resolveInRoot(ROOT, '..草稿.jpg')).toBe(projectPath(ROOT, '..草稿.jpg'))
    expect(resolveInRoot(ROOT, 'photos/..隐藏 1.jpg')).toBe(projectPath(ROOT, 'photos/..隐藏 1.jpg'))
  })

  it('拒绝越出根目录的各种写法', () => {
    for (const bad of [
      '../outside.jpg',
      'photos/../../Windows/win.ini',
      'a/b/../../..',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'C:foo',
      '\\\\nas\\share\\x',
      'photos\\IMG_001.jpg',
      'photos/con.jpg',
      'photos/a:b.jpg',
      '',
      '.'
    ]) {
      expect(resolveInRoot(ROOT, bad), bad).toBeNull()
    }
  })

  it('未解码的百分号形式按字面量看待，仍是根内的合法名字', () => {
    expect(resolveInRoot(ROOT, 'photos/50%折扣.jpg')).toBe(projectPath(ROOT, 'photos/50%折扣.jpg'))
    expect(resolveInRoot(ROOT, 'photos/..%2f..%2fWindows')).toBe(projectPath(ROOT, 'photos/..%2f..%2fWindows'))
  })
})

describe('isWithinRoot', () => {
  it('相邻目录名共用字符串前缀不算根内', () => {
    const root = projectPath(ASCII_ROOT, 'Project')
    expect(isWithinRoot(root, projectPath(root, 'a.jpg'))).toBe(true)
    expect(isWithinRoot(root, root)).toBe(true)
    expect(isWithinRoot(root, `${root}${path.sep}..${path.sep}ProjectX${path.sep}a.jpg`)).toBe(false)
  })

  it('大小写：Windows 不区分、类 Unix 区分', () => {
    const lowerCaseTarget = onWindows
      ? 'd:\\pz\\root\\a.jpg'
      : '/pz/root/a.jpg'
    expect(isWithinRoot(ASCII_ROOT, lowerCaseTarget)).toBe(onWindows)
  })
})
