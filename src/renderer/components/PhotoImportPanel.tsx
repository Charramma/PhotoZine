import { useCallback, useEffect, useRef, useState } from 'react'
import { PZFILE_ROOT_PROJECT } from '@shared/domain/constants'
import { userReason } from '@shared/domain/userError'
import { pzfileUrl } from '@shared/fs/pzfileUrl'
import type { PhotoItem } from '@shared/domain/project/schema'
import type {
  DuplicateHit,
  DuplicatePolicy,
  ImportFailure,
  PhotoImportProgress,
  ImportWarning,
  PhotoImportResult
} from '@shared/ipc/contract'
import { onMenuCommand } from '../api/menu'
import { filePathOf, importPhotos, pickPhotoFiles, type ImportJob } from '../api/photo'
import { applyDocumentCommand } from '../store/documentCommands'
import { useProjectSession } from '../store/projectSession'
import styles from './PhotoImportPanel.module.css'

type Stage =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number; currentFile: string; phase: PhotoImportProgress['phase'] }
  | { kind: 'ask'; hits: DuplicateHit[]; files: string[] }
  | { kind: 'stopped' }
  | { kind: 'refused'; reason: string }
  | { kind: 'summary'; photos: PhotoItem[]; failures: ImportFailure[]; warnings: ImportWarning[] }

const PHASE_LABEL: Record<PhotoImportProgress['phase'], string> = { hash: '核对内容', derive: '生成缩略图' }

/** 只留文件名：整条源路径太长，界面上要看得清是哪一个文件 */
const baseName = (file: string): string => file.slice(Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/')) + 1)

function duplicateLabel(hit: DuplicateHit, hashes: readonly string[]): string {
  if (hit.duplicateOf.kind === 'existing') return `与第 ${hashes.indexOf(hit.hash) + 1} 张重复`
  return `与本批的「${baseName(hit.duplicateOf.sourceFile)}」重复`
}

/**
 * 照片导入入口：选择器与拖拽两种来源，进度走事件流、随时可取消，
 * 命中重复哈希先问用户再落盘（需求文档 FR-PHOTO-01）。
 *
 * 导入成功的照片立刻并入文档并保存：原图已经落在 `photos/`，文档不引用它就成孤儿文件（总体设计稿 §7）。
 */
export function PhotoImportPanel() {
  const session = useProjectSession((state) => state.session)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [job, setJob] = useState<ImportJob | null>(null)
  const cancelled = useRef(false)

  /**
   * 原图已经落在 `photos/`，文档不引用它就成孤儿文件（总体设计稿 §7），所以导入成功即并入文档。
   * 落盘由命令入口统一负责，写盘成败看顶栏的保存状态（FR-EDIT-02）。
   */
  const adopt = useCallback((photos: PhotoItem[]): void => {
    applyDocumentCommand((document) => ({ ...document, photos: [...document.photos, ...photos] }))
  }, [])

  const apply = useCallback(
    (outcome: PhotoImportResult, files: string[]): void => {
      switch (outcome.kind) {
        case 'duplicates':
          // 一字节都没写，所以重复清单可以直接摆出来问用户
          setStage({ kind: 'ask', hits: outcome.duplicates, files })
          return
        case 'refused':
          setStage({ kind: 'refused', reason: outcome.reason })
          return
        case 'imported':
          if (outcome.photos.length > 0) adopt(outcome.photos)
          setStage({ kind: 'summary', photos: outcome.photos, failures: outcome.failures, warnings: outcome.warnings })
      }
    },
    [adopt]
  )

  const start = useCallback(
    async (files: string[], duplicatePolicy: DuplicatePolicy): Promise<void> => {
      const current = useProjectSession.getState().session
      if (current === null || files.length === 0) return
      const hashes = current.document.photos.map((photo) => photo.hash)
      cancelled.current = false
      setStage({ kind: 'running', done: 0, total: files.length, currentFile: files[0] ?? '', phase: 'hash' })

      const started = importPhotos({
        root: current.root,
        files,
        duplicatePolicy,
        existingHashes: hashes,
        onProgress: (progress) =>
          setStage({
            kind: 'running',
            done: progress.done,
            total: progress.total,
            currentFile: progress.currentFile,
            phase: progress.phase
          })
      })
      setJob(started)
      try {
        apply(await started.result, files)
      } catch (error) {
        setStage(cancelled.current ? { kind: 'stopped' } : { kind: 'refused', reason: userReason(error) })
      } finally {
        setJob(null)
      }
    },
    [apply]
  )

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const paths = [...event.dataTransfer.files].map(filePathOf).filter((path): path is string => path !== null)
      if (paths.length > 0) void start(paths, 'ask')
    },
    [start]
  )

  const pick = useCallback(async (): Promise<void> => {
    const picked = await pickPhotoFiles()
    if (picked.files.length > 0) void start(picked.files, 'ask')
  }, [start])

  const cancel = useCallback((): void => {
    if (job === null) return
    cancelled.current = true
    job.cancel()
  }, [job])

  const reset = useCallback((): void => setStage({ kind: 'idle' }), [])

  useEffect(() => onMenuCommand('import-photos', () => void pick()), [pick])

  if (session === null) return <p className={styles.hint}>先打开项目文件夹</p>

  const hashes = session.document.photos.map((photo) => photo.hash)
  const running = stage.kind === 'running'

  return (
    <div
      className={styles.drop}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      data-smoke="import-drop"
    >
      <div className={styles.toolbar}>
        <button type="button" onClick={() => void pick()} disabled={running || stage.kind === 'ask'} data-smoke="pick-photos">
          添加照片
        </button>
        {running ? (
          <>
            <progress className={styles.bar} max={stage.total} value={stage.done} />
            <span className={styles.muted}>
              {stage.done}/{stage.total} · {PHASE_LABEL[stage.phase]}
            </span>
            <button type="button" onClick={cancel} data-smoke="cancel-import">
              取消
            </button>
          </>
        ) : (
          <span className={styles.muted}>也可以把照片拖到这里</span>
        )}
      </div>

      {running && <p className={styles.muted}>{baseName(stage.currentFile)}</p>}

      {stage.kind === 'ask' && (
        <div className={styles.notice}>
          <p>{`${stage.hits.length} 个文件与已有照片内容相同：`}</p>
          <ul className={styles.list}>
            {stage.hits.map((hit) => (
              <li key={hit.sourceFile}>
                {baseName(hit.sourceFile)} · {duplicateLabel(hit, hashes)}
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <button type="button" onClick={() => void start(stage.files, 'skip')} data-smoke="duplicates-skip">
              跳过这些
            </button>
            <button type="button" onClick={() => void start(stage.files, 'keep')} data-smoke="duplicates-keep">
              仍然导入
            </button>
            <button type="button" onClick={reset}>
              取消
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'stopped' && <p className={styles.muted}>已取消，未写入任何文件</p>}
      {stage.kind === 'refused' && <p className={styles.error}>导入中断：{stage.reason}</p>}

      {stage.kind === 'summary' && (
        <div className={styles.summary} data-smoke-imported={stage.photos.length}>
          <p>{`已导入 ${stage.photos.length} 张`}</p>
          {stage.failures.length > 0 && (
            <>
              <p className={styles.error}>{`${stage.failures.length} 个文件未能导入`}</p>
              <textarea
                className={styles.failures}
                readOnly
                rows={Math.min(6, stage.failures.length)}
                value={stage.failures.map((failure) => `${baseName(failure.sourceFile)}：${failure.reason}`).join('\n')}
              />
            </>
          )}
          {stage.warnings.length > 0 && (
            <ul className={styles.list}>
              {stage.warnings.map((warning) => (
                <li key={warning.sourceFile}>
                  {baseName(warning.sourceFile)}：{warning.message}
                </li>
              ))}
            </ul>
          )}
          {stage.photos.length > 0 && (
            <ul className={styles.thumbs}>
              {stage.photos.map((photo) => (
                <li key={photo.id} className={styles.thumb}>
                  <img src={pzfileUrl(PZFILE_ROOT_PROJECT, `thumbnails/${photo.id}.jpg`) ?? ''} alt={photo.fileName} />
                </li>
              ))}
            </ul>
          )}
          <div className={styles.actions}>
            <button type="button" onClick={reset}>
              完成
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
