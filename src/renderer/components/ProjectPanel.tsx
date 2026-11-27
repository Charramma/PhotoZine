import { useCallback, useEffect, useState } from 'react'
import type { OpenOutcome } from '@shared/ipc/contract'
import { onMenuCommand } from '../api/menu'
import { closeProject, openProject, pickProjectFolder } from '../api/project'
import { useProjectSession } from '../store/projectSession'
import styles from './ProjectPanel.module.css'

/** 打开结果里"没有可编辑会话"的那些情形，翻译成一句人话（AGENTS.md §3.10） */
function rejectionOf(outcome: OpenOutcome): string | null {
  switch (outcome.kind) {
    case 'opened':
      return null
    case 'not-a-project':
      return '这个文件夹里没有 project.json，不是 PhotoZine 项目'
    case 'already-open':
      return '这个项目已经在当前窗口里打开着'
    case 'newer-version':
      return `项目的文件版本是 v${outcome.version}，高于本应用，已按只读处理，请先升级应用`
    case 'corrupt':
      return `项目文件读不出来：${outcome.errors.map((error) => error.message).join('；')}（涉及 ${outcome.inspected.join('、')}）`
  }
}

/**
 * 项目会话入口：选文件夹 → 打开 → 显示状态。
 * 只读降级、自动修复项与缺失原图都在这里如实常驻，不做静默处理（总体设计稿 D-12、FR-PROJ-02）。
 */
export function ProjectPanel() {
  const session = useProjectSession((state) => state.session)
  const applyOpenOutcome = useProjectSession((state) => state.applyOpenOutcome)
  const [rejection, setRejection] = useState<string | null>(null)

  /** 切换项目前必须先释放上一个项目的锁，否则两个会话并存（AGENTS.md §3.6） */
  const discardCurrent = useCallback(async (): Promise<boolean> => {
    const current = useProjectSession.getState().session
    if (current === null) return true
    if (current.dirty && !window.confirm('当前项目有未保存的改动，放弃并关闭？')) return false
    await closeProject(current.root)
    useProjectSession.getState().closeSession()
    return true
  }, [])

  const choose = useCallback(async (): Promise<void> => {
    const picked = await pickProjectFolder()
    if (picked.root === null || !(await discardCurrent())) return
    const outcome = await openProject(picked.root)
    applyOpenOutcome(outcome)
    setRejection(rejectionOf(outcome))
  }, [applyOpenOutcome, discardCurrent])

  const close = useCallback(async (): Promise<void> => {
    await discardCurrent()
    setRejection(null)
  }, [discardCurrent])

  useEffect(
    () => {
      const opened = onMenuCommand('open-project', () => void choose())
      const closed = onMenuCommand('close-project', () => void close())
      return () => {
        opened()
        closed()
      }
    },
    [choose, close]
  )

  if (session === null) {
    return (
      <div className={styles.row}>
        <button type="button" onClick={() => void choose()} data-smoke="pick-project">
          打开项目文件夹
        </button>
        {rejection !== null && <p className={styles.rejection}>{rejection}</p>}
      </div>
    )
  }

  return (
    <div className={styles.session}>
      <div className={styles.row}>
        <div className={styles.identity}>
          <strong>{session.document.meta.name}</strong>
          <span className={styles.path} title={session.root}>
            {session.root}
          </span>
        </div>
        <span className={styles.count} data-smoke="photo-count">
          {session.document.photos.length} 张照片
        </span>
        {session.dirty && <span className={styles.dirty}>未保存</span>}
        <button type="button" onClick={() => void close()}>
          关闭
        </button>
      </div>
      {session.readOnlyReason !== null && <p className={styles.readOnly}>{session.readOnlyReason}</p>}
      {session.notices.length > 0 && (
        <ul className={styles.notices}>
          {session.notices.map((notice) => (
            <li key={`${notice.path}:${notice.message}`}>
              {notice.path === '' ? '' : `${notice.path}：`}
              {notice.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
