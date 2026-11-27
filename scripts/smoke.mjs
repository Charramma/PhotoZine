import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { emptyProject } from './emptyProject.mjs'

/**
 * 冒烟验证：用构建产物以生产路径（file://）启动应用，经 CDP 断言
 * 两窗口、IPC 往返、pzfile 协议与越界拦截、打印入口版面渲染，
 * 以及导入管线在**真实项目目录 + 真实编码文件**上的落盘结果（AGENTS.md §2.2、§7.3）。
 * 视觉观感不在此判定，版面质感由模板视觉稿评审与人工确认负责。
 */

const require = createRequire(import.meta.url)
const ELECTRON_BIN = require('electron')
const SHARP = require('sharp')
const PORT = 9333
const DEBUG_BASE = `http://127.0.0.1:${PORT}`

const checks = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function record(name, pass, detail = '') {
  checks.push({ name, pass, detail })
}

async function pageTargets() {
  try {
    const response = await fetch(`${DEBUG_BASE}/json/list`)
    const list = await response.json()
    return list.filter((item) => item.type === 'page')
  } catch {
    return []
  }
}

async function waitFor(description, task, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await task()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${description}`)
    await sleep(200)
  }
}

function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    const pending = new Map()
    let nextId = 1

    const send = (method, params = {}) =>
      new Promise((resolveCall, rejectCall) => {
        const id = nextId
        nextId += 1
        pending.set(id, (message) => {
          if (message.error) rejectCall(new Error(`${method}: ${message.error.message}`))
          else resolveCall(message.result)
        })
        socket.send(JSON.stringify({ id, method, params }))
      })

    const session = {
      async evaluate(expression) {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (result.exceptionDetails) {
          throw new Error(`页面脚本异常：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
        }
        return result.result.value
      },
      close() {
        if (socket.readyState === WebSocket.OPEN) socket.close()
      }
    }

    socket.addEventListener('open', () => resolve(session))
    socket.addEventListener('error', () => reject(new Error(`CDP 连接失败：${webSocketDebuggerUrl}`)))
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const handler = pending.get(message.id)
      if (handler) {
        pending.delete(message.id)
        handler(message)
      }
    })
  })
}

/** 在编辑器窗口里调一次跨进程通道：调用失败也返回结果对象，让单项断言不中断整个冒烟 */
async function callInEditor(session, channel, input) {
  try {
    return await session.evaluate(
      `window.pz.invoke(${JSON.stringify(channel)}, ${input === undefined ? 'undefined' : JSON.stringify(input)})`
    )
  } catch (error) {
    return { failure: error.message }
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const exists = async (file) => (await stat(file).catch(() => null)) !== null

/**
 * 导入管线在真实环境里走一遍：真项目文件夹（含锁与原子写）、sharp 真编码的样本、
 * 真磁盘落盘与真 `pzfile` 取图。断言只认磁盘字节与契约返回，不看界面（AGENTS.md §7.4）。
 */
async function runImportChecks(editorSession) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'pz-smoke-import-'))
  try {
    const projectRoot = path.join(workspace, '冒烟项目')
    const cameraCard = path.join(workspace, '相机卡')
    await mkdir(projectRoot, { recursive: true })
    await mkdir(cameraCard, { recursive: true })
    await writeFile(
      path.join(projectRoot, 'project.json'),
      JSON.stringify(emptyProject({ name: '冒烟项目' }), null, 2),
      'utf8'
    )

    const orientedFile = path.join(cameraCard, '横拍竖显 样本.jpg')
    await SHARP({ create: { width: 400, height: 300, channels: 3, background: '#8aa6c8' } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 80 })
      .toFile(orientedFile)
    const flatFile = path.join(cameraCard, '截图 样本.png')
    await SHARP({ create: { width: 120, height: 90, channels: 3, background: '#c8a68a' } }).png().toFile(flatFile)
    const brokenFile = path.join(cameraCard, '说明.txt')
    await writeFile(brokenFile, '这不是图片')

    const opened = await callInEditor(editorSession, 'project:open', { root: projectRoot })
    record(
      '主进程打开项目并建出目录骨架',
      opened.kind === 'opened' && (await exists(path.join(projectRoot, 'thumbnails'))),
      opened.kind ?? opened.failure ?? ''
    )

    const imported = await callInEditor(editorSession, 'photo:import', {
      requestId: randomUUID(),
      root: projectRoot,
      files: [orientedFile, flatFile, brokenFile],
      duplicatePolicy: 'ask',
      existingHashes: []
    })
    const photos = imported.photos ?? []
    const [first, second] = photos
    record(
      '整批导入：两张真图落盘，坏文件逐个报错不阻断',
      imported.kind === 'imported' &&
        photos.length === 2 &&
        imported.failures.length === 1 &&
        imported.failures[0].sourceFile === brokenFile,
      `${photos.length} 张 / ${imported.failures?.length ?? 0} 失败 / ${imported.failure ?? ''}`
    )

    const sourceBytes = await readFile(orientedFile)
    record(
      'photos/ 里的原图与源文件哈希一致、字节相同（永不改写）',
      first?.hash === sha256(sourceBytes) &&
        first?.fileName === path.basename(orientedFile) &&
        (await readFile(path.join(projectRoot, 'photos', first?.fileName ?? '×')).catch(() => null))?.equals(sourceBytes) ===
          true,
      `fileName=${first?.fileName}`
    )
    record(
      'EXIF 方向摆正：编码 400×300 / 方向 6 → 显示 300×400',
      first?.encodedWidth === 400 && first?.encodedHeight === 300 && first?.orientation === 6 && first?.displayWidth === 300 && first?.displayHeight === 400,
      `${first?.encodedWidth}×${first?.encodedHeight} o${first?.orientation} → ${first?.displayWidth}×${first?.displayHeight}`
    )
    record(
      '缩略图全部生成，暂存区不留半成品',
      (await exists(path.join(projectRoot, 'thumbnails', `${first?.id}.jpg`))) &&
        (await exists(path.join(projectRoot, 'thumbnails', `${second?.id}.jpg`))) &&
        (await readdir(path.join(projectRoot, '.tmp'))).length === 0
    )

    const asked = await callInEditor(editorSession, 'photo:import', {
      requestId: randomUUID(),
      root: projectRoot,
      files: [flatFile],
      duplicatePolicy: 'ask',
      existingHashes: [second?.hash ?? '']
    })
    record(
      '重复哈希在写盘前被问住（photos/ 数量不变）',
      asked.kind === 'duplicates' &&
        asked.duplicates.length === 1 &&
        asked.duplicates[0].duplicateOf.kind === 'existing' &&
        (await readdir(path.join(projectRoot, 'photos'))).length === 2,
      asked.kind ?? asked.failure ?? ''
    )

    const saved = await callInEditor(editorSession, 'project:save', {
      root: projectRoot,
      document: { ...opened.project.document, photos }
    })
    const onDisk = JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8'))
    record('导入结果可写入文档契约并原子落盘', saved.kind === 'saved' && onDisk.photos.length === 2, saved.kind ?? saved.failure ?? '')

    const served = await editorSession.evaluate(
      `(async () => { const img = new Image(); img.src = 'pzfile://project/thumbnails/${first?.id}.jpg'; await img.decode(); return img.naturalWidth })()`
    )
    record('缩略图经 pzfile 授权根可取到', served > 0, `宽 ${served}px`)

    await callInEditor(editorSession, 'project:close', { root: projectRoot })
    record('关闭项目后释放项目锁', (await exists(path.join(projectRoot, 'project.json.lock'))) === false)
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
  }
}

/** 列表当前的顺序：从上到下读行的 `data-photo-name`，只看虚拟滚动渲染出来的那几行 */
async function domOrder(editorSession) {
  return editorSession.evaluate(
    `[...document.querySelectorAll('[data-photo-index]')].sort((a, b) => a.dataset.photoIndex - b.dataset.photoIndex).map((el) => el.dataset.photoName)`
  )
}

/** 等列表把顺序画出来并且落盘完成：顺序验收必须同时满足"界面看得见"和"磁盘存得住" */
async function waitForOrder(editorSession, expected) {
  return waitFor(
    `列表顺序变成 ${expected.join(' → ')}`,
    async () => ((await domOrder(editorSession)).join('\n') === expected.join('\n') ? true : null),
    12000
  )
}

async function waitForSaved(editorSession) {
  return waitFor(
    '改动写入项目文件',
    async () => {
      const text = await editorSession.evaluate(
        `document.querySelector('[data-smoke="save-state"]')?.textContent ?? ''`
      )
      return text.includes('已保存') ? text : null
    },
    12000
  )
}

/**
 * 指针拖拽排序：用合成 `PointerEvent` 复现"按住手柄拖到另一行"。
 * dnd-kit 只认 `pointerdown` 落在手柄内、后续事件在文档上，因此合成事件与真实鼠标同路径。
 */
async function dragRow(editorSession, fromIndex, toIndex) {
  return editorSession.evaluate(
    `(async () => {
      const rows = () => [...document.querySelectorAll('[data-photo-index]')].sort((a, b) => a.dataset.photoIndex - b.dataset.photoIndex)
      const handle = rows()[${fromIndex}].querySelector('[data-smoke="photo-handle"]')
      const target = rows()[${toIndex}].getBoundingClientRect()
      const start = handle.getBoundingClientRect()
      const origin = { x: start.x + start.width / 2, y: start.y + start.height / 2 }
      const destination = { x: target.x + 30, y: target.y + target.height / 2 }
      const fire = (node, type, at) =>
        node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: at.x, clientY: at.y }))
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      fire(handle, 'pointerdown', origin)
      await wait(60)
      for (let step = 1; step <= 8; step += 1) {
        const ratio = step / 8
        fire(document, 'pointermove', { x: origin.x + (destination.x - origin.x) * ratio, y: origin.y + (destination.y - origin.y) * ratio })
        await wait(40)
      }
      const ghost = document.querySelector('[data-smoke="photo-ghost"]') !== null
      fire(document, 'pointerup', destination)
      await wait(120)
      return ghost
    })()`
  )
}

/**
 * T4 的真实环境验收（需求文档 FR-ORDER-01/02，总体设计稿 §10）：
 * 界面里的自动排序、键盘移动、指针拖拽都作用在真实照片与真实磁盘上，
 * 关闭再重开后顺序必须还是那一份 —— 顺序真值只有 `photos` 数组下标（D-09）。
 */
async function runOrderChecks(editorSession) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'pz-smoke-order-'))
  try {
    const projectRoot = path.join(workspace, '排序项目')
    const cameraCard = path.join(workspace, '相机卡')
    await mkdir(projectRoot, { recursive: true })
    await mkdir(cameraCard, { recursive: true })
    await writeFile(
      path.join(projectRoot, 'project.json'),
      JSON.stringify(emptyProject({ name: '排序项目' }), null, 2),
      'utf8'
    )

    const SAMPLES = [
      { file: '海边 日落.jpg', kind: 'jpeg', takenAt: '2026-05-03T06:00:00.000Z' },
      { file: '山雾 清晨.png', kind: 'png', takenAt: null },
      { file: '第2天的快照.webp', kind: 'webp', takenAt: '2026-05-01T06:00:00.000Z' }
    ]
    const sources = []
    for (const [index, sample] of SAMPLES.entries()) {
      const file = path.join(cameraCard, sample.file)
      const builder = SHARP({
        create: { width: 320 + index * 40, height: 240 + index * 30, channels: 3, background: ['#8aa6c8', '#9fc08a', '#c8a68a'][index] }
      })
      await (sample.kind === 'jpeg' ? builder.jpeg({ quality: 80 }) : sample.kind === 'png' ? builder.png() : builder.webp({ quality: 80 })).toFile(file)
      sources.push(file)
    }

    const opened = await callInEditor(editorSession, 'project:open', { root: projectRoot })
    const imported = await callInEditor(editorSession, 'photo:import', {
      requestId: randomUUID(),
      root: projectRoot,
      files: sources,
      duplicatePolicy: 'ask',
      existingHashes: []
    })
    const photos = (imported.photos ?? []).map((photo, index) => ({ ...photo, takenAt: SAMPLES[index]?.takenAt ?? null }))
    await callInEditor(editorSession, 'project:save', {
      root: projectRoot,
      document: { ...opened.project.document, photos }
    })
    await callInEditor(editorSession, 'project:close', { root: projectRoot })
    const reloaded = await callInEditor(editorSession, 'project:open', { root: projectRoot })
    const importedNames = photos.map((photo) => photo.fileName)

    const listReady = await waitFor(
      '照片列表渲染出导入的三张照片',
      async () => {
        const snapshot = await editorSession.evaluate(
          `(() => { const rows = [...document.querySelectorAll('[data-photo-index]')]; const thumbs = [...rows].filter((row) => { const img = row.querySelector('img'); return img !== null && img.complete && img.naturalWidth > 0 }); return { rows: rows.length, thumbs: thumbs.length, count: document.querySelector('[data-smoke="photo-count"]')?.textContent ?? '', selected: document.querySelector('[data-smoke="photo-pick"]')?.getAttribute('aria-pressed') } })()`
        )
        return snapshot.rows === 3 && snapshot.thumbs === 3 && snapshot.count.startsWith('3') ? snapshot : null
      },
      15000
    )
    record(
      '打开项目后界面镜像到主进程的会话，列表用缩略图档渲染真实照片',
      listReady !== null,
      `${listReady?.rows} 行 / ${listReady?.thumbs} 张缩略图 / ${listReady?.count}`
    )
    record(
      '列表顺序就是磁盘顺序，序号由下标派生',
      (await domOrder(editorSession)).join('\n') === importedNames.join('\n'),
      (await domOrder(editorSession)).join(' → ')
    )

    const firstRowStyle = await editorSession.evaluate(
      `(() => { const row = document.querySelector('[data-photo-index="0"]'); const box = row.getBoundingClientRect(); return { height: Math.round(box.height), top: Math.round(box.top) } })()`
    )
    record('行高固定且按数组下标排布（虚拟滚动的前提）', firstRowStyle.height > 40, `${firstRowStyle.height}px @ ${firstRowStyle.top}px`)

    const sortedAsc = [importedNames[2], importedNames[0], importedNames[1]]
    await editorSession.evaluate(`document.querySelector('[data-smoke="sort-apply"]').click()`)
    const dialogText = await waitFor(
      '覆盖手动顺序前弹出确认门槛',
      async () => {
        const text = await editorSession.evaluate(`document.querySelector('dialog[open]')?.innerText ?? null`)
        return text === null ? null : text
      },
      8000
    )
    record(
      '自动排序先确认"会覆盖手动顺序"，并如实说明无时间与不可撤销',
      dialogText.includes('覆盖') && dialogText.includes('读不出拍摄时间') && dialogText.includes('无法退回'),
      dialogText.replace(/\s+/g, ' ').slice(0, 120)
    )

    await editorSession.evaluate(`document.querySelector('[data-smoke="confirm-ok"]').click()`)
    await waitForOrder(editorSession, sortedAsc)
    await waitForSaved(editorSession)
    const afterSort = JSON.parse(await readFile(path.join(projectRoot, 'project.json'), 'utf8'))
    record(
      '按拍摄时间升序重排后，读不出时刻的排到最后，磁盘与界面一致',
      (afterSort.photos ?? []).map((photo) => photo.fileName).join('\n') === sortedAsc.join('\n'),
      sortedAsc.join(' → ')
    )

    await editorSession.evaluate(`document.querySelector('[data-smoke="sort-apply"]').click()`)
    const alreadySortedNotice = await waitFor(
      '顺序已符合时给出"已经是该顺序"的提示',
      async () => {
        const text = await editorSession.evaluate(`document.querySelector('[data-smoke="sort-notice"]')?.textContent ?? ''`)
        return text.includes('已经是') ? text : null
      },
      8000
    )
    const askedAgain = await editorSession.evaluate(`document.querySelector('dialog[open]') !== null`)
    record('顺序已符合时不再要求确认', askedAgain === false && (await domOrder(editorSession)).join('\n') === sortedAsc.join('\n'), alreadySortedNotice)

    await editorSession.evaluate(
      `(() => { const first = document.querySelector('[data-photo-index="0"]'); first.querySelector('[data-smoke="photo-pick"]').click(); return first.dataset.photoName })()`
    )
    const movedDown = [sortedAsc[1], sortedAsc[0], sortedAsc[2]]
    await editorSession.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }))`
    )
    await waitForOrder(editorSession, movedDown)
    await waitForSaved(editorSession)
    const selectedAfterMove = await editorSession.evaluate(
      `(() => { const rows = [...document.querySelectorAll('[data-photo-index]')]; const picked = rows.find((row) => row.querySelector('[data-smoke="photo-pick"]')?.getAttribute('aria-pressed') === 'true'); return picked ? [Number(picked.dataset.photoIndex), picked.dataset.photoName] : null })()`
    )
    record(
      'Alt+↓ 把选中的照片下移一位，序号与选中项一起跟随',
      movedDown.join('\n') === (await domOrder(editorSession)).join('\n') &&
        selectedAfterMove?.[0] === 1 &&
        selectedAfterMove?.[1] === movedDown[1],
      JSON.stringify(selectedAfterMove)
    )

    const dragged = [movedDown[1], movedDown[2], movedDown[0]]
    const ghostShown = await dragRow(editorSession, 0, 2)
    let dragSettled = true
    try {
      await waitForOrder(editorSession, dragged)
      await waitForSaved(editorSession)
    } catch {
      dragSettled = false
    }
    const orderAfterDrag = await domOrder(editorSession)
    record(
      '按住手柄拖到另一行即可改顺序，序号随下标重算',
      dragSettled && orderAfterDrag.join('\n') === dragged.join('\n'),
      orderAfterDrag.join(' → ')
    )
    record('拖拽期间显示跟随指针的幽灵行', ghostShown === true)

    await callInEditor(editorSession, 'project:close', { root: projectRoot })
    const reopened = await callInEditor(editorSession, 'project:open', { root: projectRoot })
    const onDisk = reopened.project.document.photos.map((photo) => photo.fileName)
    const afterReopen = await waitFor(
      '重新打开后列表按磁盘顺序渲染',
      async () => (((await domOrder(editorSession)).join('\n') === onDisk.join('\n')) ? onDisk : null),
      12000
    )
    record(
      '关闭再重开，排序改动原样还在（T4 出口标准）',
      afterReopen !== null && onDisk.join('\n') === dragged.join('\n'),
      onDisk.join(' → ')
    )

    const crowded = reopened.project.document.photos.flatMap((photo, index) =>
      Array.from({ length: 100 }, (_, slot) => ({
        ...photo,
        id: randomUUID(),
        hash: sha256(Buffer.from(`padding-${index}-${slot}`))
      }))
    )
    await callInEditor(editorSession, 'project:save', {
      root: projectRoot,
      document: { ...reopened.project.document, photos: crowded }
    })
    await callInEditor(editorSession, 'project:close', { root: projectRoot })
    await callInEditor(editorSession, 'project:open', { root: projectRoot })
    const bigList = await waitFor(
      '300 张的列表渲染完成',
      async () => {
        const snapshot = await editorSession.evaluate(
          `(() => { const rows = [...document.querySelectorAll('[data-photo-index]')]; return { rows: rows.length, listed: document.querySelector('[data-smoke="photo-count"]')?.textContent ?? '' } })()`
        )
        return snapshot.listed.startsWith('300') ? snapshot : null
      },
      12000
    )
    record(
      '300 张只渲染窗口内的行，DOM 行数远低于总数（AGENTS.md §4.9）',
      bigList.rows > 0 && bigList.rows < 60,
      `${bigList.rows} 行 / ${bigList.listed}`
    )

    await callInEditor(editorSession, 'project:close', { root: projectRoot })
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
  }
}

const app = spawn(ELECTRON_BIN, [process.cwd(), `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], {
  stdio: 'inherit'
})
let editorSession = null
let printSession = null
let interruption = null

try {
  const editorTarget = await waitFor('编辑器窗口', async () =>
    (await pageTargets()).find((target) => target.url.endsWith('index.html') && !target.url.includes('print/'))
  )
  editorSession = await connect(editorTarget.webSocketDebuggerUrl)

  const infoShown = await waitFor('IPC 应用信息上屏', async () =>
    (await editorSession.evaluate(`document?.body ? document.body.innerText.includes('运行环境') : false`)) ? true : null
  )
  record('主进程 → 渲染进程的 IPC 往返', infoShown === true)

  const verdicts = await waitFor('pzfile 三个探针均有结论', async () => {
    const map = await editorSession.evaluate(
      `document ? Object.fromEntries([...document.querySelectorAll('[data-smoke-result]')].map((el) => [el.dataset.smokeVerdict, el.dataset.smokeResult])) : {}`
    )
    const values = Object.values(map)
    return values.length === 3 && values.every((value) => value === 'pass' || value === 'fail') ? map : null
  })
  record('pzfile 读取授权根内的文件', verdicts.ok === 'pass', `ok=${verdicts.ok}`)
  record('pzfile 拒绝越出授权根（编码 ..）', verdicts.traversal === 'pass', `traversal=${verdicts.traversal}`)
  record('pzfile 不存在的文件不放行', verdicts.missing === 'pass', `missing=${verdicts.missing}`)

  await editorSession.evaluate(`document.querySelector('[data-smoke="open-print"]').click()`)


  const printTarget = await waitFor('打印窗口出现', async () =>
    (await pageTargets()).find((target) => target.url.includes('print/index.html'))
  )
  record('编辑器与打印两个窗口同时存在', true, `print windowId=${printTarget.id.slice(0, 8)}`)

  printSession = await connect(printTarget.webSocketDebuggerUrl)
  const printState = await waitFor('打印窗口版面与图片就绪', async () => {
    const value = await printSession.evaluate(
      `document && document.body ? ({
        pages: document.querySelectorAll('.pz-page').length,
        overlays: document.querySelectorAll('.pz-editor-only').length,
        overlayHidden: [...document.querySelectorAll('.pz-editor-only')].every((el) => getComputedStyle(el).display === 'none'),
        images: document.images.length,
        imagesLoaded: [...document.images].length > 0 && [...document.images].every((img) => img.complete && img.naturalWidth > 0)
      }) : null`
    )
    return value && value.pages > 0 && value.imagesLoaded ? value : null
  })
  record('打印入口渲染 2 个版面页', printState.pages === 2, `实际 ${printState.pages} 页`)
  record('编辑叠加层在打印入口隐藏', printState.overlays > 0 && printState.overlayHidden === true, `叠加层 ${printState.overlays} 个`)
  record('打印入口经 pzfile 取图成功', printState.imagesLoaded === true, `${printState.images} 张图片`)

  const eventLine = await waitFor('打印窗口回执广播回编辑器', async () => {
    const lines = await editorSession.evaluate(
      `document ? [...document.querySelectorAll('[data-smoke="events"] li')].map((li) => li.textContent) : []`
    )
    return lines.find((line) => line.includes('渲染 2 页')) ?? null
  })
  record('渲染进程 → 主进程 → 另一窗口的事件链', true, eventLine)

  await runImportChecks(editorSession)
  await runOrderChecks(editorSession)
} catch (error) {
  interruption = error
  if (editorSession) {
    const text = await editorSession.evaluate('document?.body ? document.body.innerText : "<文档未就绪>"').catch(() => '<无法读取>')
    console.error(`界面当前内容：\n${String(text).slice(0, 600)}`)
  }
} finally {
  editorSession?.close()
  printSession?.close()
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    app.kill()
  }
}

for (const check of checks) {
  console.log(`${check.pass ? '通过' : '失败'}  ${check.name}${check.detail ? `  [${check.detail}]` : ''}`)
}

if (interruption) {
  console.error(`冒烟中断：${interruption.message}`)
  process.exitCode = 1
} else if (checks.some((check) => !check.pass)) {
  console.error('冒烟未通过')
  process.exitCode = 1
} else {
  console.log(`冒烟通过：${checks.length} 项`)
}
