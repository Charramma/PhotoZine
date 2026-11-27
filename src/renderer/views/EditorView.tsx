import { useCallback, useEffect, useState } from 'react'
import { PAGE_A4, PZFILE_ROOT_APP } from '@shared/domain/constants'
import type { AppInfo } from '@shared/ipc/contract'
import { MagazinePage, MagazineSlot } from '@shared/magazine'
import { DescriptionEditor } from '../components/DescriptionEditor'
import { PhotoImportPanel } from '../components/PhotoImportPanel'
import { PhotoList } from '../components/PhotoList'
import { ProjectPanel } from '../components/ProjectPanel'
import styles from './EditorView.module.css'

type ProbeExpect = 'load' | 'block'
type ProbeState = 'pending' | 'loaded' | 'failed'

interface Probe {
  key: string
  label: string
  url: string
  expect: ProbeExpect
}

const PROBE_BASE = `pzfile://${PZFILE_ROOT_APP}/resources/probe`

const PROBES: Probe[] = [
  { key: 'ok', label: '正常相对路径', url: `${PROBE_BASE}/pzfile-probe.svg`, expect: 'load' },
  { key: 'traversal', label: '编码 .. 越出授权根', url: `${PROBE_BASE}/%2e%2e%2f%2e%2e%2fWindows/win.ini`, expect: 'block' },
  { key: 'missing', label: '不存在的文件', url: `${PROBE_BASE}/no-such-file.svg`, expect: 'block' }
]

const PROBE_LABEL: Record<ProbeState, string> = {
  pending: '等待',
  loaded: '已加载',
  failed: '已拒绝'
}

const VERDICT_CLASS: Record<'pass' | 'fail' | 'waiting', string | undefined> = {
  pass: styles.pass,
  fail: styles.fail,
  waiting: styles.waiting
}

function verdictOf(expect: ProbeExpect, state: ProbeState | undefined): 'pass' | 'fail' | 'waiting' {
  if (state === undefined || state === 'pending') return 'waiting'
  return expect === 'load' ? (state === 'loaded' ? 'pass' : 'fail') : state === 'failed' ? 'pass' : 'fail'
}

export function EditorView() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [ipcError, setIpcError] = useState<string | null>(null)
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({})
  const [pages, setPages] = useState(2)
  const [printWindowId, setPrintWindowId] = useState<number | null>(null)
  const [events, setEvents] = useState<string[]>([])

  useEffect(() => {
    let active = true
    void window.pz
      .invoke('app:get-info')
      .then((result) => {
        if (active) setInfo(result)
      })
      .catch((error: unknown) => {
        if (active) setIpcError(error instanceof Error ? error.message : String(error))
      })

    const unsubscribe = window.pz.onEvent('print-window:ready', (payload) => {
      const at = new Date(payload.at).toLocaleTimeString('zh-CN', { hour12: false })
      setEvents((previous) => [...previous, `${at}  打印窗口 ${payload.windowId} 渲染 ${payload.pages} 页`].slice(-8))
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const markProbe = useCallback((key: string, state: ProbeState) => {
    setProbeStates((previous) => ({ ...previous, [key]: state }))
  }, [])

  const openPrintWindow = useCallback((): void => {
    void window.pz.invoke('print-window:open', { pages }).then((result) => setPrintWindowId(result.windowId))
  }, [pages])

  const closePrintWindow = useCallback((): void => {
    void window.pz.invoke('print-window:close').then(() => setPrintWindowId(null))
  }, [])

  return (
    <div className={styles.shell}>
      <aside className={styles.rail}>
        <ProjectPanel />
        <PhotoList />
        <PhotoImportPanel />
      </aside>

      <div className={styles.panels}>
        <section className={styles.panel} data-smoke="desc-panel">
          <h2 className={styles.panelTitle}>描述</h2>
          <DescriptionEditor />
        </section>

        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>应用</h2>
          {info ? (
            <dl className={styles.kv}>
              <div>
                <dt>版本</dt>
                <dd>
                  {info.name} {info.version}
                </dd>
              </div>
              <div>
                <dt>运行环境</dt>
                <dd>
                  Electron {info.electron} · Chrome {info.chrome} · {info.platform}
                </dd>
              </div>
              <div>
                <dt>打包状态</dt>
                <dd>{info.packaged ? '已打包' : '开发运行'}</dd>
              </div>
              <div>
                <dt>数据目录</dt>
                <dd className={styles.mono}>{info.userDataPath}</dd>
              </div>
            </dl>
          ) : (
            <p className={ipcError ? styles.ipcError : styles.muted} data-smoke="ipc-state">
              {ipcError ? `读取失败：${ipcError}` : '正在通过 IPC 读取主进程信息'}
            </p>
          )}
        </section>

        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>pzfile 协议</h2>
          <ul className={styles.probes}>
            {PROBES.map((probe) => {
              const state = probeStates[probe.key]
              const verdict = verdictOf(probe.expect, state)
              return (
                <li key={probe.key} className={styles.probe}>
                  <img
                    className={styles.probeImage}
                    src={probe.url}
                    alt=""
                    onLoad={() => markProbe(probe.key, 'loaded')}
                    onError={() => markProbe(probe.key, 'failed')}
                  />
                  <span className={styles.probeLabel}>{probe.label}</span>
                  <span
                    className={[styles.verdict, VERDICT_CLASS[verdict]].join(' ')}
                    data-smoke-verdict={probe.key}
                    data-smoke-result={verdict}
                  >
                    {verdict === 'waiting' ? '等待' : `${PROBE_LABEL[state ?? 'pending']} · ${verdict === 'pass' ? '符合预期' : '不符合预期'}`}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>

        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>打印窗口</h2>
          <div className={styles.row}>
            <label className={styles.field}>
              页数
              <input
                className={styles.pagesInput}
                type="number"
                min={1}
                max={24}
                value={pages}
                onChange={(event) => setPages(Math.min(24, Math.max(1, Number(event.target.value) || 1)))}
              />
            </label>
            <button type="button" onClick={openPrintWindow} disabled={printWindowId !== null} data-smoke="open-print">
              打开
            </button>
            <button type="button" onClick={closePrintWindow} disabled={printWindowId === null}>
              关闭
            </button>
            <span className={styles.muted}>{printWindowId === null ? '未打开' : `窗口 ${printWindowId}`}</span>
          </div>
          <ul className={styles.events} data-smoke="events">
            {events.length === 0 ? <li className={styles.muted}>尚无事件</li> : events.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </section>

        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>版面预览</h2>
          <div className={styles.pageZoom}>
            <MagazinePage
              widthMm={PAGE_A4.widthMm}
              heightMm={PAGE_A4.heightMm}
              editorOverlay={<span className={styles.overlayTag}>编辑叠加层 · 打印时隐藏</span>}
            >
              <MagazineSlot rect={{ x: 20, y: 24, w: 170, h: 120 }} photoUrl={`${PROBE_BASE}/pzfile-probe.svg`} alt="探针图" />
            </MagazinePage>
          </div>
        </section>
      </div>
    </div>
  )
}
