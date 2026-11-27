import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * 这里实现的是总体设计稿 §2 与 AGENTS.md §3 的边界规则：
 * 违反即 lint 失败，不允许 eslint-disable 绕过。
 */

const NODEsideFiles = ['src/main/**/*.ts', 'src/preload/**/*.ts', 'electron.vite.config.ts', 'vitest.config.mts']
const webSideFiles = ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.{ts,tsx}']

/** Node 内置模块的不带前缀写法：必须精确匹配模块名，否则会误伤 `@shared/fs/*` 这类路径 */
const nodeBuiltinNames = ['fs', 'fs/promises', 'path', 'os', 'child_process', 'worker_threads', 'crypto']

const nodeAccessMessage = '界面侧不得访问 Node 能力，改走 window.pz 桥（AGENTS.md §3.1）'

const forbiddenNodeAccess = {
  paths: [
    { name: 'electron', message: '只允许主进程与预加载使用 Electron（AGENTS.md §3.1）' },
    // 原生图像处理只在主进程跑，且必须经 src/main/image/sharpRuntime 统一配置
    { name: 'sharp', message: '图像处理只允许主进程使用（AGENTS.md §6.1、§8.3）' },
    ...nodeBuiltinNames.map((name) => ({ name, message: nodeAccessMessage }))
  ],
  patterns: [{ group: ['node:*'], message: nodeAccessMessage }]
}

const commonRules = {
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'error',
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }]
}

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'coverage/**'] },

  {
    files: NODEsideFiles,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      ...commonRules,
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
      // sharp 只能在 src/main/image/sharpRuntime.ts 里引入一次：句柄缓存与并发配置必须唯一收口
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'sharp', message: '请经 src/main/image/sharpRuntime 使用 sharp（AGENTS.md §6.1）' }]
        }
      ]
    }
  },

  {
    // 唯一的例外就是收口文件本身，它必须直接引入 sharp 才能配置
    files: ['src/main/image/sharpRuntime.ts'],
    rules: { 'no-restricted-imports': 'off' }
  },

  {
    files: webSideFiles,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...commonRules, 'no-restricted-imports': ['error', forbiddenNodeAccess] }
  },

  {
    // 版面层是预览与打印的唯一实现，绝不能反向依赖界面（总体设计稿 §2 规则 1）
    files: ['src/shared/magazine/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: forbiddenNodeAccess.paths,
          patterns: [
            ...forbiddenNodeAccess.patterns,
            {
              group: ['**/renderer/**', '**/views/**', '**/print/**'],
              message: '版面层不得依赖编辑器界面，它必须能被打印入口独立使用（总体设计稿 §2）'
            }
          ]
        }
      ]
    }
  },

  {
    // 打印入口只渲染版面，不含任何编辑器 UI（总体设计稿 §2 规则 2）
    files: ['src/renderer/print/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: forbiddenNodeAccess.paths,
          patterns: [
            ...forbiddenNodeAccess.patterns,
            {
              group: ['**/views/**', '**/components/**', '../views/*', '../views/**', '../components/*', '../components/**'],
              message: '打印入口不得引入编辑器界面组件（AGENTS.md §3.7）'
            }
          ]
        }
      ]
    }
  }
)
