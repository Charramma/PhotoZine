import { useEffect, useRef, type ReactNode } from 'react'
import styles from './ConfirmDialog.module.css'

interface ConfirmDialogProps {
  open: boolean
  title: string
  /** 说清"会发生什么"和"能不能退回来"，不写常驻解释（AGENTS.md §4.10、§4.13） */
  description: ReactNode
  confirmLabel: string
  cancelLabel?: string
  onConfirm(): void
  onCancel(): void
}

/**
 * 危险操作前的确认门槛：用原生 `<dialog>` + `showModal()`，
 * Esc 关闭、焦点圈定、模态阻断都由浏览器提供，不再引一层弹窗库。
 *
 * 对外的约定是"受控"的：`open` 由调用方持有，组件只在 `open` 变假时收尾关闭，
 * 用户按键（确认/取消/Esc）才回调，避免程序性关闭被当成用户选择。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const escaped = useRef(false)

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    if (open && !element.open) {
      element.returnValue = ''
      element.showModal()
    }
    if (!open && element.open) element.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      onCancel={() => {
        escaped.current = true
      }}
      onClose={() => {
        if (escaped.current) {
          escaped.current = false
          onCancel()
          return
        }
        if (ref.current?.returnValue === 'confirm') onConfirm()
      }}
    >
      <h2 className={styles.title}>{title}</h2>
      <div className={styles.body}>{description}</div>
      <form method="dialog" className={styles.actions}>
        <button type="submit" value="cancel" data-smoke="confirm-cancel">
          {cancelLabel}
        </button>
        <button type="submit" value="confirm" className={styles.primary} data-smoke="confirm-ok">
          {confirmLabel}
        </button>
      </form>
    </dialog>
  )
}
