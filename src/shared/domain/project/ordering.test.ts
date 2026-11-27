import { describe, expect, it } from 'vitest'
import { makeDocument, makePhotoList, photoAt } from './__fixtures__/document'
import type { PageItem, PhotoItem, ProjectDocument } from './schema'
import {
  autoSortPhotos,
  countPhotosWithoutTime,
  moveItem,
  movePhotoInDocument,
  sameOrder,
  sortPhotosInDocument
} from './ordering'

/**
 * 顺序真值只有"数组下标"这一份（总体设计稿 D-09、AGENTS.md §5.2），所以这些用例盯的是：
 * 变更顺序的唯一入口会不会造出第二份真值、会不会把"其实没变化"的操作误标成脏。
 */

/** 把结果表达成"输入数组的下标序列"：顺序断言一眼可读，也不必从数组里抠单个元素 */
const orderOf = (result: readonly PhotoItem[], input: readonly PhotoItem[]): number[] =>
  result.map((photo) => input.indexOf(photo))

const idsOf = (items: readonly PhotoItem[]): string[] => items.map((item) => item.id)

/** 断言"确实产生了新顺序"，同时把 `| null` 收窄掉，免得测试里散落断言 */
function changed(next: ProjectDocument | null): ProjectDocument {
  if (next === null) throw new Error('期望产生新的文档顺序，实际返回 null')
  return next
}

describe('moveItem', () => {
  it('下移与上移都按下标语义搬移，其余元素相对顺序不变', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('原位、越界、空列表都返回 null，调用方据此不标脏', () => {
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toBeNull()
    expect(moveItem(['a', 'b', 'c'], -1, 1)).toBeNull()
    expect(moveItem(['a', 'b', 'c'], 0, 3)).toBeNull()
    expect(moveItem<string[]>([], 0, 0)).toBeNull()
  })

  it('返回新数组、元素保持同一引用，长度与集合不变，入参不被改动', () => {
    const photos = makePhotoList(4)
    const moved = moveItem(photos, 3, 0)
    if (moved === null) throw new Error('期望产生新顺序')
    expect(moved).not.toBe(photos)
    expect(moved).toHaveLength(photos.length)
    expect(orderOf(moved, photos)).toEqual([3, 0, 1, 2])
    expect(idsOf(photos)).toEqual(idsOf(makePhotoList(4)))
  })
})

describe('sameOrder', () => {
  it('只比标识序列，不看数组引用与元素内容', () => {
    const photos = makePhotoList(3)
    expect(sameOrder(photos, [...photos])).toBe(true)
    expect(sameOrder(photos, [...photos].reverse())).toBe(false)
    expect(sameOrder(photos, photos.slice(0, 2))).toBe(false)
  })
})

describe('autoSortPhotos：按拍摄时间', () => {
  const photos = makePhotoList(4, [
    { takenAt: '2026-01-01T00:00:00.000Z' },
    { takenAt: null },
    { takenAt: '2026-01-05T00:00:00.000Z' },
    { takenAt: '2026-13-45T99:00:00.000Z' }
  ])
  const sort = (direction: 'asc' | 'desc'): number[] =>
    orderOf(autoSortPhotos(photos, { by: 'takenAt', direction }), photos)

  it('升序，读不出时刻的（null 与畸形值）按原顺序置底', () => {
    expect(sort('asc')).toEqual([0, 2, 1, 3])
  })

  it('降序只翻转有时刻的部分，无时刻的仍然置底且保持原顺序', () => {
    expect(sort('desc')).toEqual([2, 0, 1, 3])
  })

  it('时刻相同的保持原相对顺序，结果可复现', () => {
    const sameInstant = '2026-03-03T08:00:00.000Z'
    const tied = makePhotoList(3, [sameInstant, sameInstant, sameInstant].map((takenAt) => ({ takenAt })))
    const later = makePhotoList(1, [{ takenAt: '2026-03-04T08:00:00.000Z' }])
    const input = [photoAt(tied, 2), photoAt(later, 0), photoAt(tied, 0), photoAt(tied, 1)]
    expect(orderOf(autoSortPhotos(input, { by: 'takenAt', direction: 'asc' }), input)).toEqual([0, 2, 3, 1])
    expect(orderOf(autoSortPhotos(input, { by: 'takenAt', direction: 'desc' }), input)).toEqual([1, 0, 2, 3])
  })

  it('统计读不出时刻的数量，供界面如实提示', () => {
    expect(countPhotosWithoutTime(photos)).toBe(2)
    expect(countPhotosWithoutTime(photos.slice(0, 1).concat(photos.slice(2, 3)))).toBe(0)
  })

  it('只换位置不改元素，也不可能顺手加出序号字段（D-09）', () => {
    const before = idsOf(photos)
    const sorted = autoSortPhotos(photos, { by: 'takenAt', direction: 'desc' })
    expect(idsOf(photos)).toEqual(before)
    expect(sorted.every((photo) => photos.includes(photo))).toBe(true)
  })
})

describe('autoSortPhotos：按文件名', () => {
  const byName = (names: readonly string[]): string[] =>
    autoSortPhotos(makePhotoList(names.length, names.map((fileName) => ({ fileName }))), {
      by: 'fileName',
      direction: 'asc'
    }).map((photo) => photo.fileName)

  it('数字整体比较：第 2 张在第 10 张之前', () => {
    expect(byName(['第10张.jpg', '第1张.jpg', '第2张.jpg'])).toEqual(['第1张.jpg', '第2张.jpg', '第10张.jpg'])
  })

  it('扩展名大小写混排也按同一套规则，不被字符码拆散', () => {
    expect(byName(['IMG_10.jpg', 'img_2.JPG', 'IMG_1.jpg'])).toEqual(['IMG_1.jpg', 'img_2.JPG', 'IMG_10.jpg'])
  })

  it('名字只有大小写差异的视为同级，保持原相对顺序', () => {
    expect(byName(['a.jpg', 'A.JPG', 'b.jpg'])).toEqual(['a.jpg', 'A.JPG', 'b.jpg'])
  })
})

const pageOf = (photos: readonly PhotoItem[], indexes: readonly number[]): PageItem => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  patternId: 'editorial-white/two-up',
  locked: false,
  slots: indexes.map((index) => ({ photoId: photoAt(photos, index).id, focus: { x: 0.5, y: 0.5 } })),
  texts: []
})

const slotIds = (doc: ProjectDocument): (string | null)[] =>
  doc.pages.flatMap((page) => page.slots.map((slot) => slot.photoId)).sort()

describe('文档级顺序变更', () => {
  const photos = makePhotoList(3)
  const doc = makeDocument({ photos, pages: [pageOf(photos, [0, 2])] })

  it('movePhotoInDocument 只换 photos 顺序，其余块保持同一引用', () => {
    const next = changed(movePhotoInDocument(doc, 0, 2))
    expect(orderOf(next.photos, doc.photos)).toEqual([1, 2, 0])
    expect(next.pages).toEqual(doc.pages)
    expect(next.meta).toBe(doc.meta)
    expect(next.layout).toBe(doc.layout)
    expect(next.export).toBe(doc.export)
    expect(next.schemaVersion).toBe(doc.schemaVersion)
  })

  it('顺序换不动版面引用：槽位里的照片 id 一个都不少', () => {
    const sorted = changed(sortPhotosInDocument(doc, { by: 'fileName', direction: 'desc' }))
    expect(slotIds(sorted)).toEqual(slotIds(doc))
    expect(orderOf(sorted.photos, doc.photos)).toEqual([2, 1, 0])
  })

  it('已是该顺序或原位操作返回 null，不产生新文档', () => {
    expect(sortPhotosInDocument(doc, { by: 'takenAt', direction: 'asc' })).toBeNull()
    expect(movePhotoInDocument(doc, 1, 1)).toBeNull()
    expect(movePhotoInDocument(doc, 2, 9)).toBeNull()
  })

  it('空照片列表不报错', () => {
    const empty = makeDocument({ photos: [] })
    expect(movePhotoInDocument(empty, 0, 1)).toBeNull()
    expect(sortPhotosInDocument(empty, { by: 'fileName', direction: 'asc' })).toBeNull()
  })
})
