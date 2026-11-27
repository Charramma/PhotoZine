import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startSessionMirror } from './api/project'
import { APP_KEY_BINDINGS } from './keybindings'
import { registerKeyBindings } from './keymap'
import { EditorView } from './views/EditorView'
import './styles/tokens.css'
import './styles/global.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('缺少 #root 挂载点')
}

// 会话状态镜像主进程；全应用唯一的按键监听（AGENTS.md §4.14），键位表见 `keybindings.ts`
startSessionMirror()
registerKeyBindings(APP_KEY_BINDINGS)

createRoot(rootElement).render(
  <StrictMode>
    <EditorView />
  </StrictMode>
)
