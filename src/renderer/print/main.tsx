import { createRoot } from 'react-dom/client'
import { PrintDocument } from './PrintDocument'
import '@shared/magazine/print.css'

const params = new URLSearchParams(window.location.search)
const pages = Math.min(24, Math.max(1, Number(params.get('pages')) || 1))

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('缺少 #root 挂载点')
}

createRoot(rootElement).render(<PrintDocument pages={pages} />)
