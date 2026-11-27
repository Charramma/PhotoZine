import { describe, expect, it } from 'vitest'
import { PZFILE_ROOT_PROJECT, PZFILE_SCHEME } from '../domain/constants'
import { pzfileUrl } from './pzfileUrl'

describe('pzfileUrl', () => {
  it('常规相对路径按段拼接', () => {
    expect(pzfileUrl(PZFILE_ROOT_PROJECT, 'thumbnails/3f2a.jpg')).toBe(`${PZFILE_SCHEME}://project/thumbnails/3f2a.jpg`)
  })

  it('逐段编码：中文、空格与名字里的百分号都能取到', () => {
    expect(pzfileUrl(PZFILE_ROOT_PROJECT, 'photos/50%折扣.jpg')).toBe(
      `${PZFILE_SCHEME}://project/photos/50%25%E6%8A%98%E6%89%A3.jpg`
    )
    expect(pzfileUrl(PZFILE_ROOT_PROJECT, 'photos/IMG 0001.jpg')).toContain('IMG%200001.jpg')
  })

  it('越界与非法写法不生成 URL', () => {
    expect(pzfileUrl(PZFILE_ROOT_PROJECT, '../Windows/win.ini')).toBeNull()
    expect(pzfileUrl(PZFILE_ROOT_PROJECT, 'photos/../../etc/passwd')).toBeNull()
    expect(pzfileUrl(PZFILE_ROOT_PROJECT, '/etc/passwd')).toBeNull()
    expect(pzfileUrl(PZFILE_ROOT_PROJECT, '')).toBeNull()
  })

  it('折叠 . 与结尾分隔符，不把冗余写法送进 URL', () => {
    expect(pzfileUrl(PZFILE_ROOT_PROJECT, 'derived/./heic/a.jpg/')).toBe(`${PZFILE_SCHEME}://project/derived/heic/a.jpg`)
  })
})
