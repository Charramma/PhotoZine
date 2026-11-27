import { NAME_SORT_LOCALE } from '../constants'
import type { PhotoItem, ProjectDocument } from './schema'

/**
 * 顺序变更的唯一入口（总体设计稿 D-09、AGENTS.md §5.2）：照片顺序就是 `photos` 数组下标，
 * 所以这里一律**产出新数组/新文档**，绝不写 `order`/`index` 之类的镜像字段。
 * 数组层与文档层分开：前者可被页面排序复用，后者保证只动 `photos` 一个键。
 */

/** 自动排序的可比字段（需求文档 FR-ORDER-02） */
export type PhotoSortBy = 'takenAt' | 'fileName'
export type SortDirection = 'asc' | 'desc'
export interface PhotoSortSpec {
  by: PhotoSortBy
  direction: SortDirection
}

type SortablePhoto = Pick<PhotoItem, 'fileName' | 'takenAt'>

interface Entry<T extends SortablePhoto> {
  photo: T
  index: number
  /** 读不出时刻的照片排到最后（FR-ORDER-02），与升降序无关 */
  bottom: boolean
  instant: number | null
}

/** 大小写与全半角差异不作为排序依据，数字按整值比较（`第2张` 在 `第10张` 之前） */
const nameCollator = new Intl.Collator(NAME_SORT_LOCALE, { numeric: true, sensitivity: 'base' })

/** 按下标语义把 `from` 处的元素搬到 `to`；无变化或越界返回 null，调用方据此不标脏 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] | null {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return null
  const next = [...items]
  const moved = next.splice(from, 1)
  if (moved.length === 0) return null
  next.splice(to, 0, ...moved)
  return next
}

/** 只比标识序列：用于"这次操作其实没改变顺序"的判定 */
export function sameOrder<T extends { id: string }>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id)
}

/** `takenAt` 落盘为 ISO 8601 UTC，但文件可能被用户手改过：读不出就归入"无时间"，不猜一个时刻 */
function parseTakenAt(takenAt: string | null): number | null {
  if (takenAt === null) return null
  const instant = Date.parse(takenAt)
  return Number.isNaN(instant) ? null : instant
}

/** 无时间的照片数量，界面据此如实提示"另外 M 张排在最后" */
export function countPhotosWithoutTime<T extends SortablePhoto>(photos: readonly T[]): number {
  return photos.filter((photo) => parseTakenAt(photo.takenAt) === null).length
}

export function autoSortPhotos<T extends SortablePhoto>(photos: readonly T[], spec: PhotoSortSpec): T[] {
  const factor = spec.direction === 'asc' ? 1 : -1
  const entries: Entry<T>[] = photos.map((photo, index) => {
    const instant = spec.by === 'takenAt' ? parseTakenAt(photo.takenAt) : 0
    return { photo, index, instant, bottom: instant === null }
  })
  const compare =
    spec.by === 'takenAt'
      ? (left: Entry<T>, right: Entry<T>): number => (left.instant ?? 0) - (right.instant ?? 0)
      : (left: Entry<T>, right: Entry<T>): number => nameCollator.compare(left.photo.fileName, right.photo.fileName)
  // 同值一律回到原下标序，保证同一批照片排两次得到同一个结果
  entries.sort((left, right) => Number(left.bottom) - Number(right.bottom) || factor * compare(left, right) || left.index - right.index)
  return entries.map((entry) => entry.photo)
}

export function movePhotoInDocument(document: ProjectDocument, from: number, to: number): ProjectDocument | null {
  const photos = moveItem(document.photos, from, to)
  return photos === null ? null : { ...document, photos }
}

export function sortPhotosInDocument(document: ProjectDocument, spec: PhotoSortSpec): ProjectDocument | null {
  const photos = autoSortPhotos(document.photos, spec)
  return sameOrder(document.photos, photos) ? null : { ...document, photos }
}
