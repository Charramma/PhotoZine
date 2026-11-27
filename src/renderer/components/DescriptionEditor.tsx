import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type MouseEvent } from 'react'
import { DESCRIPTION_MAX_CHARS, DESCRIPTION_WARN_CHARS } from '@shared/domain/constants'
import { setDescriptionInDocument, sameRichText } from '@shared/domain/project/description'
import { countCharacters, type RichText } from '@shared/domain/project/schema'
import { parseRichText, renderRichText } from '../richTextDom'
import { applyDocumentCommand } from '../store/documentCommands'
import { useEditorUi } from '../store/editorUi'
import { useProjectSession } from '../store/projectSession'
import styles from './DescriptionEditor.module.css'

/**
 * 描述编辑器（需求文档 FR-DESC-01、总体设计稿 D-07）：编辑现场就是 contenteditable，
 * 契约与 DOM 之间的双向映射只在 `richTextDom` 一处。
 *
 * 受控方式：**输入期不回填 DOM**。每次输入只把 DOM 解析进 store（换照片、撤销、
 * 插入拍摄信息这类外部变更才重建编辑现场），这样中文输入的组字过程不会被踩，
 * 落盘回写换了对象引用也不会把光标弹走。
 *
 * 对外没有 props：编辑目标来自 `editorUi`，文档与只读降级来自会话，改动一律走命令入口。
 */

const TOOL_LABEL = {
  bold: '加粗',
  italic: '斜体',
  justifyLeft: '左对齐',
  justifyCenter: '居中',
  justifyRight: '右对齐'
} as const

type Command = keyof typeof TOOL_LABEL

const TOOL_GROUPS: readonly { label: string; commands: readonly Command[] }[] = [
  { label: '文字样式', commands: ['bold', 'italic'] },
  { label: '段落对齐', commands: ['justifyLeft', 'justifyCenter', 'justifyRight'] }
]

/** 能力集之内浏览器自己实现的格式动作（Ctrl+B/I 也在其中，默认行为正是我们要的） */
const SUPPORTED_FORMAT = new Set<string>(['formatBold', 'formatItalic', 'justifyLeft', 'justifyCenter', 'justifyRight'])

/** 点工具条按钮不该把焦点从编辑区抢走，否则选区就没了 */
function keepSelection(event: MouseEvent): void {
  event.preventDefault()
}

/** 字数一句话：常态报总量，接近上限时改报剩余（FR-DESC-01：1800 起提示） */
function countHint(chars: number): { text: string; className: string | undefined } {
  const remaining = DESCRIPTION_MAX_CHARS - chars
  if (remaining < 0) return { text: `超出 ${-remaining} 字，这部分没有保存`, className: styles.over }
  if (chars >= DESCRIPTION_WARN_CHARS) {
    return { text: `${chars} / ${DESCRIPTION_MAX_CHARS} 字 · 还能写 ${remaining} 字`, className: styles.warn }
  }
  return { text: `${chars} / ${DESCRIPTION_MAX_CHARS} 字`, className: undefined }
}

export function DescriptionEditor() {
  const session = useProjectSession((state) => state.session)
  const selectedPhotoId = useEditorUi((state) => state.selectedPhotoId)

  const target = useMemo(() => {
    const photos = session?.document.photos
    if (photos === undefined || selectedPhotoId === null) return null
    const index = photos.findIndex((photo) => photo.id === selectedPhotoId)
    const photo = photos.at(index)
    return photo === undefined ? null : { index, photo }
  }, [session, selectedPhotoId])

  if (session === null) return <p className={styles.hint}>先打开项目文件夹</p>
  if (target === null) return <p className={styles.hint}>先在左边挑一张照片，再写它的描述</p>

  return (
    <div className={styles.shell}>
      <p className={styles.identity} data-smoke="desc-target">{`第 ${target.index + 1} 张 · ${target.photo.fileName}`}</p>
      <Field
        key={target.photo.id}
        photoId={target.photo.id}
        description={target.photo.description}
        writable={session.readOnlyReason === null}
      />
    </div>
  )
}

interface FieldProps {
  photoId: string
  description: RichText
  writable: boolean
}

/** 一张照片的编辑现场：换照片时整个重建（`key` 在主组件上），光标与脏状态不跨照片残留 */
function Field({ photoId, description, writable }: FieldProps) {
  const editableRef = useRef<HTMLDivElement>(null)
  const seededRef = useRef(false)
  const composingRef = useRef(false)
  /** 编辑现场的字数：闸门与字数行都读它。用 ref 是因为输入事件要读"此刻"的值，不等 React 重渲染 */
  const charsRef = useRef(countCharacters(description))
  const [chars, setChars] = useState(charsRef.current)
  const [notice, setNotice] = useState<string | null>(null)

  /** 编辑现场 → 契约 → 命令入口；越界的内容绝不进 store（落盘契约同样按这个上限校验） */
  const commit = useCallback((): void => {
    const element = editableRef.current
    if (element === null) return
    const next = parseRichText(element)
    const typed = countCharacters(next)
    charsRef.current = typed
    setChars(typed)
    if (typed > DESCRIPTION_MAX_CHARS) {
      setNotice(`描述已有 ${typed} 字，超过 ${DESCRIPTION_MAX_CHARS} 字上限，多出的部分不会保存，请删减后再继续`)
      return
    }
    if (applyDocumentCommand((document) => setDescriptionInDocument(document, photoId, next))) setNotice(null)
  }, [photoId])

  // 挂载时把契约渲染进编辑现场；此后只有"store 里的这份与 DOM 不一样"才重建
  useEffect(() => {
    const element = editableRef.current
    if (element === null || composingRef.current) return
    if (seededRef.current && sameRichText(parseRichText(element), description)) return
    seededRef.current = true
    renderRichText(element, description)
    charsRef.current = countCharacters(description)
    setChars(charsRef.current)
  }, [description])

  /**
   * 输入闸门用原生 `beforeinput`，不用 React 的 `onBeforeInput`：
   * 后者在 Chromium 里是 `textInput` 的替身，只随文字输入触发，
   * Ctrl+U 这类格式命令根本不经过它 —— 闸门会漏掉要拦的那一半。
   */
  useEffect(() => {
    const element = editableRef.current
    if (element === null) return
    const gate = (event: InputEvent): void => {
      const type = event.inputType
      if (
        (type.startsWith('format') || type.startsWith('justify') || type === 'indent' || type === 'outdent') &&
        !SUPPORTED_FORMAT.has(type)
      ) {
        event.preventDefault()
        setNotice('描述只用段落、加粗、斜体与左中右对齐，这种样式进不了项目文件')
        return
      }
      // 组字过程中的事件不拦（拦在中间会把输入会话打断，越界由提交那一步拒绝并说明）；
      // 换行与段落切分不占字数，所以只数将要落进来的字符
      const incoming = event.isComposing ? 0 : (event.data ?? '').replace(/[\r\n]/g, '').length
      if (incoming > 0 && charsRef.current + incoming > DESCRIPTION_MAX_CHARS) {
        event.preventDefault()
        setNotice(`描述最多 ${DESCRIPTION_MAX_CHARS} 字，请删减后再输入`)
      }
    }
    element.addEventListener('beforeinput', gate)
    return () => element.removeEventListener('beforeinput', gate)
  }, [])

  /** 粘贴只取纯文本并保留段落切分（D-07）：带样式的 HTML 一律不进编辑现场 */
  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const lines = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').split('\n')
    const incoming = lines.join('').length
    if (incoming === 0) return
    if (charsRef.current + incoming > DESCRIPTION_MAX_CHARS) {
      setNotice(`这些内容会让描述超过 ${DESCRIPTION_MAX_CHARS} 字上限，请减少要粘贴的文字`)
      return
    }
    for (const [line, text] of lines.entries()) {
      if (line > 0) document.execCommand('insertParagraph')
      if (text !== '') document.execCommand('insertText', false, text)
    }
    commit()
  }

  const applyCommand = (command: Command): void => {
    editableRef.current?.focus()
    document.execCommand(command)
    commit()
  }

  const hint = countHint(chars)

  return (
    <>
      <div className={styles.toolbar} data-smoke="desc-tools">
        {TOOL_GROUPS.map((group) => (
          <div key={group.label} className={styles.group} role="group" aria-label={group.label}>
            {group.commands.map((command) => (
              <button
                key={command}
                type="button"
                disabled={!writable}
                onMouseDown={keepSelection}
                onClick={() => applyCommand(command)}
                data-smoke={`desc-${command}`}
              >
                {TOOL_LABEL[command]}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div
        ref={editableRef}
        className={styles.editable}
        data-smoke="desc-editor"
        role="textbox"
        aria-multiline="true"
        aria-label="照片描述"
        contentEditable={writable}
        suppressContentEditableWarning
        onInput={commit}
        onPaste={onPaste}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
        }}
      />
      <p className={hint.className} data-smoke="desc-count">
        {hint.text}
      </p>
      {notice !== null && (
        <p className={styles.notice} data-smoke="desc-notice">
          {notice}
        </p>
      )}
    </>
  )
}
