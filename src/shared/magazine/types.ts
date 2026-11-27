export interface RectMm {
  x: number
  y: number
  w: number
  h: number
}

/** 归一化裁切视点，直接映射到 CSS `object-position`（总体设计稿 D-10） */
export interface FocusPoint {
  x: number
  y: number
}
