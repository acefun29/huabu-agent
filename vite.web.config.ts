/**
 * Web 预览专用 Vite 配置（仅前端交互调试用，不参与 Electron 打包）。
 *
 * 用途：`pnpm web:dev` 起一个纯浏览器版本的 renderer，配合 src/renderer/src/webHarness.ts
 * 的内存态 window.huabu——项目结构视图等前端交互可以在浏览器里直接改、直接看。
 *
 * 与 electron.vite.config.ts 的 renderer 段保持同一套 alias 与插件，避免样式/路径漂移。
 */
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
    },
  },
  server: {
    port: 5174,
    open: false,
  },
})
