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
