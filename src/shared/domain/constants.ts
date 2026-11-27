/** 跨进程共享常量的唯一来源（AGENTS.md §2.2：禁止在业务代码中散落魔法数值与路径） */

/** 项目文件读取协议，用法 `pzfile://<根名>/<相对路径>`（总体设计稿 §5） */
export const PZFILE_SCHEME = 'pzfile'

/** 协议已授权的根名。应用自身资源根用于开发探针；项目根由主进程在打开项目时注册 */
export const PZFILE_ROOT_APP = 'app'

/** 当前项目的根名：界面取缩略图与派生图只用这一个名字（AGENTS.md §3.3） */
export const PZFILE_ROOT_PROJECT = 'project'

/** 项目文件夹的固定文件名（总体设计稿 §3） */
export const PROJECT_FILES = {
  data: 'project.json',
  backup: 'project.json.bak',
  lock: 'project.json.lock',
  staging: 'project.json.tmp',
  /** 主文件损坏且备份可用时，把损坏文本另存为此名供人工诊断 */
  damaged: 'project.json.corrupt'
} as const

/**
 * 项目内固定目录（总体设计稿 §3）：一律写成相对项目根的 POSIX 风格路径，
 * 交给 `projectPath` / `resolveInRoot` 拼接，禁止各处自写分隔符。
 * 除 `photos/` 外全部是可丢弃缓存，缺失即重建（AGENTS.md §5.5）。
 */
export const PROJECT_DIRS = {
  /** 原图目录：字节级拷贝、永不改写（AGENTS.md §5.6） */
  photos: 'photos',
  thumbnails: 'thumbnails',
  derivedPreview: 'derived/preview',
  derivedPrint: 'derived/print',
  derivedHeic: 'derived/heic',
  export: 'export',
  /** 导入与导出的半成品目录，持有项目锁时清扫 */
  scratch: '.tmp'
} as const

/** 打开项目时保证存在的目录骨架 */
export const PROJECT_SKELETON_DIRS: readonly string[] = Object.values(PROJECT_DIRS)

/**
 * 项目锁心跳间隔与陈旧阈值，陈旧锁可抢占（总体设计稿 §7）。
 * `textWidth`：锁文本的定宽字节数 —— 心跳用 `r+` 原地覆写，文本必须**永远同长**，
 * 否则"写短文本 → 截断"之间有个窗口，并发读会看到上一任持有者留下的尾巴（解析失败）。
 * 256 足够覆盖 `pid`（≤10 位）+ 主机名（DNS 单标签 ≤63）+ 定长 ISO 时间戳与 JSON 骨架。
 */
export const PROJECT_LOCK = {
  heartbeatMs: 3000,
  staleMs: 10000,
  readRetryMs: 20,
  textWidth: 256
} as const

/** `aspect` 与显示宽高的一致性容差（不变式 I-07） */
export const ASPECT_EPSILON = 1e-3

/** 项目名长度上限（FR-PROJ-01） */
export const PROJECT_NAME_MAX_LENGTH = 60

/** 单张照片描述的字符上限（FR-DESC-01） */
export const DESCRIPTION_MAX_CHARS = 2000

/** 空槽位的默认裁切视点，版面居中（D-10） */
export const DEFAULT_FOCUS = 0.5

/* ---------------------------------- 图像管线 ---------------------------------- */

/**
 * 导入支持的图片格式（需求文档 FR-PHOTO-01）：键是格式，值是可接受的扩展名（小写）。
 * 落盘保留用户给的扩展名写法，格式判定见 `shared/domain/photo/imageFormat.ts`。
 */
export const IMAGE_FORMAT_EXTENSIONS = {
  jpeg: ['jpg', 'jpeg'],
  png: ['png'],
  webp: ['webp'],
  heic: ['heic']
} as const

/** 面向用户的格式写法：清单只此一份，提示语从这里派生，不与白名单分叉 */
export const IMAGE_FORMAT_LABELS: Record<keyof typeof IMAGE_FORMAT_EXTENSIONS, string> = {
  jpeg: 'JPG/JPEG',
  png: 'PNG',
  webp: 'WebP',
  heic: 'HEIC'
}

/** 缩略图档（总体设计稿 §5）：列表与网格只用它，界面任何地方不加载原图 */
export const THUMBNAIL = { longEdgePx: 400, quality: 78 } as const

/**
 * HEIC 解码产物（总体设计稿 §5）：摆正后的位图，是 HEIC 后续所有档位的图片来源，
 * 质量取高值以免与打印档形成两次明显损失。
 */
export const HEIC_DERIVED = { quality: 92 } as const

/**
 * 图像处理并发与超大图阈值（总体设计稿 §5、需求文档 FR-PHOTO-01）。
 * `progressThrottleMs`：导入进度的跨进程合并窗口，小图批量时避免每秒上百次广播与重绘。
 */
export const IMAGE_PIPELINE = {
  concurrency: 4,
  maxPixels: 40_000_000,
  progressThrottleMs: 100
} as const

/** 拷贝与哈希共用的读块大小：1MiB */
export const COPY_CHUNK_BYTES = 1 << 20

/** 编辑器窗口最小尺寸与初始尺寸（需求文档 §7.2） */
export const EDITOR_WINDOW = {
  minWidth: 1280,
  minHeight: 800,
  width: 1440,
  height: 900
} as const

/** 打印窗口在屏幕上不展示，尺寸只影响调试观感 */
export const PRINT_WINDOW = { width: 1000, height: 700 } as const

/** 版面几何一律以 mm 为单位（总体设计稿 §3） */
export const PAGE_A4 = { widthMm: 210, heightMm: 297 } as const

export const PAGE_SIZE_KEYS = ['A4-portrait', 'A4-landscape'] as const
export type PageSizeKey = (typeof PAGE_SIZE_KEYS)[number]

export const PAGE_SIZES: Record<PageSizeKey, { widthMm: number; heightMm: number }> = {
  'A4-portrait': PAGE_A4,
  'A4-landscape': { widthMm: PAGE_A4.heightMm, heightMm: PAGE_A4.widthMm }
}
