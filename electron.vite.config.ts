import path from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/** 三入口共用的路径别名：`@shared` 是主进程、预加载、编辑器与打印入口唯一允许互相引用的目录 */
const alias = { '@shared': path.resolve(__dirname, 'src/shared') }
const rendererRoot = path.resolve(__dirname, 'src/renderer')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { lib: { entry: path.resolve(__dirname, 'src/main/index.ts') } }
  },
  preload: {
    // 沙箱化的 preload 无法 require node_modules，zod 必须打进预加载脚本内
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    resolve: { alias },
    build: { lib: { entry: path.resolve(__dirname, 'src/preload/index.ts') } }
  },
  renderer: {
    root: rendererRoot,
    plugins: [react()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          editor: path.resolve(rendererRoot, 'index.html'),
          print: path.resolve(rendererRoot, 'print/index.html')
        }
      }
    }
  }
})
