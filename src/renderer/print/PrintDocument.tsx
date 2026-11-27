import { useEffect } from 'react'
import { PAGE_A4, PZFILE_ROOT_APP } from '@shared/domain/constants'
import { MagazinePage, MagazineSlot } from '@shared/magazine'

/** 打印入口的能力边界：只允许版面组件与共享常量，任何编辑器 UI 都被 lint 拦下（AGENTS.md §3.7） */
const PROBE_URL = `pzfile://${PZFILE_ROOT_APP}/resources/probe/pzfile-probe.svg`

export interface PrintDocumentProps {
  pages: number
}

/** T6 起页数与槽位坐标由项目文档与模板驱动，此处是版面渲染通路的最小实现 */
export function PrintDocument({ pages }: PrintDocumentProps) {
  useEffect(() => {
    void window.pz.invoke('print-window:report-ready', { pages })
  }, [pages])

  return (
    <>
      {Array.from({ length: pages }, (_, index) => (
        <MagazinePage
          key={index}
          widthMm={PAGE_A4.widthMm}
          heightMm={PAGE_A4.heightMm}
          editorOverlay={<span>编辑叠加层，不应出现在打印结果中</span>}
        >
          <MagazineSlot rect={{ x: 20 + index * 4, y: 24, w: 170, h: 120 }} photoUrl={PROBE_URL} alt="" />
        </MagazinePage>
      ))}
    </>
  )
}
