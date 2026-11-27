import { describe, expect, it } from 'vitest'
import { PICKABLE_EXTENSIONS, SUPPORTED_FORMAT_HINT, admissionProblem, formatFromFileName, sniffImageFormat } from './imageFormat'

/**
 * 格式判定只有一个来源：扩展名白名单（需求文档 FR-PHOTO-01）+ 文件头魔数。
 * "认得出来"与"允许导入"是两件事，后者见下面的「导入准入」。
 */

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0))
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

describe('formatFromFileName', () => {
  it('识别白名单内的扩展名，大小写不敏感', () => {
    expect(formatFromFileName('IMG_0001.JPG')).toBe('jpeg')
    expect(formatFromFileName('国庆.HEIC')).toBe('heic')
    expect(formatFromFileName('a.jpeg')).toBe('jpeg')
    expect(formatFromFileName('a.png')).toBe('png')
    expect(formatFromFileName('a.webp')).toBe('webp')
  })

  it('白名单之外一律不支持，不做猜测', () => {
    expect(formatFromFileName('a.heif')).toBeNull()
    expect(formatFromFileName('a.tif')).toBeNull()
    expect(formatFromFileName('a.bmp')).toBeNull()
    expect(formatFromFileName('a.gif')).toBeNull()
    expect(formatFromFileName('无扩展名')).toBeNull()
    expect(formatFromFileName('.png')).toBeNull()
    expect(formatFromFileName('a.')).toBeNull()
  })
})

describe('sniffImageFormat', () => {
  it('认出四种格式的文件头', () => {
    expect(sniffImageFormat(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 4, ...ascii('JFIF')))).toBe('jpeg')
    expect(sniffImageFormat(bytes(0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png')
    expect(
      sniffImageFormat(bytes(...ascii('RIFF'), 0x2c, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 ')))
    ).toBe('webp')
    expect(sniffImageFormat(bytes(0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('heic'), 0, 0, 0, 0))).toBe('heic')
  })

  it('HEIC 认全部 libheif 认可的母品牌', () => {
    for (const brand of ['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx']) {
      expect(sniffImageFormat(bytes(0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii(brand))), brand).toBe('heic')
    }
  })

  it('AVIF 与未知内容不是 HEIC，不能靠扩展名蒙混', () => {
    expect(sniffImageFormat(bytes(0, 0, 0, 0x20, ...ascii('ftyp'), ...ascii('avif'), 0, 0, 0, 0))).toBeNull()
    expect(sniffImageFormat(bytes(...ascii('GIF89a'), 1, 2, 3))).toBeNull()
    expect(sniffImageFormat(bytes(0x00, 0x01, 0x02))).toBeNull()
    expect(sniffImageFormat(bytes())).toBeNull()
  })

  it('文件太短读不出品牌时判为未知', () => {
    expect(sniffImageFormat(bytes(...ascii('ftyp')))).toBeNull()
  })
})

describe('导入准入', () => {
  it('HEIC 认得出来但 M1 不放行，提示要说清下一步（总体设计稿 §10.1 挂账 T3-HEIC）', () => {
    expect(admissionProblem('heic')).toBe('HEIC 暂不开放导入，可先在手机或系统照片里转成 JPG 再导入')
    expect(admissionProblem('jpeg')).toBeNull()
    expect(admissionProblem('png')).toBeNull()
    expect(admissionProblem('webp')).toBeNull()
  })

  it('提示语与选择器扩展名都由放行清单派生，不与准入表分叉', () => {
    expect(SUPPORTED_FORMAT_HINT).toBe('JPG/JPEG、PNG、WebP')
    expect(PICKABLE_EXTENSIONS).toEqual(['jpg', 'jpeg', 'png', 'webp'])
  })
})
