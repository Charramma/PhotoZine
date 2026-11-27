import type { CSSProperties } from 'react'
import styles from './magazine.module.css'
import type { FocusPoint, RectMm } from './types'

export interface MagazineSlotProps {
  rect: RectMm
  photoUrl: string | null
  alt?: string
  fit?: 'cover' | 'contain'
  focus?: FocusPoint
}

/**
 * 图片槽位。`fit` 与 `focus` 直接落到 CSS，
 * 因此屏幕预览与 PDF 打印的裁切结果必然一致（总体设计稿 D-10）。
 */
export function MagazineSlot(props: MagazineSlotProps) {
  const { rect, photoUrl, alt = '', fit = 'cover', focus = { x: 0.5, y: 0.5 } } = props

  const boxStyle = {
    left: `${rect.x}mm`,
    top: `${rect.y}mm`,
    width: `${rect.w}mm`,
    height: `${rect.h}mm`
  } as CSSProperties

  const imageStyle = {
    '--pz-fit': fit,
    '--pz-focus': `${Math.round(focus.x * 100)}% ${Math.round(focus.y * 100)}%`
  } as CSSProperties

  return (
    <div className={styles.slot} style={boxStyle}>
      {photoUrl ? (
        <img className={styles.slotImage} style={imageStyle} src={photoUrl} alt={alt} decoding="async" />
      ) : null}
    </div>
  )
}
