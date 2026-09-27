import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          // 按 pnpm 实际路径形态（node_modules/.pnpm/<pkg>@x/node_modules/<pkg>/...）匹配：
          // 带 node_modules/ 前缀避免误伤（如 react-dom 不该被 /react/ 之外的关键字捕获，
          // 第三方包路径里的 /react/ 也不该混进 react-vendor）
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (
                id.includes('react-markdown') ||
                id.includes('micromark') ||
                id.includes('mdast') ||
                id.includes('hast') ||
                id.includes('unist') ||
                id.includes('remark') ||
                id.includes('rehype')
              ) {
                return 'markdown'
              }
              if (
                id.includes('node_modules/react/') ||
                id.includes('node_modules/react-dom/') ||
                id.includes('node_modules/scheduler/')
              ) {
                return 'react-vendor'
              }
              if (id.includes('motion')) {
                return 'motion'
              }
            }
          }
        }
      }
    }
  }
})
