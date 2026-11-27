import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from './views/EditorView'
import './styles/tokens.css'
import './styles/global.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('缺少 #root 挂载点')
}

createRoot(rootElement).render(
  <StrictMode>
    <EditorView />
  </StrictMode>
)
