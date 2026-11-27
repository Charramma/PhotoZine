import { useCallback, useEffect, useState } from 'react'
import type { OpenOutcome } from '@shared/ipc/contract'
import { onMenuCommand } from '../api/menu'
import { closeProject, openProject, pickProjectFolder } from '../api/project'
import { flushSave } from '../store/saveCoordinator'
import { useProjectSession, type ProjectSession } from '../store/projectSession'
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

const SAVED_TIME = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * 保存状态一句话说清"改动在不在磁盘上"（需求文档 FR-EDIT-02）：
 * 失败排在"未保存"前面，因为它解释了为什么还没写进去。
 */
function saveHint(session: ProjectSession): { text: string; className: string | undefined } | null {
  if (session.saveState.kind === 'error') {
    return { text: `保存失败：${session.saveState.reason}`, className: styles.saveFail }
  }
  if (session.dirty) return { text: '改动尚未写入项目文件', className: styles.savePending }
  if (session.saveState.kind === 'saved') {
    return { text: `已保存 ${SAVED_TIME.format(session.saveState.at)}`, className: styles.saveOk }
  }
  return null
}

/**
 * 项目会话入口：选文件夹 → 打开 → 显示状态。
 * 只读降级、自动修复项与缺失原图都在这里如实常驻，不做静默处理（总体设计稿 D-12、FR-PROJ-02）。
 */
export function ProjectPanel() {
  const session = useProjectSession((state) => state.session)
  const [rejection, setRejection] = useState<string | null>(null)

  /** 切换项目前先把待写内容收口，再释放锁：防抖窗口里的改动不能被静默丢掉（总体设计稿 §7） */
  const discardCurrent = useCallback(async (): Promise<boolean> => {
    const current = useProjectSession.getState().session
    if (current === null) return true
    await flushSave()
    const after = useProjectSession.getState().session
    if (after?.dirty === true && !window.confirm('改动没能写入项目文件，确定放弃并关闭？')) return false
    await closeProject(current.root)
    return true
  }, [])

  /** 会话本身由主进程广播、界面镜像（`api/project` 的 `startSessionMirror`），这里只请求与说明结果 */
  const choose = useCallback(async (): Promise<void> => {
    const picked = await pickProjectFolder()
    if (picked.root === null || !(await discardCurrent())) return
    const outcome = await openProject(picked.root)
    setRejection(rejectionOf(outcome))
  }, [discardCurrent])

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

  const hint = saveHint(session)

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
        {hint !== null && (
          <span className={hint.className} data-smoke="save-state">
            {hint.text}
          </span>
        )}
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
