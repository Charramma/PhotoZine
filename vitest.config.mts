import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** 只测跨进程共享的纯逻辑与主进程的磁盘逻辑；界面行为在集成冒烟中验证 */
export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('src/shared', import.meta.url)) }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
