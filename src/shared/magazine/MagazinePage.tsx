import type { CSSProperties, ReactNode } from 'react'
import styles from './magazine.module.css'

export interface MagazinePageProps {
  widthMm: number
  heightMm: number
  paper?: string
  ink?: string
  /** 只在编辑器出现的叠加层（选中框、手柄、参考线）；打印入口加载 print.css 后整体隐藏 */
  editorOverlay?: ReactNode
  children?: ReactNode
}

/**
 * 一页杂志版面的外框。预览窗口与打印窗口共用同一实现，
 * 版面尺寸只由 mm 决定，不受视口与缩放影响（总体设计稿 §4.1）。
 */
export function MagazinePage(props: MagazinePageProps) {
  const { widthMm, heightMm, paper = '#FBFAF8', ink = '#1A1A18', editorOverlay, children } = props

  const style = {
    '--pz-page-w': `${widthMm}mm`,
    '--pz-page-h': `${heightMm}mm`,
    '--pz-paper': paper,
    '--pz-ink': ink
  } as CSSProperties

  return (
    <div className={`${styles.page} pz-page`} style={style}>
      {children}
      {editorOverlay ? <div className="pz-editor-only">{editorOverlay}</div> : null}
    </div>
  )
}
