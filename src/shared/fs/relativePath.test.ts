import { describe, expect, it } from 'vitest'
import { normalizeNameSegment, normalizeRelativePath, sanitizeNameSegment } from './relativePath'

describe('normalizeRelativePath', () => {
  it('保留正常相对路径并折叠 . 与结尾分隔符', () => {
    expect(normalizeRelativePath('photos/IMG_001.jpg')).toBe('photos/IMG_001.jpg')
    expect(normalizeRelativePath('photos/./a.jpg')).toBe('photos/a.jpg')
    expect(normalizeRelativePath('photos/a.jpg/')).toBe('photos/a.jpg')
    expect(normalizeRelativePath('a')).toBe('a')
    expect(normalizeRelativePath('derived/preview/p_1@2480.jpg')).toBe('derived/preview/p_1@2480.jpg')
  })

  it('中文文件名可用', () => {
    expect(normalizeRelativePath('photos/国庆.jpg')).toBe('photos/国庆.jpg')
  })

  it('不做百分号解码：解码是 URL 侧的职责，文件名里的 % 是合法字符', () => {
    expect(normalizeRelativePath('photos/50%折扣.jpg')).toBe('photos/50%折扣.jpg')
    expect(normalizeRelativePath('photos/%E5%9B%BD.jpg')).toBe('photos/%E5%9B%BD.jpg')
    expect(normalizeRelativePath('photos/%zz')).toBe('photos/%zz')
  })

  it('拒绝越出根目录', () => {
    expect(normalizeRelativePath('../etc/passwd')).toBeNull()
    expect(normalizeRelativePath('photos/../../Windows/win.ini')).toBeNull()
    expect(normalizeRelativePath('photos/..')).toBeNull()
    // 百分号形式必须由 URL 侧先解码再交给本函数，这里按字面量看待，不构成越界
    expect(normalizeRelativePath('%2e%2e/%2e%2e/Windows')).toBe('%2e%2e/%2e%2e/Windows')
  })

  it('拒绝绝对路径、盘符、反斜杠、控制字符与空输入', () => {
    expect(normalizeRelativePath('/etc/passwd')).toBeNull()
    expect(normalizeRelativePath('C:/Windows/win.ini')).toBeNull()
    expect(normalizeRelativePath('C:foo')).toBeNull()
    expect(normalizeRelativePath('\\\\nas\\share\\x')).toBeNull()
    expect(normalizeRelativePath('photos\\IMG_001.jpg')).toBeNull()
    expect(normalizeRelativePath('photos/a\u0000.jpg')).toBeNull()
    expect(normalizeRelativePath('photos/a\u007fb.jpg')).toBeNull()
    expect(normalizeRelativePath('')).toBeNull()
    expect(normalizeRelativePath('./')).toBeNull()
    expect(normalizeRelativePath('///')).toBeNull()
  })

  it('拒绝 Windows 下无法成立或会被静默改写的名字', () => {
    expect(normalizeRelativePath('photos/a.jpg.')).toBeNull()
    expect(normalizeRelativePath('photos/a ')).toBeNull()
    // 这些字符在 Windows 文件名里非法，落盘必然失败
    expect(normalizeRelativePath('photos/a:b.jpg')).toBeNull()
    expect(normalizeRelativePath('photos/a<b>.jpg')).toBeNull()
    expect(normalizeRelativePath('photos/a?.jpg')).toBeNull()
    expect(normalizeRelativePath('photos/a".jpg')).toBeNull()
    expect(normalizeRelativePath('photos/a|.jpg')).toBeNull()
    expect(normalizeRelativePath('photos/a*.jpg')).toBeNull()
    // 结尾点号与冒号会让 NTFS 把内容写进备用数据流而不是文件本体
    expect(normalizeRelativePath('photos/a.txt:hidden')).toBeNull()
  })
})

describe('normalizeNameSegment', () => {
  it('只接受单段名字，多级相对路径一律拒绝', () => {
    expect(normalizeNameSegment('国庆.jpg')).toBe('国庆.jpg')
    expect(normalizeNameSegment('50%折扣.jpg')).toBe('50%折扣.jpg')
    expect(normalizeNameSegment('photos/国庆.jpg')).toBeNull()
    expect(normalizeNameSegment('con.jpg')).toBeNull()
    expect(normalizeNameSegment('a:b.jpg')).toBeNull()
    expect(normalizeNameSegment('')).toBeNull()
  })
})

describe('sanitizeNameSegment', () => {
  it('合法名字原样保留', () => {
    expect(sanitizeNameSegment('国庆.jpg')).toBe('国庆.jpg')
    expect(sanitizeNameSegment('IMG_0001.JPG')).toBe('IMG_0001.JPG')
    expect(sanitizeNameSegment('50%折扣.jpg')).toBe('50%折扣.jpg')
    expect(sanitizeNameSegment('..草稿.jpg')).toBe('..草稿.jpg')
  })

  it('把 Windows 非法字符与控制字符替换为下划线', () => {
    expect(sanitizeNameSegment('a:b.jpg')).toBe('a_b.jpg')
    expect(sanitizeNameSegment('a<b>|"?*.jpg')).toBe('a_b_____.jpg')
    expect(sanitizeNameSegment('a\\b/c.jpg')).toBe('a_b_c.jpg')
    expect(sanitizeNameSegment('a\u0000b.jpg')).toBe('a_b.jpg')
  })

  it('去掉会被文件系统静默丢弃的结尾点号与空格', () => {
    expect(sanitizeNameSegment('a.jpg...')).toBe('a.jpg')
    expect(sanitizeNameSegment('a  ')).toBe('a')
  })

  it('保留名加前缀而不是拒绝', () => {
    expect(sanitizeNameSegment('con.jpg')).toBe('_con.jpg')
    expect(sanitizeNameSegment('NUL')).toBe('_NUL')
  })

  it('清洗不出合法名字时返回 null，由调用方拒绝', () => {
    expect(sanitizeNameSegment('.')).toBeNull()
    expect(sanitizeNameSegment('..')).toBeNull()
    expect(sanitizeNameSegment('')).toBeNull()
    expect(sanitizeNameSegment('   ')).toBeNull()
  })
})
