import { access, open, readFile, rename, stat } from 'node:fs/promises'
import type { ZodError } from 'zod'
import { PROJECT_DIRS, PROJECT_FILES } from '@shared/domain/constants'
import { validateProject, type Issue, type PatternLookup } from '@shared/domain/project/invariants'
import { migrateProject, projectMigrations } from '@shared/domain/project/migrate'
import {
  forwardCompatibleDocumentSchema,
  projectDocumentSchema,
  type FutureProjectDocument,
  type ProjectDocument
} from '@shared/domain/project/schema'
import { ensureProjectSkeleton, sweepProjectScratch } from './projectLayout'
import {
  acquireProjectLock,
  releaseProjectLock,
  startProjectLockHeartbeat,
  type ProjectLock
} from './projectLock'
import { projectPath, resolveInRoot, rootKey } from './projectPath'
import type { OpenedProject, OpenOutcome, SaveOutcome } from '@shared/ipc/contract'

/**
 * `project.json` 的唯一读写入口（AGENTS.md §5.4）：
 * 原子写（tmp + fsync + rename）、`.bak` 只承接上一次**成功写入**的内容、
 * 写盘串行队列、抢锁失败降级只读、外部改动检测。
 *
 * 对外形状（打开结果、保存结果）由 IPC 契约定义，这里只实现它 ——
 * 主进程实现与渲染进程调用不可能各自长成不一样的样子（AGENTS.md §3.4）。
 */

export type { OpenedProject, OpenOutcome, SaveOutcome }

interface Session {
  root: string
  lock: ProjectLock | null
  stopHeartbeat: (() => void) | null
  readOnlyReason: string | null
  diskMtimeMs: number
  /** 磁盘上主文件的身份：`damaged` 表示是回退备份时留下的损坏文本，下次保存先另存供诊断 */
  diskState: 'valid' | 'damaged'
  queue: Promise<unknown>
}

const sessions = new Map<string, Session>()

const zodIssues = (error: ZodError): Issue[] =>
  error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))

type Interpretation =
  | { kind: 'loaded'; document: ProjectDocument; fixes: Issue[]; warnings: Issue[] }
  /** 文件版本高于应用：内容按宽松形状读取供只读展示，类型上就与"可保存的文档"区分开 */
  | { kind: 'newer'; version: number; document: FutureProjectDocument }
  | { kind: 'rejected'; errors: Issue[] }

/** 单个来源文本的判读：迁移 → 形状 → 不变式 */
function interpret(rawText: string, lookupPattern: PatternLookup): Interpretation {
  let json: unknown
  try {
    json = JSON.parse(rawText)
  } catch (error) {
    return { kind: 'rejected', errors: [{ path: '', message: `内容不是合法 JSON：${(error as Error).message}` }] }
  }

  const migration = migrateProject(json, projectMigrations)
  if (migration.kind === 'invalid') {
    return { kind: 'rejected', errors: [{ path: 'schemaVersion', message: migration.message }] }
  }
  if (migration.kind === 'unsupported-version') {
    return {
      kind: 'rejected',
      errors: [
        {
          path: 'schemaVersion',
          message: `项目文件版本 v${migration.version} 过旧，当前应用不支持其迁移链（AGENTS.md §5.7）`
        }
      ]
    }
  }
  if (migration.kind === 'newer-version') {
    const forward = forwardCompatibleDocumentSchema.safeParse(migration.document)
    if (!forward.success) {
      return {
        kind: 'rejected',
        errors: [
          {
            path: 'schemaVersion',
            message: `项目文件版本 v${migration.version} 高于当前应用且结构无法读取，请升级应用后再打开`
          },
          ...zodIssues(forward.error)
        ]
      }
    }
    return { kind: 'newer', version: migration.version, document: forward.data }
  }

  const report = validateProject(migration.document, lookupPattern)
  if (report.status === 'invalid' || report.document === null) {
    return { kind: 'rejected', errors: report.errors }
  }
  return {
    kind: 'loaded',
    document: report.document,
    fixes: [...(migration.kind === 'migrated' ? migration.steps : []), ...report.fixes],
    warnings: report.warnings
  }
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

type DiskRead =
  | (Extract<Interpretation, { kind: 'loaded' }> & { diskMtimeMs: number; diskState: Session['diskState'] })
  | Extract<Interpretation, { kind: 'newer' }>
  | Extract<OpenOutcome, { kind: 'corrupt' }>

/** 主文件判读失败时回退备份。打开过程只读不写，损坏文本留到下次保存再另存 */
async function readFromDisk(root: string, lookupPattern: PatternLookup): Promise<DiskRead> {
  const dataFile = projectPath(root, PROJECT_FILES.data)
  const backupFile = projectPath(root, PROJECT_FILES.backup)

  const primaryText = await readTextOrNull(dataFile)
  if (primaryText === null) {
    return { kind: 'corrupt', errors: [{ path: '', message: `${PROJECT_FILES.data} 无法读取` }], inspected: [dataFile] }
  }
  const dataMtimeMs = (await stat(dataFile).catch(() => null))?.mtimeMs ?? 0
  const primary = interpret(primaryText, lookupPattern)
  if (primary.kind === 'newer') return primary
  if (primary.kind === 'loaded') {
    return { ...primary, diskMtimeMs: dataMtimeMs, diskState: 'valid' }
  }

  const backupText = await readTextOrNull(backupFile)
  if (backupText === null) {
    return { kind: 'corrupt', errors: primary.errors, inspected: [dataFile] }
  }
  const fromBackup = interpret(backupText, lookupPattern)
  if (fromBackup.kind === 'newer') return fromBackup
  if (fromBackup.kind !== 'loaded') {
    return { kind: 'corrupt', errors: fromBackup.errors, inspected: [dataFile, backupFile] }
  }

  return {
    ...fromBackup,
    warnings: [
      {
        path: PROJECT_FILES.data,
        message: `${PROJECT_FILES.data} 已损坏，已改用 ${PROJECT_FILES.backup} 的内容；下次保存会把损坏文本另存为 ${PROJECT_FILES.damaged} 供诊断，备份不会被损坏内容覆盖`
      },
      ...fromBackup.warnings
    ],
    diskMtimeMs: dataMtimeMs,
    diskState: 'damaged'
  }
}

export async function openProject(root: string, lookupPattern: PatternLookup): Promise<OpenOutcome> {
  const key = rootKey(root)
  if (sessions.has(key)) return { kind: 'already-open' }

  const dataFile = projectPath(root, PROJECT_FILES.data)
  if ((await stat(dataFile).catch(() => null)) === null) return { kind: 'not-a-project' }

  const lock = await acquireProjectLock(root)
  const read = await readFromDisk(root, lookupPattern)
  if (read.kind === 'corrupt') {
    if (lock.kind === 'acquired') await releaseProjectLock(lock.lock)
    return read
  }
  if (read.kind === 'newer') {
    // 只读展示不占锁：更高版本的应用应能照常编辑它
    if (lock.kind === 'acquired') await releaseProjectLock(lock.lock)
    return { kind: 'newer-version', root, version: read.version, document: read.document }
  }

  if (lock.kind === 'acquired') {
    // 半成品只有在确认没有别的实例持有项目时才清理：另一个实例可能正在往 `.tmp/<uuid>/`
    // 写导入中的照片，没拿到锁的一方删它的数据就是数据损坏（D-12）
    await sweepProjectScratch(root)
    // 缓存目录用户可以随时删掉，打开时补齐，后续模块据此假定它们存在（AGENTS.md §5.5）
    await ensureProjectSkeleton(root)
  }

  const session: Session = {
    root,
    lock: lock.kind === 'acquired' ? lock.lock : null,
    stopHeartbeat: null,
    readOnlyReason:
      lock.kind === 'busy'
        ? `该项目已在别处打开（${lock.owner.machine} / PID ${lock.owner.pid}），已只读打开`
        : null,
    diskMtimeMs: read.diskMtimeMs,
    diskState: read.diskState,
    queue: Promise.resolve()
  }
  if (session.lock !== null) {
    session.stopHeartbeat = startProjectLockHeartbeat(session.lock, () => {
      session.readOnlyReason = '项目锁已被其他进程接管，本窗口转为只读'
    })
  }
  sessions.set(key, session)

  const missingPhotoIds = await findMissingPhotos(root, read.document)
  return {
    kind: 'opened',
    project: {
      root,
      document: read.document,
      fixes: read.fixes,
      warnings: [
        ...read.warnings,
        ...missingPhotoIds.map(
          (id): Issue => ({ path: `${PROJECT_DIRS.photos}.${id}`, message: '原图文件缺失，已从排版临时摘除（I-06）' })
        )
      ],
      missingPhotoIds,
      readOnlyReason: session.readOnlyReason
    }
  }
}

/** I-06 需要文件系统，因此由存储层执行而不是共享层的不变式校验 */
async function findMissingPhotos(root: string, document: ProjectDocument): Promise<string[]> {
  const missing: string[] = []
  await Promise.all(
    document.photos.map(async (photo) => {
      // 落盘名字来自 `project.json`，必须经边界解析；解析不出来的按缺失处理（AGENTS.md §5.3）
      const target = resolveInRoot(root, `${PROJECT_DIRS.photos}/${photo.fileName}`)
      if (target === null || (await access(target).then(() => true, () => false)) === false) {
        missing.push(photo.id)
      }
    })
  )
  return missing
}

/** 串行写队列：同一项目的写盘永不交错（AGENTS.md §5.4） */
function enqueue<T>(session: Session, task: () => Promise<T>): Promise<T> {
  const run = session.queue.then(task, task)
  session.queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export type WriteAccess = { kind: 'granted'; root: string } | { kind: 'denied'; reason: string }

/**
 * 写入资格判定：任何要往项目里写字节的流程（导入、导出）都必须先过这一关 ——
 * 没打开或处于只读降级时一律拒绝，禁止"再试一次就写"（AGENTS.md §3.6、总体设计稿 D-12）。
 * 通过时给出会话登记的项目根：同一目录的不同写法共用一份会话，路径也必须只有一种拼法。
 */
export function requireWriteAccess(root: string): WriteAccess {
  const session = sessions.get(rootKey(root))
  if (session === undefined) return { kind: 'denied', reason: '项目尚未打开，请先选择项目文件夹' }
  if (session.readOnlyReason !== null) return { kind: 'denied', reason: session.readOnlyReason }
  return { kind: 'granted', root: session.root }
}

/** 项目文件的唯一写入口，其他模块不得自行写 `project.json`（AGENTS.md §5.4） */
export async function saveProject(root: string, document: ProjectDocument): Promise<SaveOutcome> {  const session = sessions.get(rootKey(root))
  if (session === undefined) return { kind: 'not-open' }
  if (session.readOnlyReason !== null) return { kind: 'refused', reason: session.readOnlyReason }

  const validated = projectDocumentSchema.safeParse(document)
  if (!validated.success) return { kind: 'rejected', errors: zodIssues(validated.error) }

  const wanted = validated.data
  return enqueue(session, async () => {
    const dataFile = projectPath(session.root, PROJECT_FILES.data)
    const stagingFile = projectPath(session.root, PROJECT_FILES.staging)

    const current = await stat(dataFile).catch(() => null)
    if ((current?.mtimeMs ?? 0) !== session.diskMtimeMs) {
      return { kind: 'conflict', diskMtimeMs: current?.mtimeMs ?? 0 }
    }

    // "最后保存时间"由写盘这一处唯一决定，避免界面与磁盘各存一份真相
    const persisted: ProjectDocument = {
      ...wanted,
      meta: { ...wanted.meta, updatedAt: new Date().toISOString() }
    }
    const currentText = await readTextOrNull(dataFile)

    await writeAndSync(stagingFile, JSON.stringify(persisted, null, 2))
    // 损坏文本进诊断文件，只有成功写入过的内容才配成为新的备份
    if (currentText !== null && session.diskState === 'damaged') {
      await writeAndSync(projectPath(session.root, PROJECT_FILES.damaged), currentText)
    } else if (currentText !== null) {
      await writeAndSync(projectPath(session.root, PROJECT_FILES.backup), currentText)
    }
    await rename(stagingFile, dataFile)

    session.diskState = 'valid'
    session.diskMtimeMs = (await stat(dataFile).catch(() => null))?.mtimeMs ?? 0
    return { kind: 'saved', document: persisted }
  })
}

async function writeAndSync(file: string, text: string): Promise<void> {
  const handle = await open(file, 'w')
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** 关闭项目：排干写队列后释放锁，锁被别人接管时不动别人的文件 */
export async function closeProject(root: string): Promise<void> {
  const key = rootKey(root)
  const session = sessions.get(key)
  if (session === undefined) return
  await session.queue.catch(() => undefined)
  session.stopHeartbeat?.()
  if (session.lock !== null) await releaseProjectLock(session.lock)
  sessions.delete(key)
}
