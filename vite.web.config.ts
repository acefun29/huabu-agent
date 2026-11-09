/**
 * 纯前端 mock 预览的 Vite 配置（不启动主进程，不参与 Electron 打包）。
 *
 * 用途：`pnpm web:mock` 起一个只有 renderer 的浏览器版本，配合
 * src/renderer/src/webHarness.ts 的内存态 window.huabu——只用于**纯 UI 样式调试**，
 * 数据是内置 demo（刷新即重置）。
 *
 * 要连真后端（真实对话/模型/素材库），用 `pnpm web`：electron-vite 起同一个
 * renderer dev server + 主进程 headless 模式（不建窗口），并自动打开浏览器。
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
