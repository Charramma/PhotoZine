import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { PHOTO_LIST, PZFILE_ROOT_PROJECT } from '@shared/domain/constants'
import { descriptionSummary } from '@shared/domain/project/description'
import {
  autoSortPhotos,
  countPhotosWithoutTime,
  movePhotoInDocument,
  sameOrder,
  sortPhotosInDocument,
  type PhotoSortBy,
  type PhotoSortSpec,
  type SortDirection
} from '@shared/domain/project/ordering'
import type { PageItem, PhotoItem } from '@shared/domain/project/schema'
import { pzfileUrl } from '@shared/fs/pzfileUrl'
import { applyDocumentCommand } from '../store/documentCommands'
import { useEditorUi } from '../store/editorUi'
import { useProjectSession } from '../store/projectSession'
import { ConfirmDialog } from './ConfirmDialog'
import styles from './PhotoList.module.css'

/**
 * 照片列表（需求文档 FR-PHOTO-02、FR-ORDER-01/02）：只显示缩略图档、只渲染可见行，
 * 顺序变更一律经命令入口落盘（AGENTS.md §4.3、总体设计稿 D-09）。
 *
 * 对外没有 props：文档、选中项与只读降级都来自 store，调用方只管把它放进左栏。
 */

const SORT_BY_LABEL: Record<PhotoSortBy, string> = { takenAt: '拍摄时间', fileName: '文件名' }
const SORT_DIRECTION_LABEL: Record<SortDirection, string> = { asc: '升序', desc: '降序' }

/** 没有会话时的空列表：稳定的空引用，免得每次渲染都让 memo 失效 */
const NO_PHOTOS: PhotoItem[] = []

/** 每张照片被多少页引用：从 `pages` 现算，不落第二份状态（AGENTS.md §4.3） */
function usageByPhoto(pages: readonly PageItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const page of pages) {
    for (const slot of page.slots) {
      if (slot.photoId === null) continue
      counts.set(slot.photoId, (counts.get(slot.photoId) ?? 0) + 1)
    }
  }
  return counts
}

export function PhotoList() {
  const session = useProjectSession((state) => state.session)
  const selectedId = useEditorUi((state) => state.selectedPhotoId)
  const selectPhoto = useEditorUi((state) => state.selectPhoto)
  const photos = useMemo(() => session?.document.photos ?? NO_PHOTOS, [session])
  const writable = session !== null && session.readOnlyReason === null

  const [spec, setSpec] = useState<PhotoSortSpec>({ by: 'takenAt', direction: 'asc' })
  const [notice, setNotice] = useState<string | null>(null)
  /** 确认框只对"用户点了自动排序且顺序确实会变"打开，执行用的是这份快照 */
  const [pendingSort, setPendingSort] = useState<PhotoSortSpec | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: photos.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => PHOTO_LIST.rowHeightPx,
    overscan: PHOTO_LIST.overscan
  })
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const missingIds = useMemo(() => new Set(session?.missingPhotoIds ?? []), [session])
  const usage = useMemo(() => usageByPhoto(session?.document.pages ?? []), [session])
  const selectedIndex = photos.findIndex((photo) => photo.id === selectedId)

  // 键盘连续移动时别让选中项跑出视野（FR-ORDER-01 的可访问性前提）
  useEffect(() => {
    const range = virtualizer.range
    if (selectedIndex < 0 || range === null) return
    if (selectedIndex < range.startIndex || selectedIndex > range.endIndex) {
      virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
    }
  }, [selectedIndex, virtualizer])

  const stopDrag = useCallback((): void => {
    setActiveId(null)
    setOverIndex(null)
  }, [])

  const onDragStart = useCallback((event: DragStartEvent): void => {
    setActiveId(String(event.active.id))
  }, [])

  const onDragOver = useCallback((event: DragOverEvent): void => {
    setOverIndex(event.over === null ? null : Number(event.over.id))
  }, [])

  const onDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const over = event.over
      stopDrag()
      if (over === null) return
      const from = photos.findIndex((photo) => photo.id === event.active.id)
      if (from < 0) return
      const to = Number(over.id)
      setNotice(
        applyDocumentCommand((document) => movePhotoInDocument(document, from, to))
          ? `第 ${from + 1} 张已移到第 ${to + 1} 张的位置`
          : null
      )
    },
    [photos, stopDrag]
  )

  const requestSort = useCallback((): void => {
    const sorted = autoSortPhotos(photos, spec)
    if (sameOrder(photos, sorted)) {
      setNotice(`已经是按${SORT_BY_LABEL[spec.by]}${SORT_DIRECTION_LABEL[spec.direction]}的顺序`)
      return
    }
    setNotice(null)
    setPendingSort(spec)
  }, [photos, spec])

  const applySort = useCallback((): void => {
    if (pendingSort === null) return
    const label = `已按${SORT_BY_LABEL[pendingSort.by]}${SORT_DIRECTION_LABEL[pendingSort.direction]}重排 ${photos.length} 张`
    const withoutTime = countPhotosWithoutTime(photos)
    if (applyDocumentCommand((document) => sortPhotosInDocument(document, pendingSort))) {
      setNotice(withoutTime > 0 ? `${label}，其中 ${withoutTime} 张读不出拍摄时间排在最后` : label)
    }
    setPendingSort(null)
  }, [pendingSort, photos])

  if (session === null) return <p className={styles.hint}>先打开项目文件夹</p>

  const withoutTime = countPhotosWithoutTime(photos)
  const activePhoto = photos.find((photo) => photo.id === activeId) ?? null

  return (
    <div className={styles.shell}>
      <div className={styles.toolbar} data-smoke="photo-sort-bar">
        <div className={styles.group} role="group" aria-label="排序依据">
          {(Object.keys(SORT_BY_LABEL) as PhotoSortBy[]).map((by) => (
            <button
              key={by}
              type="button"
              className={spec.by === by ? styles.on : undefined}
              aria-pressed={spec.by === by}
              onClick={() => setSpec((current) => ({ ...current, by }))}
              data-smoke={`sort-by-${by}`}
            >
              {SORT_BY_LABEL[by]}
            </button>
          ))}
        </div>
        <div className={styles.group} role="group" aria-label="排序方向">
          {(Object.keys(SORT_DIRECTION_LABEL) as SortDirection[]).map((direction) => (
            <button
              key={direction}
              type="button"
              className={spec.direction === direction ? styles.on : undefined}
              aria-pressed={spec.direction === direction}
              onClick={() => setSpec((current) => ({ ...current, direction }))}
              data-smoke={`sort-direction-${direction}`}
            >
              {SORT_DIRECTION_LABEL[direction]}
            </button>
          ))}
        </div>
        <button type="button" onClick={requestSort} disabled={!writable || photos.length < 2} data-smoke="sort-apply">
          自动排序
        </button>
      </div>

      {notice !== null && (
        <p className={styles.notice} data-smoke="sort-notice">
          {notice}
        </p>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={stopDrag}
      >
        <div ref={scrollRef} className={styles.scroll} data-smoke="photo-list">
          <ul className={styles.canvas} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const photo = photos[row.index]
              if (photo === undefined) return null
              return (
                <PhotoRow
                  key={photo.id}
                  photo={photo}
                  index={row.index}
                  top={row.start}
                  selected={photo.id === selectedId}
                  missing={missingIds.has(photo.id)}
                  pageCount={usage.get(photo.id) ?? 0}
                  dragging={photo.id === activeId}
                  insertTarget={overIndex === row.index && activeId !== photo.id}
                  writable={writable}
                  onSelect={selectPhoto}
                />
              )
            })}
          </ul>
          {photos.length === 0 && (
            <p className={styles.hint}>还没有照片，导入后在这里拖拽或用 Alt+↑/↓ 调整顺序</p>
          )}
        </div>
        <DragOverlay>
          {activePhoto === null ? null : <Ghost photo={activePhoto} index={photos.indexOf(activePhoto)} />}
        </DragOverlay>
      </DndContext>

      <ConfirmDialog
        open={pendingSort !== null}
        title="自动排序会覆盖手动顺序"
        description={
          pendingSort === null ? null : (
            <>
              <p>
                {`将按${SORT_BY_LABEL[pendingSort.by]}${SORT_DIRECTION_LABEL[pendingSort.direction]}重排全部 ${photos.length} 张照片，你手动调整过的顺序会被覆盖。`}
                撤销功能尚未开放，这次改动无法退回。
              </p>
              {pendingSort.by === 'takenAt' && withoutTime > 0 && (
                <p>{`另有 ${withoutTime} 张读不出拍摄时间，将按导入顺序排在最后。`}</p>
              )}
            </>
          )
        }
        confirmLabel="开始排序"
        onConfirm={applySort}
        onCancel={() => setPendingSort(null)}
      />
    </div>
  )
}

interface RowProps {
  photo: PhotoItem
  index: number
  top: number
  selected: boolean
  missing: boolean
  pageCount: number
  dragging: boolean
  insertTarget: boolean
  writable: boolean
  onSelect(photoId: string): void
}

function PhotoRow(props: RowProps) {
  const { photo, index, top, selected, missing, pageCount, dragging, insertTarget, writable, onSelect } = props
  const drag = useDraggable({ id: photo.id, disabled: !writable })
  const drop = useDroppable({ id: index, disabled: !writable })
  const { setNodeRef: setDragNodeRef } = drag
  const { setNodeRef: setDropNodeRef } = drop

  // 拖拽测量的节点必须是整行（幽灵跟行同尺寸），激活只在手柄上，所以两个 ref 挂在同一个节点
  const setNodeRef = useCallback(
    (node: HTMLLIElement | null) => {
      setDragNodeRef(node)
      setDropNodeRef(node)
    },
    [setDragNodeRef, setDropNodeRef]
  )

  return (
    <li
      ref={setNodeRef}
      className={[styles.row, selected && styles.selected, dragging && styles.dragging, insertTarget && styles.target].filter(Boolean).join(' ')}
      style={{ top, height: PHOTO_LIST.rowHeightPx }}
      data-photo-index={index}
      data-photo-id={photo.id}
      data-photo-name={photo.fileName}
    >
      <button
        type="button"
        className={styles.handle}
        {...drag.attributes}
        {...drag.listeners}
        aria-label={`拖动第 ${index + 1} 张`}
        data-smoke="photo-handle"
      />
      <button type="button" className={styles.pick} onClick={() => onSelect(photo.id)} aria-pressed={selected} data-smoke="photo-pick">
        <RowBody photo={photo} index={index} missing={missing} pageCount={pageCount} />
      </button>
    </li>
  )
}

/** 一行的内容（FR-PHOTO-02）：序号 · 缩略图 · 文件名与描述首行摘要 · 徽标 */
function RowBody({ photo, index, missing, pageCount }: Pick<RowProps, 'photo' | 'index' | 'missing' | 'pageCount'>) {
  const summary = descriptionSummary(photo.description, PHOTO_LIST.summaryMaxChars)
  return (
    <>
      <span className={styles.order}>{index + 1}</span>
      <Thumbnail photo={photo} />
      <span className={styles.meta}>
        <span className={styles.name} title={photo.fileName}>
          {photo.fileName}
        </span>
        <span className={summary === '' ? styles.empty : styles.summary}>{summary === '' ? '（无描述）' : summary}</span>
      </span>
      <span className={styles.badges}>
        {photo.starred === true && <em className={styles.badge}>重点</em>}
        {missing && <em className={styles.badgeWarn}>缺失</em>}
        {pageCount > 0 && <em className={styles.badgePage}>{`${pageCount} 页`}</em>}
      </span>
    </>
  )
}

/** 拖拽时跟随指针的幽灵：只表达"这是哪一张"，不重复一行的交互 */
function Ghost({ photo, index }: { photo: PhotoItem; index: number }) {
  return (
    <div className={styles.ghost} data-smoke="photo-ghost">
      <span className={styles.order}>{index + 1}</span>
      <Thumbnail photo={photo} />
      <span className={styles.name}>{photo.fileName}</span>
    </div>
  )
}

/** 缩略图缺失（缓存被清理）时留占位，不显示破图；重建入口属缓存管理（FR-PHOTO-06） */
function Thumbnail({ photo }: { photo: PhotoItem }) {
  const url = pzfileUrl(PZFILE_ROOT_PROJECT, `thumbnails/${photo.id}.jpg`)
  const [failed, setFailed] = useState(false)
  if (url === null || failed) return <span className={styles.thumb} />
  return (
    <span className={styles.thumb}>
      <img
        className={styles.thumbImage}
        src={url}
        alt=""
        width={PHOTO_LIST.thumbEdgePx}
        height={PHOTO_LIST.thumbEdgePx}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </span>
  )
}
